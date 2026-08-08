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
import { loadGame, Autosave } from './core/save.js';
import { runCatchup } from './core/catchup.js';
import { showReturnReport } from './ui/returnReport.js';

import { SiloRenderer, syncPaletteFromCSS } from './render/canvas.js';
import { DepthGauge } from './render/depthgauge.js';

import { Shell } from './ui/shell.js';
import { openRoom } from './ui/roomView.js';
import { toast } from './ui/dom.js';
import { resourcesPanel } from './ui/panels/resources.js';
import { populationPanel } from './ui/panels/population.js';
import { buildPanel } from './ui/panels/build.js';
import { researchPanel } from './ui/panels/research.js';
import { militaryPanel } from './ui/panels/military.js';
import { airlockPanel } from './ui/panels/airlock.js';
import { radioPanel } from './ui/panels/radio.js';
import { policyPanel } from './ui/panels/policy.js';
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

  // ---- load or create -----------------------------------------------------
  status('Looking for a silo…');
  let loaded = null;
  try {
    loaded = await loadGame(0);
  } catch (err) {
    // A save we can't read must not block a new game.
    console.error('[boot] could not load the save:', err);
  }

  let isNewGame = false;
  let state;
  if (loaded) {
    state = loaded.state;
    if (loaded.usedBackup) {
      console.warn('[boot] primary save was unreadable; restored from the backup.');
    }
  } else {
    status('Waking the silo…');
    state = createNewGame({});
    isNewGame = true;
  }
  state.settings.reducedMotion = reduced;
  const store = createStore(rehydrate(state));

  if (isNewGame) {
    // Staff the silo so the player opens on a running building, not a still one.
    store.dispatchAll(autoAssign(store.state));
  }

  const game = new Game(store);

  // ---- catch up on the absence -------------------------------------------
  // This runs before anything is drawn: the player should never see the silo
  // in its pre-absence state and watch it jump.
  let report = null;
  if (!isNewGame) {
    status('Reading the shift logs…');
    try {
      report = runCatchup(store, game);
    } catch (err) {
      console.error('[boot] catch-up failed:', err);
    }
  }

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
  shell
    .register(buildPanel)
    .register(populationPanel)
    .register(researchPanel)
    .register(militaryPanel)
    .register(airlockPanel)
    .register(radioPanel)
    .register(policyPanel)
    .register(resourcesPanel)
    .register(logPanel);
  shell.buildNav();
  shell.setSpeed(1);
  shell.renderChrome();

  renderer.onTap = (hit) => {
    if (hit.roomId) openRoom(store, hit.roomId, shell);
    else store.dispatch({ type: 'UI_SET', ui: { cameraFloor: hit.floor } });
  };
  shell.onAlertFloor = (floor, kind) => gauge.flag(floor, kind);
  shell.onFocusFloor = (n) => renderer.focusFloor(n);
  shell.onOpenRoom = (roomId) => {
    const room = store.state.silo.rooms[roomId];
    if (room) renderer.focusFloor(room.floor);
    shell.close();
    openRoom(store, roomId, shell);
  };

  // A death pulses the rail at the floor it happened on, so the player's eye
  // goes to the place rather than to a notification.
  on('death', ({ citizen }) => {
    const room = citizen.job ? store.state.silo.rooms[citizen.job.roomId] : null;
    if (room) gauge.flag(room.floor, 'warn');
  });

  // ---- persistence --------------------------------------------------------
  const autosave = new Autosave(store);
  autosave.start();

  // ---- run ----------------------------------------------------------------
  game.onFrame((dt) => {
    renderer.render(dt);
    gauge.render(dt);
  });
  game.start();

  // ---- expose for debugging ----------------------------------------------
  window.DEEPWATER = { store, game, shell, renderer, gauge, autosave, BAL, emit, runCatchup };

  status('Ready.');
  boot.remove();

  // The report is the reward for coming back, so it gets the screen to
  // itself and the silo stays paused until it's been read.
  if (report) {
    const resumeSpeed = store.state.settings.speed ?? 1;
    shell.setSpeed(0);
    renderer.focusFloor(store.state.ui.cameraFloor ?? 3, true);
    await showReturnReport(report);
    shell.setSpeed(resumeSpeed || 1);
  }

  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const register = () =>
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((err) => {
      // Not fatal: the game runs fine without offline caching.
      console.warn('[sw] registration failed:', err);
    });
  // Boot is async (IndexedDB), so by the time we get here the load event has
  // usually already fired — waiting for it unconditionally means the worker
  // never registers and the game silently loses offline support.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

main().catch((err) => {
  console.error(err);
  boot?.classList.add('error');
  status('The silo did not come up. ' + (err?.message || String(err)));
});
