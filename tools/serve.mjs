#!/usr/bin/env node
/**
 * serve.mjs — a static dev server.
 *
 * No build step means no dev server from a bundler either. This is just
 * enough to serve the tree over http (ES modules and service workers both
 * refuse to load from file://), with the right MIME types and no caching so
 * a reload always shows the edit you just made.
 *
 * It listens on every interface, not just loopback, so a phone on the same
 * Wi-Fi can open the game — the LAN address is printed at startup because
 * looking it up per-platform is the annoying part.
 *
 * Options:
 *   --root <dir>    serve this directory instead of the repo (e.g. dist)
 *   --base <path>   mount under a prefix, mimicking a project site at /Repo/
 *   PORT=8123       env override
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const REPO = join(fileURLToPath(new URL('.', import.meta.url)), '..');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};

const ROOT = resolve(REPO, arg('root', process.env.SERVE_ROOT || '.'));
const PORT = Number(process.env.PORT || 8123);

// Normalised to a leading and trailing slash, or '/' for a root mount.
const rawBase = arg('base', process.env.SERVE_BASE || '/');
const BASE = ('/' + rawBase.replace(/^\/+|\/+$/g, '') + '/').replace('//', '/');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent((req.url || '/').split('?')[0]);

    if (BASE !== '/') {
      // A project site is reached at /Repo/ — /Repo without the slash has to
      // redirect, or every relative path in the page resolves one level high.
      if (path === BASE.slice(0, -1)) {
        res.writeHead(301, { Location: BASE }).end();
        return;
      }
      if (!path.startsWith(BASE)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + path);
        return;
      }
      path = '/' + path.slice(BASE.length);
    }

    if (path === '/' || path === '') path = '/index.html';
    const full = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(full).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found: ' + path);
      return;
    }
    const buf = await readFile(full);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      // The service worker needs to be allowed to claim the whole scope.
      'Service-Worker-Allowed': BASE,
    });
    res.end(buf);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err));
  }
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) out.push(net.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`\n  Deepwater — http://localhost:${PORT}${BASE}`);
  const lan = lanAddresses();
  if (lan.length) {
    console.log('\n  On your phone, same Wi-Fi, open:');
    for (const ip of lan) console.log(`      http://${ip}:${PORT}${BASE}`);
  } else {
    console.log('\n  No LAN address found — this machine looks off-network.');
  }
  console.log('');
});
