#!/usr/bin/env node
/**
 * fetch-fonts.mjs — vendor the three typefaces the spec calls for.
 *
 * The game must run with the network disabled, so it cannot link a font CDN.
 * This pulls the woff2 files once, at build time, into /assets/fonts where the
 * service worker precaches them like any other asset.
 *
 * Fonts: Saira Condensed (SIL OFL 1.1), IBM Plex Sans and IBM Plex Mono
 * (SIL OFL 1.1). Licences are written alongside them.
 *
 * Run:  node tools/fetch-fonts.mjs
 * Safe to skip — styles.css falls back to system stacks if the files are absent.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const OUT = join(ROOT, 'assets/fonts');

// A modern UA string so Google Fonts serves woff2 with a unicode-range split;
// we take the latin subset only, which is all this game's copy needs.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const WANTED = [
  { css: 'Saira+Condensed:wght@600', weight: '600', file: 'SairaCondensed-SemiBold.woff2' },
  { css: 'IBM+Plex+Sans:wght@400', weight: '400', file: 'IBMPlexSans-Regular.woff2' },
  { css: 'IBM+Plex+Sans:wght@500', weight: '500', file: 'IBMPlexSans-Medium.woff2' },
  { css: 'IBM+Plex+Mono:wght@400', weight: '400', file: 'IBMPlexMono-Regular.woff2' },
];

await mkdir(OUT, { recursive: true });

let written = 0;
for (const want of WANTED) {
  try {
    const cssUrl = `https://fonts.googleapis.com/css2?family=${want.css}&display=swap`;
    const css = await (await fetch(cssUrl, { headers: { 'User-Agent': UA } })).text();

    // Pull the latin (not latin-ext) block, then its woff2 url.
    const blocks = css.split('/*').map((b) => '/*' + b);
    const latin = blocks.find((b) => b.startsWith('/* latin *')) || blocks[blocks.length - 1];
    const m = latin.match(/url\((https:\/\/[^)]+\.woff2)\)/);
    if (!m) throw new Error('no woff2 url in the stylesheet');

    const buf = Buffer.from(await (await fetch(m[1], { headers: { 'User-Agent': UA } })).arrayBuffer());
    if (buf.length < 1000) throw new Error(`suspiciously small (${buf.length} bytes)`);
    await writeFile(join(OUT, want.file), buf);
    console.log(`fetch-fonts: ${want.file} (${(buf.length / 1024).toFixed(1)} KB)`);
    written++;
  } catch (err) {
    console.warn(`fetch-fonts: skipped ${want.file} — ${err.message}`);
  }
}

await writeFile(
  join(OUT, 'LICENCE.txt'),
  [
    'Fonts bundled with Deepwater',
    '',
    'Saira Condensed — Copyright the Saira Project Authors.',
    'IBM Plex Sans, IBM Plex Mono — Copyright IBM Corp.',
    '',
    'All three are licensed under the SIL Open Font License, Version 1.1.',
    'https://openfontlicense.org',
    '',
    'They are redistributed here unmodified so the game can run with no',
    'network connection, as an offline-first PWA must.',
  ].join('\n')
);

console.log(`fetch-fonts: ${written}/${WANTED.length} fonts vendored into assets/fonts`);
