// Shared credential loader. Keys live in one .env file (default D:/Environment/.env).
// Values are never logged; errors redact them.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ENV_FILE = 'D:/Environment/.env';

// Parse .env content: BOM-tolerant, `export` prefix, surrounding quotes,
// trailing comments. Does not evaluate expressions or substitute variables.
function parseEnvFile(content) {
  const vars = {};
  for (const rawLine of String(content).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([^\s=#]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2];
    const quoted = value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    if (quoted) value = quoted[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    vars[m[1]] = value;
  }
  return vars;
}

function fromEnvFile(filePath, label, candidates) {
  const vars = parseEnvFile(fs.readFileSync(path.resolve(filePath), 'utf8'));
  for (const name of candidates) {
    const value = vars[name];
    if (value && value.trim() && !/\s/.test(value.trim())) {
      return { key: value.trim(), source: `${label} → ${name}` };
    }
  }
  throw new Error(`None of [${candidates.join(', ')}] found (or values contain spaces) in ${filePath}.`);
}

function fromStdin(candidatesLabel) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      const key = Buffer.concat(chunks).toString('utf8').trim();
      if (!key || /\s/.test(key)) reject(new Error('Key from stdin is empty or contains whitespace.'));
      else resolve({ key, source: 'stdin' });
    });
    process.stdin.on('error', () => reject(new Error(`Failed to read key from stdin (expected: ${candidatesLabel}).`)));
  });
}

// Resolution order: --key-stdin > --env-file > default file (if present) > process env.
// candidates: ordered variable names, first hit wins.
async function readKey(options, candidates) {
  const names = candidates.join(', ');
  if (options['key-stdin']) return fromStdin(names);
  if (options['env-file']) return fromEnvFile(options['env-file'], '--env-file', candidates);
  if (fs.existsSync(DEFAULT_ENV_FILE)) {
    try {
      return fromEnvFile(DEFAULT_ENV_FILE, DEFAULT_ENV_FILE, candidates);
    } catch {
      // fall through to process env
    }
  }
  for (const name of candidates) {
    const value = process.env[name];
    if (value && value.trim() && !/\s/.test(value.trim())) {
      return { key: value.trim(), source: `process env ${name}` };
    }
  }
  throw new Error(`Missing key. Expected ${names} in ${DEFAULT_ENV_FILE} (or --env-file / --key-stdin).`);
}

module.exports = { DEFAULT_ENV_FILE, parseEnvFile, readKey };
