import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const version = JSON.parse(read('package.json')).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
const versions = {
  'package-lock.json': JSON.parse(read('package-lock.json')).packages[''].version,
  'tauri.conf.json': JSON.parse(read('src-tauri/tauri.conf.json')).version,
  'Cargo.toml': read('src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1],
  'Cargo.lock': read('src-tauri/Cargo.lock').match(/name = "komodo-pdf"\r?\nversion = "([^"]+)"/)?.[1],
};
for (const [file, actual] of Object.entries(versions)) {
  if (actual !== version) throw new Error(`${file}: ${actual} does not match ${version}`);
}
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`Tag ${process.env.GITHUB_REF_NAME} does not match v${version}`);
}
console.log(`Release versions match: ${version}`);
