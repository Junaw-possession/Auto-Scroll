import * as pdfjsLib from './pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  './pdf.worker.min.mjs',
  import.meta.url
).toString();

const vscode = acquireVsCodeApi();
const bootstrap = window.READER_BOOTSTRAP;
const elements = {
  toggle: document.querySelector('#toggle'),
  speed: document.querySelector('#speed'),
  speedValue: document.querySelector('#speedValue'),
  zoomOut: document.querySelector('#zoomOut'),
  zoomIn: document.querySelector('#zoomIn'),
  zoomValue: document.querySelector('#zoomValue'),
  loadProgress: document.querySelector('#loadProgress'),
  stageName: document.querySelector('#stageName'),
  status: document.querySelector('#status'),
  scroller: document.querySelector('#scroller'),
  document: document.querySelector('#document'),
  message: document.querySelector('#message'),
  messageText: document.querySelector('#messageText'),
  retry: document.querySelector('#retry'),
  openNormal: document.querySelector('#openNormal')
};

let pdfDocument;
let loadingTask;
let pageEntries = [];
let observer;
let running = false;
let frameId;
let lastFrameTime;
let lastManualResume = 0;
let renderGeneration = 0;
let persistTimer;
let currentPdfUrl = bootstrap.pdfUrl;
let speed = bootstrap.state.speed;
let zoom = bootstrap.state.zoom;
let requestedRatio = bootstrap.state.ratio;
let resumeAfterLoad = Boolean(bootstrap.state.running);
let automaticRetryUsed = false;
let stageAnimationId;
let currentStage;
let currentPercent = 0;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value)));
}

function cacheBust(url) {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}v=${Date.now()}`;
}

function scrollRatio() {
  const maximum = elements.scroller.scrollHeight - elements.scroller.clientHeight;
  return maximum > 0 ? elements.scroller.scrollTop / maximum : 0;
}

function currentState() {
  return { speed, zoom, ratio: scrollRatio(), running };
}

function persistNow() {
  clearTimeout(persistTimer);
  const state = currentState();
  vscode.setState(state);
  vscode.postMessage({ type: 'state', ...state });
}

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistNow, 250);
}

function updateControls() {
  elements.toggle.textContent = running ? 'Pause' : 'Start';
  elements.toggle.setAttribute('aria-pressed', String(running));
  elements.speed.value = String(speed);
  elements.speedValue.textContent = `${Math.round(speed)} px/s`;
  elements.zoomValue.textContent = `${Math.round(zoom * 100)}%`;
}

function stopAnimation(reason, persist = true) {
  if (running) {
    running = false;
    cancelAnimationFrame(frameId);
    lastFrameTime = undefined;
    updateControls();
  }
  if (reason) elements.status.textContent = reason;
  if (persist) persistSoon();
}

function start() {
  if (running || !pdfDocument) return;
  const maximum = elements.scroller.scrollHeight - elements.scroller.clientHeight;
  if (elements.scroller.scrollTop >= maximum - 1) {
    elements.scroller.scrollTop = 0;
  }
  running = true;
  resumeAfterLoad = true;
  lastManualResume = performance.now();
  lastFrameTime = undefined;
  elements.status.textContent = 'Auto scrolling';
  updateControls();
  persistSoon();
  frameId = requestAnimationFrame(tick);
}

function tick(time) {
  if (!running) return;
  if (lastFrameTime !== undefined) {
    const elapsed = Math.min(100, time - lastFrameTime);
    elements.scroller.scrollTop += (speed * elapsed) / 1000;
    const maximum = elements.scroller.scrollHeight - elements.scroller.clientHeight;
    if (elements.scroller.scrollTop >= maximum - 1) {
      elements.scroller.scrollTop = maximum;
      resumeAfterLoad = false;
      stopAnimation('End of document');
      return;
    }
  }
  lastFrameTime = time;
  frameId = requestAnimationFrame(tick);
}

function pause(reason) {
  resumeAfterLoad = false;
  stopAnimation(reason);
}

function toggle() {
  if (running) pause('Paused');
  else start();
}

function setSpeed(value) {
  speed = clamp(
    value,
    bootstrap.config.minimumSpeed,
    bootstrap.config.maximumSpeed
  );
  updateControls();
  persistSoon();
}

async function setZoom(value) {
  const ratio = scrollRatio();
  const shouldResume = running;
  stopAnimation(undefined, false);
  zoom = clamp(value, 0.5, 3);
  updateControls();
  await buildPages(ratio);
  if (shouldResume) start();
  persistSoon();
}

function showReader() {
  elements.document.hidden = false;
  elements.message.hidden = true;
}

function showLoadError(error) {
  const message = error?.message || String(error);
  elements.document.hidden = true;
  elements.message.hidden = false;
  elements.messageText.textContent =
    `Unable to load this PDF.\n\n${message}`;
  elements.status.textContent = 'PDF load failed';
  hideStage();
  vscode.postMessage({ type: 'loadError', message });
}

function renderStage(stageName, value) {
  const percent = Math.floor(clamp(value, 0, 100));
  elements.loadProgress.hidden = false;
  elements.stageName.textContent = stageName;
  elements.loadProgress.querySelector('strong').textContent = `${percent}%`;
  elements.loadProgress.title = `正在运行：${stageName} ${percent}%`;
  elements.status.textContent = elements.loadProgress.title;
}

function stopStageAnimation() {
  if (stageAnimationId) {
    cancelAnimationFrame(stageAnimationId);
    stageAnimationId = undefined;
  }
}

function showStage(stageName, value) {
  currentPercent = Math.max(currentPercent, clamp(value, 0, 100));
  renderStage(stageName, currentPercent);
}

function beginStage(stageName, start, end, { smooth = true } = {}) {
  stopStageAnimation();
  currentStage = { stageName, start, end };
  currentPercent = Math.max(currentPercent, start);
  renderStage(stageName, currentPercent);

  if (!smooth) return;
  const target = Math.max(start, end - 1);
  const initial = currentPercent;
  const startedAt = performance.now();
  const duration = 1200;

  const animate = (time) => {
    if (!currentStage || currentStage.stageName !== stageName) return;
    const elapsedRatio = clamp((time - startedAt) / duration, 0, 1);
    const easedRatio = 1 - (1 - elapsedRatio) ** 2;
    showStage(stageName, initial + (target - initial) * easedRatio);
    if (currentPercent < target) {
      stageAnimationId = requestAnimationFrame(animate);
    } else {
      stageAnimationId = undefined;
    }
  };

  stageAnimationId = requestAnimationFrame(animate);
}

function updateStageProgress(stageName, ratio) {
  if (!currentStage || currentStage.stageName !== stageName) return;
  stopStageAnimation();
  const progress = clamp(ratio, 0, 1);
  showStage(
    stageName,
    currentStage.start + progress * (currentStage.end - currentStage.start)
  );
}

function hideStage(label) {
  stopStageAnimation();
  elements.loadProgress.hidden = true;
  elements.stageName.textContent = '打开阅读器';
  elements.loadProgress.querySelector('strong').textContent = '0%';
  elements.loadProgress.title = '';
  currentStage = undefined;
  currentPercent = 0;
  if (label) elements.status.textContent = label;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function updateLoadProgress(progress) {
  const loaded = Number(progress?.loaded) || 0;
  const total = Number(progress?.total) || 0;
  if (total > 0) {
    const percent = clamp((loaded / total) * 100, 0, 100);
    updateStageProgress('读取PDF', percent / 100);
    elements.status.textContent =
      `Loading ${bootstrap.pdfName}: ${Math.floor(percent)}% ` +
      `(${formatBytes(loaded)} / ${formatBytes(total)})`;
    return;
  }
  elements.status.textContent = `Loading ${bootstrap.pdfName}: ${formatBytes(loaded)}`;
}

async function loadPdf(url, ratio = scrollRatio(), allowAutomaticRetry = true) {
  const shouldResume = resumeAfterLoad || running;
  stopAnimation(undefined, false);
  requestedRatio = clamp(ratio, 0, 1);
  showReader();
  beginStage('读取PDF', 30, 60);
  elements.status.textContent = `Loading ${bootstrap.pdfName}...`;
  const generation = ++renderGeneration;

  observer?.disconnect();
  await loadingTask?.destroy().catch(() => {});
  await pdfDocument?.destroy().catch(() => {});
  loadingTask = undefined;
  pdfDocument = undefined;
  elements.document.replaceChildren();
  pageEntries = [];

  try {
    loadingTask = pdfjsLib.getDocument({ url });
    loadingTask.onProgress = updateLoadProgress;
    pdfDocument = await loadingTask.promise;
    if (generation !== renderGeneration) return false;
    await buildPages(requestedRatio);
    hideStage(`${pdfDocument.numPages} pages`);
    automaticRetryUsed = false;
    if (shouldResume) start();
    return true;
  } catch (error) {
    if (generation !== renderGeneration) return false;
    if (allowAutomaticRetry && !automaticRetryUsed) {
      automaticRetryUsed = true;
      const retryUrl = cacheBust(currentPdfUrl);
      elements.status.textContent = 'Retrying PDF load...';
      return loadPdf(retryUrl, requestedRatio, false);
    }
    showLoadError(error);
    return false;
  }
}

async function buildPages(ratio) {
  if (!pdfDocument) return;
  const generation = ++renderGeneration;
  observer?.disconnect();
  elements.document.replaceChildren();
  pageEntries = [];
  beginStage('准备页面', 60, 100, { smooth: false });
  elements.status.textContent = `Preparing pages: 0 / ${pdfDocument.numPages}`;
  await new Promise((resolve) => requestAnimationFrame(resolve));

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    if (generation !== renderGeneration) return;
    const viewport = page.getViewport({ scale: zoom });
    const holder = document.createElement('section');
    holder.className = 'page';
    holder.style.width = `${viewport.width}px`;
    holder.style.height = `${viewport.height}px`;
    holder.dataset.page = String(pageNumber);

    const label = document.createElement('span');
    label.className = 'page-number';
    label.textContent = String(pageNumber);
    holder.append(label);
    elements.document.append(holder);
    pageEntries.push({ pageNumber, page, viewport, holder, rendering: false });
    updateStageProgress('准备页面', pageNumber / pdfDocument.numPages);
    elements.status.textContent =
      `Preparing pages: ${pageNumber} / ${pdfDocument.numPages}`;
    if (pageNumber % 5 === 0) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }

  observer = new IntersectionObserver(onIntersection, {
    root: elements.scroller,
    rootMargin: '1200px 0px'
  });
  pageEntries.forEach((entry) => observer.observe(entry.holder));
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const maximum = elements.scroller.scrollHeight - elements.scroller.clientHeight;
  elements.scroller.scrollTop = clamp(ratio, 0, 1) * Math.max(0, maximum);
  hideStage(`${pdfDocument.numPages} pages`);
}

function onIntersection(entries) {
  for (const intersection of entries) {
    if (!intersection.isIntersecting) continue;
    const pageNumber = Number(intersection.target.dataset.page);
    renderPage(pageEntries[pageNumber - 1]);
  }
}

async function renderPage(entry) {
  if (!entry || entry.rendering || entry.holder.querySelector('canvas')) return;
  entry.rendering = true;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(entry.viewport.width * outputScale);
  canvas.height = Math.floor(entry.viewport.height * outputScale);
  canvas.style.width = `${entry.viewport.width}px`;
  canvas.style.height = `${entry.viewport.height}px`;
  entry.holder.prepend(canvas);

  try {
    await entry.page.render({
      canvasContext: context,
      viewport: entry.viewport,
      transform:
        outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0]
    }).promise;
  } catch (error) {
    canvas.remove();
    console.error(error);
  } finally {
    entry.rendering = false;
  }
}

elements.toggle.addEventListener('click', toggle);
elements.speed.addEventListener('input', (event) => setSpeed(event.target.value));
elements.zoomOut.addEventListener('click', () => setZoom(zoom - 0.1));
elements.zoomIn.addEventListener('click', () => setZoom(zoom + 0.1));
elements.retry.addEventListener('click', () => {
  automaticRetryUsed = false;
  currentPdfUrl = cacheBust(currentPdfUrl);
  loadPdf(currentPdfUrl, requestedRatio, true);
});
elements.openNormal.addEventListener('click', () => {
  vscode.postMessage({ type: 'openNormal' });
});
elements.scroller.addEventListener('scroll', persistSoon, { passive: true });
elements.scroller.addEventListener(
  'pointermove',
  (event) => {
    if (
      bootstrap.config.pauseOnMouseMove &&
      running &&
      performance.now() - lastManualResume > 500 &&
      (Math.abs(event.movementX) > 0 || Math.abs(event.movementY) > 0)
    ) {
      pause('Paused by mouse movement');
    }
  },
  { passive: true }
);
elements.scroller.addEventListener(
  'wheel',
  () => pause('Paused by manual scroll'),
  { passive: true }
);
elements.document.addEventListener('click', (event) => {
  if (!event.ctrlKey || event.button !== 0) return;
  const holder = event.target.closest('.page');
  if (!holder) return;

  event.preventDefault();
  event.stopPropagation();
  pause('Locating source...');
  const bounds = holder.getBoundingClientRect();
  const pageNumber = Number(holder.dataset.page);
  const entry = pageEntries[pageNumber - 1];
  if (!entry) return;

  const scaleX = entry.viewport.width / bounds.width;
  const scaleY = entry.viewport.height / bounds.height;
  const viewportX = (event.clientX - bounds.left) * scaleX;
  const viewportY = (event.clientY - bounds.top) * scaleY;
  const pdfUnitsPerCssPixel = entry.viewport.scale || zoom;

  vscode.postMessage({
    type: 'reverseSearch',
    page: pageNumber,
    x: viewportX / pdfUnitsPerCssPixel,
    y: viewportY / pdfUnitsPerCssPixel
  });
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'toggle') toggle();
  if (message.type === 'start') start();
  if (message.type === 'faster') setSpeed(speed + 5);
  if (message.type === 'slower') setSpeed(speed - 5);
  if (message.type === 'reverseSearchResult') {
    elements.status.textContent = `Source: ${message.message}`;
  }
  if (message.type === 'readerNotice') {
    elements.status.textContent = message.message;
  }
  if (message.type === 'reload') {
    const shouldResume = running;
    resumeAfterLoad = shouldResume;
    automaticRetryUsed = false;
    currentPdfUrl = message.pdfUrl;
    loadPdf(currentPdfUrl, scrollRatio(), true);
  }
});

window.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && !event.target.matches('input, button')) {
    event.preventDefault();
    toggle();
  }
});
window.addEventListener('focus', () => {
  vscode.postMessage({ type: 'focus' });
});
window.addEventListener('pagehide', persistNow);
document.addEventListener(
  'pointerdown',
  () => vscode.postMessage({ type: 'focus' }),
  { passive: true }
);

const webviewState = vscode.getState();
if (webviewState) {
  speed = webviewState.speed ?? speed;
  zoom = webviewState.zoom ?? zoom;
  requestedRatio = webviewState.ratio ?? requestedRatio;
  resumeAfterLoad = webviewState.running ?? resumeAfterLoad;
}
updateControls();
async function bootstrapReader() {
  beginStage('打开阅读器', 20, 30);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await loadPdf(currentPdfUrl, requestedRatio, true).finally(() => {
    vscode.postMessage({ type: 'ready' });
  });
}
bootstrapReader();
