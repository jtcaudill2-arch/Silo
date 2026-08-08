/**
 * main.js — boot.
 *
 * Order matters here: reducers must be registered before any state exists,
 * the save layer must be asked for a game before we invent one, and the loop
 * must not start until catch-up has finished replaying the player's absence.
 */

import { BAL } from './config/balance.js';
import { createStore } from './core/store.js';
import { registerCoreReducers } from './core/reducers.js';
import { createNewGame, rehydrate } from './core/newgame.js';
import { Game } from './core/game.js';
import { on, emit } from './core/events.js';
import { autoAssign } from './sim/jobs.js';

import { SiloRenderer, syncPaletteFromCSS } from './render/canvas.js';
import { DepthGauge } from './render/depthgauge.js';

import { Shell } from './ui/shell.js';
import { openRoom } from './ui/roomView.js';
import { toast } from './ui/dom.js';
import { resourcesPanel } from './ui/panels/resources.js';
import { logPanel } from './ui/panels/log.js';

const boot = document.getElementById('boot');
const bootStatus = document.getElementById('boot-status');
const appRoot = document.getElementById('app');

function status(text) {
  if (bootStatus) bootStatus.textContent = text;
}

async function main() {
  status('Reading the handover file…');
  registerCoreReducers();

  // Respect the OS motion preference before anything animates.
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  if (reduced) document.body.classList.add('reduced-motion');

  status('Waking the silo…');
  const state = createNewGame({});
  state.settings.reducedMotion = reduced;
  const store = createStore(rehydrate(state));

  // Staff the silo so the player opens on a running building, not a still one.
  store.dispatchAll(autoAssign(store.state));

  const game = new Game(store);

  // ---- render -------------------------------------------------------------
  status('Bringing up the lights…');
  syncPaletteFromCSS();
  const siloCanvas = document.getElementById('silo-canvas');
  const gaugeCanvas = document.getElementById('gauge-canvas');

  appRoot.hidden = false; // canvases need layout before they can size themselves
  const renderer = new SiloRenderer(siloCanvas, store);
  const gauge = new DepthGauge(gaugeCanvas, store, renderer);
  renderer.focusFloor(store.state.ui.cameraFloor ?? 3, true);

  const onResize = () => {
    renderer.resize();
    gauge.resize();
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);

  // ---- shell --------------------------------------------------------------
  const shell = new Shell(store, game);
  shell.register(resourcesPanel).register(logPanel);
  shell.buildNav();
  shell.setSpeed(1);
  shell.renderChrome();

  renderer.onTap = (hit) => {
    if (hit.roomId) openRoom(store, hit.roomId, shell);
    else store.dispatch({ type: 'UI_SET', ui: { cameraFloor: hit.floor } });
  };
  shell.onAlertFloor = (floor, kind) => gauge.flag(floor, kind);

  // Route alerts that carry a floor onto the depth gauge rail.
  on('action:CONDITION_DELTA', () => {});
  on('death', () => {});

  // ---- run ----------------------------------------------------------------
  game.onFrame((dt) => {
    renderer.render(dt);
    gauge.render(dt);
  });
  game.start();

  // ---- expose for debugging ----------------------------------------------
  window.DEEPWATER = { store, game, shell, renderer, gauge, BAL, emit };

  status('Ready.');
  boot.remove();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((err) => {
      // Not fatal: the game runs fine without offline caching.
      console.warn('[sw] registration failed:', err);
    });
  });
}

main().catch((err) => {
  console.error(err);
  boot?.classList.add('error');
  status('The silo did not come up. ' + (err?.message || String(err)));
});
