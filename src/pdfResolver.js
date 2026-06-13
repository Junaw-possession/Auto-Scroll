const fs = require('fs');
const path = require('path');

const ROOT_DIRECTIVE = /^\s*%\s*!\s*TEX\s+root\s*=\s*(.+?)\s*$/im;

function readRootDirective(texPath) {
  try {
    const source = fs.readFileSync(texPath, 'utf8');
    const match = ROOT_DIRECTIVE.exec(source);
    if (!match) {
      return texPath;
    }
    const root = match[1].trim().replace(/^["']|["']$/g, '');
    return path.resolve(path.dirname(texPath), root);
  } catch {
    return texPath;
  }
}

function expandOutDir(template, texPath) {
  const directory = path.dirname(texPath);
  const documentName = path.basename(texPath, path.extname(texPath));
  return path.normalize(template
    .replaceAll('%DIR%', directory)
    .replaceAll('%DOC%', documentName)
    .replaceAll('%WORKSPACE_FOLDER%', directory));
}

function candidatePdfPaths(texPath, outDirTemplate) {
  const rootTex = readRootDirective(texPath);
  const directory = path.dirname(rootTex);
  const stem = path.basename(rootTex, path.extname(rootTex));
  const candidates = [path.join(directory, `${stem}.pdf`)];

  if (outDirTemplate) {
    const expanded = expandOutDir(outDirTemplate, rootTex);
    const outputDirectory = path.isAbsolute(expanded)
      ? expanded
      : path.resolve(directory, expanded);
    candidates.unshift(path.join(outputDirectory, `${stem}.pdf`));
  }

  return [...new Set(candidates.map((candidate) => path.normalize(candidate)))];
}

function firstExistingFile(paths) {
  return paths.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

module.exports = {
  candidatePdfPaths,
  expandOutDir,
  firstExistingFile,
  readRootDirective
};
