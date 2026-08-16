#!/usr/bin/env node
/**
 * build-site.mjs — assemble the deployable tree in dist/.
 *
 * This is not a build step in the sense the spec forbids: nothing is bundled,
 * transpiled or minified, and `npm run serve` still serves the source tree
 * directly with no prior command. This only *selects* — it copies the files
 * that ship and leaves behind the ones that don't (tools/, test/, the art
 * pipeline), so a host isn't serving the workshop alongside the game.
 *
 * It also enforces the invariant that matters for a PWA: every path in the
 * service worker's PRECACHE list must exist in the shipped tree. A precache
 * entry that 404s doesn't fail loudly — the install handler swallows it by
 * design — it just quietly produces a game that dies the first time it's
 * opened offline. Better to fail here, where someone is watching.
 *
 * Usage: node tools/build-site.mjs [--out dist]
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rm, readdir, stat, cp } from 'node:fs/promises';
import { join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};

const OUT = join(ROOT, arg('out', 'dist'));

/* What ships. Directories are copied whole; anything not listed stays home. */
const DIRS = ['src', 'assets'];
const FILES = ['index.html', 'manifest.webmanifest', 'sw.js'];

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else out.push(full);
  }
  return out;
}

/* ---------------------------------------------------------------- assemble */

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

let copied = 0;
let bytes = 0;

for (const d of DIRS) {
  const src = join(ROOT, d);
  for (const full of await walk(src)) {
    const rel = relative(ROOT, full);
    const dest = join(OUT, rel);
    await mkdir(dirname(dest), { recursive: true });
    await cp(full, dest);
    copied += 1;
    bytes += (await stat(full)).size;
  }
}

for (const f of FILES) {
  const src = join(ROOT, f);
  const info = await stat(src).catch(() => null);
  if (!info) {
    console.error(`build-site: missing required file ${f}`);
    process.exit(1);
  }
  await cp(src, join(OUT, f));
  copied += 1;
  bytes += info.size;
}

/* GitHub Pages runs Jekyll unless told otherwise, and Jekyll silently drops
   any path with a leading underscore. Nothing here starts with one today, but
   the failure mode is a missing file on a live site, so we opt out for good. */
await writeFile(join(OUT, '.nojekyll'), '', 'utf8');

/* ------------------------------------------------------------------ verify */

const sw = await readFile(join(ROOT, 'sw.js'), 'utf8');
const block = sw.match(/PRECACHE:BEGIN[\s\S]*?PRECACHE:END/);
if (!block) {
  console.error('build-site: no PRECACHE block in sw.js — run `npm run precache`');
  process.exit(1);
}
const precache = [...block[0].matchAll(/'([^']+)'/g)].map((m) => m[1]);

const missing = [];
for (const entry of precache) {
  // './' is the directory index — served as index.html.
  const rel = entry === './' ? 'index.html' : entry.replace(/^\.\//, '');
  const info = await stat(join(OUT, rel.split('/').join(sep))).catch(() => null);
  if (!info || !info.isFile()) missing.push(entry);
}
if (missing.length) {
  console.error('build-site: precached paths absent from the shipped tree:');
  for (const m of missing) console.error(`  ${m}`);
  console.error('Run `npm run precache` after adding or removing assets.');
  process.exit(1);
}

/* The reverse direction matters too: a module that ships but isn't precached
   loads fine online and 503s the moment the player opens the game on a train. */
const shipped = (await walk(OUT))
  .map((f) => './' + relative(OUT, f).split(sep).join('/'))
  .filter((f) => /\.(js|css|png|woff2|json|webmanifest|html)$/.test(f))
  .filter((f) => f !== './sw.js'); // the worker is fetched by the browser, never by itself

const unlisted = shipped.filter((f) => !precache.includes(f));
if (unlisted.length) {
  console.error('build-site: shipped files missing from PRECACHE (offline would 503):');
  for (const m of unlisted) console.error(`  ${m}`);
  console.error('Run `npm run precache`.');
  process.exit(1);
}

/* And the version has to describe what is actually in the box.
 *
 * `VERSION` names the cache, and `sw.js` only differs between builds when its
 * generated content does — so a stale version is not a cosmetic problem, it is
 * a worker that never installs. Every returning player keeps the build they
 * already had until the background revalidate happens to replace each file, a
 * session late and silently. The list being right and the version being wrong
 * is exactly the state this catches: `npm run precache` writes both, and the
 * checks above pass without it.
 *
 * Recomputed the same way gen-precache computes it — over the precached files'
 * own bytes, in list order — so this is the same claim rather than a second
 * one that can disagree. */
const swVersion = sw.match(/const VERSION = '([^']*)';/)?.[1];
const digest = createHash('sha1');
for (const entry of precache.filter((f) => f !== './')) {
  digest.update(entry);
  digest.update(await readFile(join(ROOT, entry.slice(2))));
}
const want = 'deepwater-' + digest.digest('hex').slice(0, 12);
if (swVersion !== want) {
  console.error(`build-site: sw.js is versioned ${swVersion} and its contents hash to ${want}.`);
  console.error('A stale version means the worker never installs, so returning players keep the');
  console.error('build they already had. Run `npm run precache`.');
  process.exit(1);
}

/* Absolute same-origin URLs break a project site served from /Repo/. Relative
   paths are the whole reason this deploys unmodified — keep it that way. */
const absolute = [];
for (const f of ['index.html', 'manifest.webmanifest', 'sw.js']) {
  const text = await readFile(join(OUT, f), 'utf8');
  for (const m of text.matchAll(/(?:src|href|start_url|scope)\s*[=:]\s*["'](\/[^/"'][^"']*)["']/g)) {
    absolute.push(`${f}: ${m[1]}`);
  }
}
if (absolute.length) {
  console.error('build-site: root-absolute paths would 404 under a subpath deploy:');
  for (const a of absolute) console.error(`  ${a}`);
  process.exit(1);
}

const kb = (bytes / 1024).toFixed(1);
console.log(`build-site: ${copied} files, ${kb} KB → ${relative(ROOT, OUT)}/`);
console.log(`build-site: ${precache.length} precache entries verified present`);
