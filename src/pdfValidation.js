const fs = require('fs');
const path = require('path');

class PdfValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

async function validatePdfFile(pdfPath) {
  if (path.extname(pdfPath).toLowerCase() !== '.pdf') {
    throw new PdfValidationError('NOT_PDF', 'The selected file is not a PDF.');
  }

  let handle;
  try {
    handle = await fs.promises.open(pdfPath, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new PdfValidationError('NOT_FILE', 'The PDF path is not a file.');
    }
    if (stat.size < 5) {
      throw new PdfValidationError('INVALID_PDF', 'The PDF file is empty or incomplete.');
    }

    const header = Buffer.alloc(5);
    await handle.read(header, 0, header.length, 0);
    if (header.toString('ascii') !== '%PDF-') {
      throw new PdfValidationError('INVALID_PDF', 'The file does not have a valid PDF header.');
    }
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (error) {
    if (error instanceof PdfValidationError) {
      throw error;
    }
    if (error?.code === 'ENOENT') {
      throw new PdfValidationError('FILE_MISSING', 'The PDF file does not exist.');
    }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      throw new PdfValidationError('ACCESS_DENIED', 'The PDF file cannot be read.');
    }
    throw new PdfValidationError('READ_FAILED', error?.message || String(error));
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function validatePdfFileWithRetry(
  pdfPath,
  { attempts = 4, delayMs = 250 } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await validatePdfFile(pdfPath);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

module.exports = {
  PdfValidationError,
  validatePdfFile,
  validatePdfFileWithRetry
};
