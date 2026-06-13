const path = require('path');
const vscode = require('vscode');
const {
  candidatePdfPaths,
  firstExistingFile
} = require('./pdfResolver');
const {
  validatePdfFile,
  validatePdfFileWithRetry
} = require('./pdfValidation');
const { reverseSearch } = require('./synctex');

const VIEW_TYPE = 'latex-auto-scroll-reader.reader';
const readers = new Set();
const startWhenOpened = new Set();
let activeReader;
let output;

function log(message, error) {
  const suffix = error ? `\n${error.stack || error.message || String(error)}` : '';
  output?.appendLine(`[${new Date().toISOString()}] ${message}${suffix}`);
}

function configuration() {
  const config = vscode.workspace.getConfiguration('latexAutoScroll');
  let minimumSpeed = config.get('minimumSpeed', 5);
  let maximumSpeed = config.get('maximumSpeed', 200);
  if (minimumSpeed >= maximumSpeed) {
    minimumSpeed = 5;
    maximumSpeed = 200;
  }
  return {
    defaultSpeed: clamp(config.get('defaultSpeed', 30), minimumSpeed, maximumSpeed),
    minimumSpeed,
    maximumSpeed,
    rememberReadingPosition: config.get('rememberReadingPosition', true),
    pauseOnMouseMove: config.get('pauseOnMouseMove', true)
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function uriKey(uri) {
  return uri.fsPath.toLowerCase();
}

function pdfUriFromArgument(argument) {
  if (argument instanceof vscode.Uri) return argument;
  if (argument?.uri instanceof vscode.Uri) return argument.uri;
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input?.uri instanceof vscode.Uri ? input.uri : undefined;
}

async function resolvePdfUri(argument) {
  const supplied = pdfUriFromArgument(argument);
  if (
    supplied?.scheme === 'file' &&
    path.extname(supplied.fsPath).toLowerCase() === '.pdf'
  ) {
    return supplied;
  }

  const editor = vscode.window.activeTextEditor;
  if (editor?.document.uri.scheme === 'file') {
    const sourcePath = editor.document.uri.fsPath;
    if (path.extname(sourcePath).toLowerCase() === '.pdf') {
      return editor.document.uri;
    }
    if (path.extname(sourcePath).toLowerCase() === '.tex') {
      const latexConfig = vscode.workspace.getConfiguration('latex-workshop');
      const outDir = latexConfig.get('latex.outDir', '%DIR%');
      const existing = firstExistingFile(candidatePdfPaths(sourcePath, outDir));
      if (existing) return vscode.Uri.file(existing);
    }
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectMany: false,
    filters: { PDF: ['pdf'] },
    openLabel: 'Open with Auto Scroll Reader'
  });
  return selected?.[0];
}

function findReader(uri) {
  const key = uriKey(uri);
  return [...readers].find((reader) => uriKey(reader.uri) === key);
}

async function openReader(argument, startImmediately = false) {
  const uri = await resolvePdfUri(argument);
  if (!uri) {
    vscode.window.showWarningMessage('No PDF file was found.');
    return;
  }

  const existing = findReader(uri);
  if (existing) {
    existing.panel.reveal(existing.panel.viewColumn, false);
    activeReader = existing;
    if (startImmediately) existing.send('start');
    return;
  }

  if (startImmediately) startWhenOpened.add(uriKey(uri));
  log(`Opening custom editor: ${uri.fsPath}`);
  await vscode.commands.executeCommand(
    'vscode.openWith',
    uri,
    VIEW_TYPE,
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false, preview: false }
  );
}

class ReaderPanel {
  constructor(context, document, panel) {
    this.context = context;
    this.document = document;
    this.uri = document.uri;
    this.pdfPath = document.uri.fsPath;
    this.panel = panel;
    this.disposables = [];
    this.reloadTimer = undefined;
    this.startWhenReady = startWhenOpened.delete(uriKey(this.uri));

    const mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    const pdfRoot = vscode.Uri.file(path.dirname(this.pdfPath));
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, pdfRoot]
    };
    panel.title = `Auto Scroll: ${path.basename(this.pdfPath)}`;
    panel.onDidChangeViewState(
      (event) => {
        if (event.webviewPanel.active) activeReader = this;
      },
      null,
      this.disposables
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage(
      (message) => this.handleMessage(message),
      null,
      this.disposables
    );
    readers.add(this);
    activeReader = this;
  }

  async initialize() {
    log(`Resolving webview: ${this.pdfPath}`);
    if (this.document.validationError) {
      this.showDocumentError(this.document.validationError);
      return;
    }
    this.panel.webview.html = this.readerHtml();
    this.watchPdf();
  }

  stateKey() {
    return `readerState:${this.pdfPath.toLowerCase()}`;
  }

  initialState() {
    const config = configuration();
    const remembered = config.rememberReadingPosition
      ? this.context.globalState.get(this.stateKey(), {})
      : {};
    return {
      speed: clamp(
        remembered.speed ?? config.defaultSpeed,
        config.minimumSpeed,
        config.maximumSpeed
      ),
      zoom: clamp(remembered.zoom ?? 1.25, 0.5, 3),
      ratio: clamp(remembered.ratio ?? 0, 0, 1),
      running: Boolean(remembered.running)
    };
  }

  pdfUri(version) {
    const uri = this.panel.webview.asWebviewUri(this.uri).toString();
    return version ? `${uri}?v=${version}` : uri;
  }

  mediaUri(name) {
    return this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name))
      .toString();
  }

  csp(nonce) {
    return [
      "default-src 'none'",
      `img-src ${this.panel.webview.cspSource} data:`,
      `style-src ${this.panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' ${this.panel.webview.cspSource}`,
      `worker-src ${this.panel.webview.cspSource} blob:`,
      `connect-src ${this.panel.webview.cspSource}`
    ].join('; ');
  }

  readerHtml() {
    const nonce = randomNonce();
    const config = configuration();
    const bootstrap = {
      pdfUrl: this.pdfUri(),
      pdfName: path.basename(this.pdfPath),
      state: this.initialState(),
      config
    };
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${this.csp(nonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${this.mediaUri('reader.css')}">
  <title>PDF Auto Scroll Reader</title>
</head>
<body>
  <header id="toolbar">
    <button id="toggle" type="button" title="Start or pause">Start</button>
    <label class="speed-control">
      <span>Speed</span>
      <input id="speed" type="range" min="${config.minimumSpeed}" max="${config.maximumSpeed}" step="1">
      <output id="speedValue"></output>
    </label>
    <button id="zoomOut" type="button" title="Zoom out">-</button>
    <output id="zoomValue">125%</output>
    <button id="zoomIn" type="button" title="Zoom in">+</button>
    <span id="status">Loading ${escapeHtml(path.basename(this.pdfPath))}...</span>
  </header>
  <main id="scroller" tabindex="0" aria-label="PDF auto scroll reader">
    <div id="document"></div>
    <div id="message" hidden>
      <p id="messageText"></p>
      <div class="error-actions">
        <button id="retry" type="button">Retry</button>
        <button id="openNormal" type="button">Open normal preview</button>
      </div>
    </div>
  </main>
  <script nonce="${nonce}">window.READER_BOOTSTRAP = ${safeJson(bootstrap)};</script>
  <script nonce="${nonce}" type="module" src="${this.mediaUri('reader.mjs')}"></script>
</body>
</html>`;
  }

  errorHtml(error) {
    const nonce = randomNonce();
    const message = documentErrorMessage(error);
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${this.csp(nonce)}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { padding: 28px; color: var(--vscode-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); }
    .card { max-width: 680px; padding: 20px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    button { margin-right: 8px; padding: 7px 12px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; cursor: pointer; }
    code { word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h2>Unable to restore PDF reader</h2>
    <p>${escapeHtml(message)}</p>
    <p><code>${escapeHtml(this.pdfPath)}</code></p>
    <button id="retry">Retry</button>
    <button id="openNormal">Open normal preview</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelector('#retry').addEventListener('click', () => vscode.postMessage({ type: 'retryDocument' }));
    document.querySelector('#openNormal').addEventListener('click', () => vscode.postMessage({ type: 'openNormal' }));
  </script>
</body>
</html>`;
  }

  showDocumentError(error) {
    log(`Document validation failed: ${this.pdfPath}`, error);
    this.panel.webview.html = this.errorHtml(error);
  }

  watchPdf() {
    if (this.watcher) return;
    const pattern = new vscode.RelativePattern(
      path.dirname(this.pdfPath),
      path.basename(this.pdfPath)
    );
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const schedule = () => {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = setTimeout(async () => {
        try {
          await validatePdfFileWithRetry(this.pdfPath);
          const version = Date.now();
          log(`Reloading changed PDF: ${this.pdfPath}`);
          this.panel.webview.postMessage({
            type: 'reload',
            pdfUrl: this.pdfUri(version),
            version
          });
        } catch (error) {
          log(`PDF change detected but file is not ready: ${this.pdfPath}`, error);
        }
      }, 750);
    };
    this.watcher.onDidChange(schedule, null, this.disposables);
    this.watcher.onDidCreate(schedule, null, this.disposables);
    this.disposables.push(this.watcher);
  }

  async retryDocument() {
    try {
      await validatePdfFile(this.pdfPath);
      this.document.validationError = undefined;
      this.panel.webview.html = this.readerHtml();
      this.watchPdf();
      log(`Document retry succeeded: ${this.pdfPath}`);
    } catch (error) {
      this.document.validationError = error;
      this.showDocumentError(error);
    }
  }

  async openNormalPreview() {
    log(`Switching to normal PDF preview: ${this.pdfPath}`);
    try {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        this.uri,
        'latex-workshop-pdf-hook',
        { viewColumn: this.panel.viewColumn, preserveFocus: false, preview: false }
      );
    } catch (error) {
      log('LaTeX Workshop preview was unavailable; opening the default editor', error);
      await vscode.commands.executeCommand(
        'vscode.openWith',
        this.uri,
        'default',
        { viewColumn: this.panel.viewColumn, preserveFocus: false, preview: false }
      );
    }
  }

  async handleMessage(message) {
    if (message.type === 'ready') {
      log(`Webview ready: ${this.pdfPath}`);
      if (this.startWhenReady) {
        this.startWhenReady = false;
        this.send('start');
      }
    }
    if (message.type === 'focus') activeReader = this;
    if (message.type === 'state' && configuration().rememberReadingPosition) {
      await this.context.globalState.update(this.stateKey(), {
        speed: message.speed,
        zoom: message.zoom,
        ratio: message.ratio,
        running: Boolean(message.running)
      });
    }
    if (message.type === 'loadError') {
      log(`PDF.js load failed: ${this.pdfPath}: ${message.message}`);
    }
    if (message.type === 'retryDocument') await this.retryDocument();
    if (message.type === 'openNormal') await this.openNormalPreview();
    if (message.type === 'reverseSearch') await this.openSourceAt(message);
  }

  async openSourceAt(message) {
    try {
      const result = await reverseSearch(
        this.pdfPath,
        Number(message.page),
        Number(message.x),
        Number(message.y)
      );
      const document = await vscode.workspace.openTextDocument(
        vscode.Uri.file(result.input)
      );
      const position = new vscode.Position(result.line, result.column);
      const editor = await vscode.window.showTextDocument(document, {
        viewColumn: vscode.ViewColumn.One,
        preserveFocus: false,
        preview: false,
        selection: new vscode.Range(position, position)
      });
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenterIfOutsideViewport
      );
      this.send('reverseSearchResult', {
        message: `${path.basename(result.input)}:${result.line + 1}`
      });
    } catch (error) {
      const messages = {
        SYNCTEX_MISSING: 'This PDF has no SyncTeX data.',
        SOURCE_MISSING: 'The source file referenced by SyncTeX no longer exists.',
        COMMAND_NOT_FOUND: 'The synctex command was not found.',
        NO_MATCH: 'No source location was found for this point.'
      };
      this.send('readerNotice', {
        message: messages[error?.code] || `Reverse search failed: ${error?.message || error}`
      });
      log(`Reverse search failed: ${this.pdfPath}`, error);
    }
  }

  send(type, data = {}) {
    this.panel.webview.postMessage({ type, ...data });
  }

  dispose() {
    clearTimeout(this.reloadTimer);
    readers.delete(this);
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
    if (activeReader === this) {
      activeReader = [...readers].find((reader) => reader.panel.active);
    }
    log(`Disposed reader: ${this.pdfPath}`);
  }
}

class ReaderProvider {
  constructor(context) {
    this.context = context;
  }

  async openCustomDocument(uri, _openContext, token) {
    const document = { uri, validationError: undefined, dispose() {} };
    log(`Opening custom document: ${uri.toString()}`);
    if (token.isCancellationRequested) return document;
    if (uri.scheme !== 'file') {
      document.validationError = Object.assign(
        new Error('Only local PDF files are supported.'),
        { code: 'UNSUPPORTED_SCHEME' }
      );
      return document;
    }
    try {
      await validatePdfFile(uri.fsPath);
    } catch (error) {
      document.validationError = error;
    }
    return document;
  }

  async resolveCustomEditor(document, webviewPanel, token) {
    let reader;
    try {
      reader = new ReaderPanel(this.context, document, webviewPanel);
      if (token.isCancellationRequested) return;
      await reader.initialize();
    } catch (error) {
      log(`Unexpected custom editor restore failure: ${document.uri.toString()}`, error);
      if (reader) {
        reader.showDocumentError(error);
      } else {
        const fallback = new ReaderPanel(this.context, document, webviewPanel);
        fallback.showDocumentError(error);
      }
    }
  }
}

function sendToActive(type) {
  const reader =
    activeReader?.panel.active
      ? activeReader
      : [...readers].find((candidate) => candidate.panel.active) || activeReader;
  if (reader) reader.send(type);
  else openReader(undefined, type === 'toggle');
}

function activate(context) {
  output = vscode.window.createOutputChannel('PDF Auto Scroll Reader');
  context.subscriptions.push(output);
  log(`Activating extension ${context.extension.packageJSON.version}`);

  const provider = new ReaderProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      supportsMultipleEditorsPerDocument: true,
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('latexAutoScroll.open', (uri) =>
      openReader(uri, false)
    ),
    vscode.commands.registerCommand('latexAutoScroll.openAndStart', (uri) =>
      openReader(uri, true)
    ),
    vscode.commands.registerCommand('latexAutoScroll.toggle', () =>
      sendToActive('toggle')
    ),
    vscode.commands.registerCommand('latexAutoScroll.faster', () =>
      sendToActive('faster')
    ),
    vscode.commands.registerCommand('latexAutoScroll.slower', () =>
      sendToActive('slower')
    )
  );
  log('Custom editor provider registered');
}

function documentErrorMessage(error) {
  const messages = {
    FILE_MISSING: 'The PDF file no longer exists.',
    ACCESS_DENIED: 'The PDF file cannot be read because access was denied.',
    INVALID_PDF: 'The file is incomplete or does not contain a valid PDF header.',
    NOT_PDF: 'The selected file is not a PDF.',
    NOT_FILE: 'The selected path is not a file.',
    UNSUPPORTED_SCHEME: 'Only local PDF files are supported.'
  };
  return messages[error?.code] || error?.message || String(error);
}

function randomNonce() {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () =>
    alphabet.charAt(Math.floor(Math.random() * alphabet.length))
  ).join('');
}

function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function deactivate() {
  for (const reader of [...readers]) reader.dispose();
  log('Extension deactivated');
}

module.exports = { activate, deactivate };
