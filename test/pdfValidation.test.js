const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  validatePdfFile,
  validatePdfFileWithRetry
} = require('../src/pdfValidation');

function temporaryPath(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-reader-'));
  return path.join(directory, name);
}

test('accepts a file with a PDF header', async () => {
  const pdf = temporaryPath('valid file.pdf');
  fs.writeFileSync(pdf, '%PDF-1.7\ncontent');
  const result = await validatePdfFile(pdf);
  assert.ok(result.size > 5);
});

test('rejects a missing PDF', async () => {
  const pdf = temporaryPath('missing.pdf');
  await assert.rejects(validatePdfFile(pdf), { code: 'FILE_MISSING' });
});

test('retries while a PDF is being replaced', async () => {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), 'pdf-reader-')
  );
  const pdfPath = path.join(directory, 'replaced.pdf');
  await fs.promises.writeFile(pdfPath, Buffer.from('pending'));
  setTimeout(() => {
    fs.promises
      .writeFile(pdfPath, Buffer.from('%PDF-1.7\nready'))
      .catch(() => {});
  }, 30);

  const result = await validatePdfFileWithRetry(pdfPath, {
    attempts: 5,
    delayMs: 20
  });
  assert.equal(result.size, 14);
});

test('rejects a non-PDF file', async () => {
  const pdf = temporaryPath('invalid.pdf');
  fs.writeFileSync(pdf, 'not a pdf');
  await assert.rejects(validatePdfFile(pdf), { code: 'INVALID_PDF' });
});

test('rejects a non-PDF extension', async () => {
  const file = temporaryPath('document.txt');
  fs.writeFileSync(file, '%PDF-1.7');
  await assert.rejects(validatePdfFile(file), { code: 'NOT_PDF' });
});
