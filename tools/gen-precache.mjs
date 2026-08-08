#!/usr/bin/env node
/**
 * gen-precache.mjs — rewrite the PRECACHE list in sw.js from the file tree.
 *
 * No build step means no bundler to enumerate the module graph for us, and a
 * hand-maintained list drifts the moment someone adds a file. Run this after
 * adding any asset or module:  node tools/gen-precache.mjs
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const INCLUDE_DIRS = ['src', 'assets'];
const ROOT_FILES = ['index.html', 'manifest.webmanifest'];
const EXT = new Set(['.js', '.css', '.png', '.webp', '.svg', '.woff2', '.json', '.ogg', '.mp3', '.wav']);
const SKIP = new Set(['node_modules', '.git', 'tools', 'test', 'dist']);

async function walk(dir, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else {
      const dot = e.name.lastIndexOf('.');
      const ext = dot >= 0 ? e.name.slice(dot) : '';
      if (EXT.has(ext)) out.push('./' + relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

const files = [];
for (const d of INCLUDE_DIRS) await walk(join(ROOT, d), files);
for (const f of ROOT_FILES) {
  try {
    await stat(join(ROOT, f));
    files.push('./' + f);
  } catch {}
}
files.sort();

const list = ['./', ...files];
const block =
  '/* ---- PRECACHE:BEGIN (generated — do not edit by hand) ---- */\n' +
  'const PRECACHE = [\n' +
  list.map((f) => `  '${f}',`).join('\n') +
  '\n];\n' +
  '/* ---- PRECACHE:END ---- */';

const swPath = join(ROOT, 'sw.js');
const sw = await readFile(swPath, 'utf8');
const re = /\/\* ---- PRECACHE:BEGIN[\s\S]*?\/\* ---- PRECACHE:END ---- \*\//;
if (!re.test(sw)) {
  console.error('gen-precache: markers not found in sw.js');
  process.exit(1);
}
await writeFile(swPath, sw.replace(re, block), 'utf8');
console.log(`gen-precache: ${list.length} entries written to sw.js`);
