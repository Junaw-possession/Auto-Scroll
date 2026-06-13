const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  candidatePdfPaths,
  expandOutDir,
  firstExistingFile,
  readRootDirective
} = require('../src/pdfResolver');

test('expands LaTeX Workshop output directory placeholders', () => {
  const texPath = path.join('C:', 'paper', 'main.tex');
  const result = expandOutDir('%DIR%/build/%DOC%', texPath);
  assert.equal(result, path.join('C:', 'paper', 'build', 'main'));
});

test('resolves a TEX root directive relative to the child file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-reader-'));
  const chapterDirectory = path.join(directory, 'chapters');
  fs.mkdirSync(chapterDirectory);
  const root = path.join(directory, 'main.tex');
  const child = path.join(chapterDirectory, 'one.tex');
  fs.writeFileSync(root, '\\documentclass{article}');
  fs.writeFileSync(child, '% !TEX root = ../main.tex\nChapter');

  assert.equal(readRootDirective(child), root);
  assert.equal(
    candidatePdfPaths(child, '%DIR%/build')[0],
    path.join(directory, 'build', 'main.pdf')
  );
});

test('returns the first existing regular file', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'latex-reader-'));
  const missing = path.join(directory, 'missing.pdf');
  const existing = path.join(directory, 'main.pdf');
  fs.writeFileSync(existing, 'pdf');
  assert.equal(firstExistingFile([missing, existing]), existing);
});
