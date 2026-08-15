/**
 * chromium.mjs — where the browser is, on whichever machine this is.
 *
 * `test/browser.mjs` and `test/mobile.mjs` both drive a real Chromium, and
 * both used to name one:
 *
 *   const EXEC = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
 *
 * That path exists in one container image and nowhere else, so the two suites
 * that boot the actual game were unrunnable for anybody who was not inside it —
 * a contributor on a Mac, a laptop, or a CI runner. It is also pinned to a
 * build number that moves: the image ships chromium-1194 today, and the day it
 * ships 1195 the path is dead and both suites fail on a machine that has a
 * perfectly good browser sitting next to the one they asked for.
 *
 * Letting playwright resolve its own does not work here either, and the reason
 * is worth writing down rather than rediscovering. It looks up an executable by
 * the revision *its own version* was built against — `playwright@1.49.1` wants
 * `chromium_headless_shell-1148` — while `PLAYWRIGHT_BROWSERS_PATH` points at a
 * directory holding 1194. So the library and the image disagree by build
 * number, playwright refuses, and naming the path was the workaround.
 *
 * So: look, in order of how much the answer is meant to be trusted. An explicit
 * environment variable wins, because somebody who sets one has a reason. Then
 * the image's own symlink and any versioned build beside it, which covers this
 * container and the next one. Then nothing at all, which hands the question
 * back to playwright — the right answer on a runner that installed its own
 * matching browser and the only one that can be right on a machine this file
 * has never seen.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * An absolute path to Chromium, or undefined to let playwright decide.
 *
 * Undefined rather than a guess: `chromium.launch({ executablePath: undefined })`
 * is exactly `chromium.launch({})`, and a wrong path is a launch failure with a
 * worse error than playwright's own.
 */
export function browserPath() {
  const named = process.env.DEEPWATER_CHROMIUM;
  if (named) return named;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';

  // The image keeps an unversioned symlink beside the versioned directories.
  // It is the one thing here that survives a browser bump, so it is asked first.
  const link = join(root, 'chromium');
  if (existsSync(link)) return link;

  // Failing that, any chromium-<n> in the directory. Highest build wins, and
  // the sort is numeric — a string sort puts chromium-99 above chromium-1194.
  let dirs = [];
  try {
    dirs = readdirSync(root).filter((n) => /^chromium-\d+$/.test(n));
  } catch {
    return undefined; // no such directory: not this kind of machine
  }
  dirs.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const dir of dirs) {
    const exe = join(root, dir, 'chrome-linux', 'chrome');
    if (existsSync(exe)) return exe;
  }

  return undefined;
}

export default browserPath;
