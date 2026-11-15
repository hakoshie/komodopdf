import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

// Surgical regex edits keep each file's original formatting and line endings,
// touching only the version line.

// src-tauri/tauri.conf.json -> top-level "version": "x.y.z"
const confPath = join(root, 'src-tauri', 'tauri.conf.json');
const conf = readFileSync(confPath, 'utf8')
  .replace(/("version":\s*)"[^"]*"/, `$1"${version}"`);
writeFileSync(confPath, conf);

// src-tauri/Cargo.toml -> [package] version is the first top-of-line version = "..."
const cargoPath = join(root, 'src-tauri', 'Cargo.toml');
const cargo = readFileSync(cargoPath, 'utf8')
  .replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync(cargoPath, cargo);

const lockPath = join(root, 'src-tauri', 'Cargo.lock');
const lock = readFileSync(lockPath, 'utf8');
if (!/name = "komodo-pdf"\r?\nversion = "[^"]+"/.test(lock)) {
  throw new Error('komodo-pdf package missing from Cargo.lock');
}
writeFileSync(lockPath, lock.replace(/(name = "komodo-pdf"\r?\nversion = )"[^"]+"/, `$1"${version}"`));

console.log(`Synced version ${version} -> tauri.conf.json, Cargo.toml, Cargo.lock (stage all three before tagging)`);
