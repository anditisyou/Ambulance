'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = process.cwd();
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'coverage',
]);

const INCLUDE_DIRS = [
  'controllers',
  'middleware',
  'models',
  'routes',
  'utils',
  'public/js',
  'tests',
];

const includeRootFiles = [
  'index.js',
  'server.js',
];

const filesToCheck = [];

const walk = (dir) => {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name)) {
        walk(fullPath);
      }
      continue;
    }

    if (entry.isFile() && fullPath.endsWith('.js')) {
      filesToCheck.push(fullPath);
    }
  }
};

for (const relDir of INCLUDE_DIRS) {
  walk(path.join(ROOT, relDir));
}

for (const relFile of includeRootFiles) {
  const fullFile = path.join(ROOT, relFile);
  if (fs.existsSync(fullFile)) filesToCheck.push(fullFile);
}

let hasError = false;
for (const filePath of filesToCheck) {
  try {
    const source = fs.readFileSync(filePath, 'utf8');
    new vm.Script(source, { filename: filePath });
  } catch (error) {
    hasError = true;
    process.stderr.write(`Syntax error in ${path.relative(ROOT, filePath)}\n`);
    process.stderr.write(`${error.message}\n`);
  }
}

if (hasError) {
  process.exit(1);
}

process.stdout.write(`Lint OK: ${filesToCheck.length} JavaScript files syntax-checked.\n`);
