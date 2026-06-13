const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  decodeSyncTeXOutput,
  normalizeSourcePath,
  parseSyncTeXOutput
} = require('../src/synctex');

test('parses a SyncTeX reverse-search result', () => {
  const pdf = path.join('C:', 'paper', 'main.pdf');
  const output = [
    'SyncTeX result begin',
    'Output:C:/paper/main.pdf',
    'Input:C:/paper/chapters/one.tex',
    'Line:42',
    'Column:-1',
    'SyncTeX result end'
  ].join('\n');

  assert.deepEqual(parseSyncTeXOutput(output, pdf), {
    input: path.normalize('C:/paper/chapters/one.tex'),
    line: 41,
    column: 0
  });
});

test('returns undefined when SyncTeX has no source match', () => {
  assert.equal(
    parseSyncTeXOutput('SyncTeX result begin\nSyncTeX result end', 'main.pdf'),
    undefined
  );
});

test('decodes Windows SyncTeX output as GBK', () => {
  const bytes = Buffer.from('b9abd6dabac52f4354cfb5c1d0', 'hex');
  assert.equal(decodeSyncTeXOutput(bytes, 'win32'), '公众号/CT系列');
});

test('normalizes percent-encoded file URIs', () => {
  const result = normalizeSourcePath(
    'file:///D%3A/%E5%85%AC%E4%BC%97%E5%8F%B7/document.tex',
    'D:\\公众号\\document.pdf'
  );
  assert.equal(result, path.normalize('D:\\公众号\\document.tex'));
});

test('normalizes a Chinese Windows filesystem path', () => {
  const result = normalizeSourcePath(
    'D:/公众号/CT系列/document.tex',
    'D:\\公众号\\CT系列\\document.pdf'
  );
  assert.equal(result, path.normalize('D:\\公众号\\CT系列\\document.tex'));
});
