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
import { showEnding } from './ui/ending.js';
import { showBriefing } from './ui/briefing.js';
import { COLD_OPEN } from './data/briefing.js';
import { startTutorial } from './ui/tutorial.js';

import { SiloRenderer, syncPaletteFromCSS } from './render/canvas.js';
import { DepthGauge } from './render/depthgauge.js';
import { loadAtlas } from './render/sprites.js';
import { loadArtwork, primeRoomSkills } from './ui/artwork.js';
import * as audio from './audio/audio.js';

import { Shell } from './ui/shell.js';
import { openRoom } from './ui/roomView.js';
import { ROOMS } from './data/rooms.js';
import { toast, modal, closeTopModal, button, el } from './ui/dom.js';
import { CRISES } from './data/events.js';
import { openSettings } from './ui/settings.js';
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
  // "Begin again" from the ending screen sets this and reloads, because a
  // finished campaign must not be resumed — the alternative is reopening a
  // silo whose last log entry says everybody in it is dead.
  const startFresh = localStorage.getItem('deepwater:newgame') === '1';
  localStorage.removeItem('deepwater:newgame');
  try {
    if (!startFresh) loaded = await loadGame(0);
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
  // The system preference is the *default*, not an override. Assigning it
  // unconditionally meant a player who turned reduced motion on by hand got
  // it turned back off on every reload, because their OS had no opinion —
  // the one setting in here that somebody might actually need was the one
  // that would not stay put.
  if (state.settings.reducedMotion === undefined || isNewGame) {
    state.settings.reducedMotion = reduced;
  }
  document.body.classList.toggle('reduced-motion', !!state.settings.reducedMotion);
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

  await loadAtlas('./assets/');
  // Imported artwork, if any has been. Deliberately not awaited alongside the
  // atlas as a hard requirement: a silo with no art/ directory boots exactly
  // as it did before, drawing everything procedurally.
  primeRoomSkills(ROOMS);
  await loadArtwork();
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
  document
    .getElementById('btn-settings')
    .addEventListener('click', () => openSettings(store, game, shell));
  if (store.state.settings.largeText) document.documentElement.classList.add('large-text');
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
    audio.play('death');
  });

  // ---- audio --------------------------------------------------------------
  // Browsers require a gesture before any sound; so does taste. The first
  // tap anywhere starts the context and unmutes if the player wants it.
  const kickAudio = async () => {
    await audio.start();
    audio.setMuted(store.state.settings.muted !== false);
    audio.setVolume(store.state.settings.volume ?? 0.6);
  };
  document.addEventListener('pointerdown', kickAudio, { once: true });
  document.addEventListener('keydown', kickAudio, { once: true });

  const CUES = {
    'action:ROOM_BUILD': 'build',
    'action:ROOM_MERGE': 'build',
    'action:EXCAVATION_START': 'excavate',
    'action:EXCAVATION_COMPLETE': 'complete',
    'action:RESEARCH_COMPLETE': 'research',
    'action:EXPEDITION_LAUNCH': 'depart',
    'action:EXPEDITION_RESOLVE': 'ret',
    'action:DECON': 'decon',
    'action:TRANSMISSION': 'radio',
    'action:CRIME_ADD': 'alert',
    'action:INVESTIGATION_OPEN': 'alarm',
    'action:CITIZEN_ADD': 'birth',
    'action:GEAR_CRAFT': 'confirm',
    'action:SILO_TREATY': 'transmit',
  };
  for (const [channel, cue] of Object.entries(CUES)) on(channel, () => audio.play(cue));
  on('alert', (a) => audio.play(a.kind === 'warn' ? 'alarm' : 'alert'));
  on('cycle', () => audio.updateAmbient(store.state));

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

  // A new silo opens on two screens of the previous mayor's handover — who is
  // handing over, and that the clock does not stop — with the silo paused
  // behind it. That is all it does now: the teaching is the guided session
  // below, on the real controls, one step at a time. The whole note is still
  // in Settings for anybody who wants it.
  //
  // Read before the cold open writes it: a save that had already seen the
  // handover before this build existed must not be handed a tutorial on
  // day two hundred.
  const hadHandover = !!store.state.flags.tutorialSeen;
  if (isNewGame && !hadHandover) {
    shell.setSpeed(0);
    await showBriefing({
      sections: COLD_OPEN,
      onDone: () => {
        store.dispatch({ type: 'FLAG_SET', flags: { tutorialSeen: true } });
        shell.setSpeed(1);
      },
    });
  }

  // The guided first session. It spotlights the real control, waits for the
  // player to use it, and does not advance on a timer. Skippable at any step,
  // resumes where it was left after a reload, and never returns once it has
  // been finished or skipped.
  const tutorial = startTutorial({
    store,
    shell,
    alreadySeen: hadHandover,
    // Flush once, when the guide ends. The autosave interval is twenty
    // seconds, and a player who skips it and closes the tab inside that window
    // would be shown the whole thing again on the way back in.
    onPersist: () => autosave.saveNow('tutorial'),
  });
  window.DEEPWATER.tutorial = tutorial;

  // The report is the reward for coming back, so it gets the screen to
  // itself and the silo stays paused until it's been read.
  if (report) {
    const resumeSpeed = store.state.settings.speed ?? 1;
    shell.setSpeed(0);
    renderer.focusFloor(store.state.ui.cameraFloor ?? 3, true);
    await showReturnReport(report);
    shell.setSpeed(resumeSpeed || 1);
  }

  // The endings are the payoff for the whole campaign, so they stop the clock
  // and take the screen. Watched live or discovered on resume, it's the same
  // screen — a silo that reached its ending while the tab was closed still
  // reached it.
  // Scripted crises stop the clock and take a dialog. They land five times
  // across a campaign, on a real-time schedule, and each one is a decision
  // the player is meant to arrive at having read it — not a line that scrolls
  // past while the silo keeps running.
  on('crisis', ({ id }) => {
    const crisis = CRISES[id];
    if (!crisis) return;
    const resumeSpeed = store.state.settings.speed ?? 1;
    shell.setSpeed(0);
    modal({
      title: crisis.name,
      body: el(
        'div',
        el('div.crisis-headline', crisis.headline),
        el('div.crisis-text', crisis.text),
        crisis.advice ? el('div.crisis-advice', crisis.advice) : null
      ),
      actions: [
        button('Understood', {
          class: 'primary',
          onclick: () => {
            closeTopModal();
            shell.setSpeed(resumeSpeed || 1);
          },
        }),
      ],
      onClose: () => shell.setSpeed(resumeSpeed || 1),
    });
  });

  let endingShown = false;
  const presentEnding = async () => {
    if (endingShown || !store.state.meta.gameOver) return;
    endingShown = true;
    shell.setSpeed(0);
    await showEnding(store.state, {
      onNewGame: () => {
        // A finished campaign is finished. Clearing the slot and reloading is
        // the only honest way back — resuming would resurrect a dead silo.
        localStorage.setItem('deepwater:newgame', '1');
        location.reload();
      },
    });
  };
  on('game-over', () => { presentEnding(); });
  await presentEnding();

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
