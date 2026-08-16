#!/usr/bin/env node
/**
 * gen-precache.mjs — rewrite the PRECACHE list in sw.js from the file tree.
 *
 * No build step means no bundler to enumerate the module graph for us, and a
 * hand-maintained list drifts the moment someone adds a file. Run this after
 * adding any asset or module:  node tools/gen-precache.mjs
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

/**
 * A version that changes when the game does.
 *
 * `VERSION` was the constant `'deepwater-v1'` and nothing ever wrote it, so
 * `CACHE` never changed name and the activate handler — which deletes every
 * cache whose key is not the current one — had never deleted anything and
 * never would. Worse, `sw.js` itself only changed when a file was *added or
 * removed*, because the generated list is the only part of it derived from the
 * tree. Edit a module and the worker is byte-identical, so no new worker
 * installs, and the only thing that refreshes anything is the background
 * revalidate in the fetch handler: a returning player gets the previous build
 * on this launch and the current one on the next. Every content-only change —
 * which is most changes — reached them a session late, with nothing on screen
 * saying anything was pending.
 *
 * So the version is a hash of what is actually being cached. Any byte of any
 * precached file moves it, which moves `sw.js`, which installs a new worker,
 * which opens a new cache and sweeps the old one on activate. Content rather
 * than mtime, so a checkout or a no-op regeneration does not invent a new
 * version and re-download the game for everybody.
 */
const digest = createHash('sha1');
for (const f of files) {
  digest.update(f);
  digest.update(await readFile(join(ROOT, f.slice(2))));
}
const version = 'deepwater-' + digest.digest('hex').slice(0, 12);

const swPath = join(ROOT, 'sw.js');
const sw = await readFile(swPath, 'utf8');
const re = /\/\* ---- PRECACHE:BEGIN[\s\S]*?\/\* ---- PRECACHE:END ---- \*\//;
if (!re.test(sw)) {
  console.error('gen-precache: markers not found in sw.js');
  process.exit(1);
}
const vre = /const VERSION = '[^']*';/;
if (!vre.test(sw)) {
  console.error('gen-precache: no VERSION line in sw.js');
  process.exit(1);
}
await writeFile(swPath, sw.replace(re, block).replace(vre, `const VERSION = '${version}';`), 'utf8');
console.log(`gen-precache: ${list.length} entries written to sw.js (${version})`);

export { version };
