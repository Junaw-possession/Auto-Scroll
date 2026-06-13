const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

class SyncTeXError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function decodeSyncTeXOutput(buffer, platform = process.platform) {
  const encoding = platform === 'win32' ? 'gbk' : 'utf-8';
  return new TextDecoder(encoding).decode(buffer);
}

function normalizeSourcePath(value, pdfPath) {
  let decoded = value.trim();
  if (/^file:/i.test(decoded)) {
    decoded = fileURLToPath(decoded);
  } else {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // SyncTeX normally returns a plain filesystem path.
    }
  }

  const resolved = path.isAbsolute(decoded)
    ? decoded
    : path.resolve(path.dirname(pdfPath), decoded);
  return path.normalize(resolved);
}

function parseSyncTeXOutput(output, pdfPath) {
  const values = {};
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    values[line.slice(0, separator)] = line.slice(separator + 1);
  }

  if (!values.Input || !values.Line) {
    return undefined;
  }

  const line = Math.max(0, Number.parseInt(values.Line, 10) - 1);
  const parsedColumn = Number.parseInt(values.Column, 10);
  const column = Number.isFinite(parsedColumn) && parsedColumn >= 0
    ? parsedColumn
    : 0;

  return {
    input: normalizeSourcePath(values.Input, pdfPath),
    line,
    column
  };
}

function hasSyncTeXFile(pdfPath) {
  const stem = pdfPath.replace(/\.pdf$/i, '');
  return fs.existsSync(`${stem}.synctex.gz`) || fs.existsSync(`${stem}.synctex`);
}

function runSyncTeX(args, options) {
  return new Promise((resolve, reject) => {
    execFile('synctex', args, { ...options, encoding: null }, (error, stdout) => {
      if (error) {
        if (error.code === 'ENOENT') {
          reject(new SyncTeXError('COMMAND_NOT_FOUND', 'synctex command not found'));
          return;
        }
        reject(error);
        return;
      }
      resolve(decodeSyncTeXOutput(stdout));
    });
  });
}

async function reverseSearch(pdfPath, page, x, y) {
  if (!hasSyncTeXFile(pdfPath)) {
    throw new SyncTeXError('SYNCTEX_MISSING', 'SyncTeX data is missing');
  }

  const query = `${page}:${x.toFixed(3)}:${y.toFixed(3)}:${pdfPath}`;
  const stdout = await runSyncTeX(['edit', '-o', query], {
    cwd: path.dirname(pdfPath),
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  const result = parseSyncTeXOutput(stdout, pdfPath);
  if (!result) {
    throw new SyncTeXError('NO_MATCH', 'SyncTeX did not return a source match');
  }
  if (!fs.existsSync(result.input)) {
    throw new SyncTeXError('SOURCE_MISSING', result.input);
  }
  return result;
}

module.exports = {
  SyncTeXError,
  decodeSyncTeXOutput,
  hasSyncTeXFile,
  normalizeSourcePath,
  parseSyncTeXOutput,
  reverseSearch
};
