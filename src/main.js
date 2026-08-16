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
import { loadGame, Autosave, summarise } from './core/save.js';
import { runCatchup } from './core/catchup.js';
import { showReturnReport } from './ui/returnReport.js';
import { showEnding } from './ui/ending.js';
import { showBriefing } from './ui/briefing.js';
import { openTitle } from './ui/title.js';
import { COLD_OPEN } from './data/briefing.js';
import { ALERT_COACH, REPORT_COACH } from './data/tutorial.js';
import { startTutorial } from './ui/tutorial.js';

import { SiloRenderer, syncPaletteFromCSS } from './render/canvas.js';
import { DepthGauge } from './render/depthgauge.js';
import { loadAtlas } from './render/sprites.js';
import { deathMarkAt } from './render/citizens.js';
import { fullName } from './sim/population.js';
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

  // ---- the title screen ---------------------------------------------------
  // First, and before anything is awaited. It draws a silo it generates
  // itself, so the descent is on screen while IndexedDB is still being asked
  // whether there is a save — see ui/title.js for why that matters. The whole
  // boot below happens behind it; the player's choice is taken at the end.
  let title = null;
  try {
    title = openTitle({ onFirstPaint: () => boot?.remove() });
  } catch (err) {
    // A broken door must not lock the player out of the building: log it, drop
    // whatever half of the screen made it into the document, and boot.
    console.error('[boot] the title screen did not come up:', err);
    document.getElementById('title')?.remove();
    title = null;
  }
  // Kicked off here rather than awaited at first use: the title draws people,
  // and this is the only thing on the boot path that goes to the network.
  loadAtlas('./assets/');

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

  // The door now knows what is behind it: Continue, with the day and the
  // headcount on it, or nothing to continue. Reduced motion is the player's
  // own setting rather than the OS default, so the title takes it from here.
  title?.setReducedMotion(state.settings.reducedMotion);
  title?.setSave(isNewGame ? null : summarise(store.state));

  if (isNewGame) {
    // Staff the silo so the player opens on a running building, not a still one.
    store.dispatchAll(autoAssign(store.state));
  }

  const game = new Game(store);

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
    // A death mark first. It is drawn over everything and it is the only thing
    // on the cross-section that asks to be acknowledged, so it takes the tap
    // ahead of the room it happens to be standing in.
    const mark = deathMarkAt(store.state, hit.worldX, hit.worldY);
    if (mark) {
      store.dispatch({ type: 'DEATH_ACKNOWLEDGE', id: mark.c.id });
      toast(`${fullName(mark.c)} — ${mark.c.causeOfDeath}.`);
      return;
    }
    if (hit.roomId) openRoom(store, hit.roomId, shell);
    else store.dispatch({ type: 'UI_SET', ui: { cameraFloor: hit.floor } });
  };
  shell.onAlertFloor = (floor, kind) => gauge.flag(floor, kind);
  shell.onFocusFloor = (n) => renderer.focusFloor(n);

  // Zoom. Pinch is bound on the canvas itself; these are the visible half,
  // because nothing on a phone advertises that a canvas can be pinched.
  {
    const zin = document.getElementById('zoom-in');
    const zout = document.getElementById('zoom-out');
    // Guarded, because the boot path may not fail over a control. The first
    // version of this dereferenced both straight away, so deleting the markup
    // threw here and the game never got past the title screen — a missing zoom
    // button taking the whole silo with it. Pinch still works without them.
    if (!zin || !zout) {
      console.warn('[boot] no zoom controls in the markup; pinch still works');
    } else {
    const sync = () => {
      zin.disabled = renderer.zoom >= BAL.render.maxZoom - 0.001;
      zout.disabled = renderer.zoom <= 1.001;
    };
    const step = (mult) => {
      renderer.setZoom(renderer.zoom * mult);
      sync();
    };
    zin.addEventListener('click', () => step(1.5));
    zout.addEventListener('click', () => step(1 / 1.5));
    // The pinch changes it too, and the buttons have to agree about whether
    // they are at the end of their travel.
    renderer.onZoom = sync;
    sync();
    }
  }
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
  game.onFrame((dt, simDt) => {
    renderer.render(dt, simDt);
    gauge.render(dt);
  });

  // ---- expose for debugging ----------------------------------------------
  window.DEEPWATER = { store, game, shell, renderer, gauge, autosave, BAL, emit, runCatchup, title };

  status('Ready.');
  boot?.remove();

  // ---- the door ------------------------------------------------------------
  // Everything above is built and nothing is ticking yet. The title screen has
  // been on the glass since the first frame; this is where the tap it has been
  // waiting for lands.

  // Settings opens for real from the title, and the guided first session does
  // not exist until the silo does. Asking to replay it from that screen means
  // "when I get in" rather than "now" — without this the button is simply dead
  // there, because `shell.onReplayGuide` is not wired until much further down.
  let replayGuideOnEntry = false;
  shell.onReplayGuide = () => {
    replayGuideOnEntry = true;
  };

  if (title) {
    title.ready({ onSettings: () => openSettings(store, game, shell) });
    const choice = await title.choice();
    // "New silo" over a silo that already exists is the only destructive
    // answer in the game, and the title has already asked before it gets here.
    // The swap is done in place rather than by reloading the page: nothing has
    // ticked, drawn or autosaved, so there is no half-played silo to leave
    // behind — and a reload would cost the player a second launch and a second
    // tap on the same button.
    if (choice === 'new' && !isNewGame) {
      isNewGame = true;
      store.replace(rehydrate(createNewGame({})));
      // A fresh silo takes the OS preference again, the same as one created at
      // the top of this function. Through a dispatch, not by hand: the store
      // exists now, and nothing outside a reducer writes to state.
      store.dispatch({ type: 'SETTING_SET', settings: { reducedMotion: reduced } });
      document.body.classList.toggle('reduced-motion', !!reduced);
      store.dispatchAll(autoAssign(store.state));
      shell.renderChrome();
      renderer.focusFloor(store.state.ui.cameraFloor ?? 3, true);
    }
  }

  // ---- catch up on the absence -------------------------------------------
  // After the choice, so a player starting again never waits on a week of
  // somebody else's absence — and still before the first frame of the real
  // silo, so nobody sees it in its pre-absence state and watches it jump.
  let report = null;
  if (!isNewGame) {
    status('Reading the shift logs…');
    try {
      report = runCatchup(store, game);
    } catch (err) {
      console.error('[boot] catch-up failed:', err);
    }
    renderer.focusFloor(store.state.ui.cameraFloor ?? 3, true);
  }

  await title?.close();
  game.start();

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
  // been finished or skipped — except on request, from Settings ⚙.
  let tutorial = null;
  const runGuide = () => {
    tutorial?.stop?.();
    tutorial = startTutorial({
      store,
      shell,
      alreadySeen: hadHandover,
      // Flush once, when the guide ends. The autosave interval is twenty
      // seconds, and a player who skips it and closes the tab inside that
      // window would be shown the whole thing again on the way back in.
      onPersist: () => autosave.saveNow('tutorial'),
      onEnd: (completed) => {
        // Both of the things the guide could not point at, armed together.
        // Neither writes a flag: they are offered to somebody who has just
        // finished the guide, in the session they finished it in, so there is
        // nothing to migrate and nothing to show a silo on day 200.
        if (completed) { armAlertCoach(); armReportCoach(); }
      },
    });
    window.DEEPWATER.tutorial = tutorial;
    return tutorial;
  };

  /**
   * The one lesson the guide cannot give in advance.
   *
   * There is nothing to point at until the silo has something to interrupt the
   * player about, so this waits for the first alert of the session and then
   * says one sentence about the card that just landed. Armed in memory only:
   * it is offered to somebody who has just finished the guide, in the session
   * they finished it in, which needs no flag of its own and so no migration.
   */
  function armAlertCoach() {
    const disarm = on('alert', () => {
      // One frame, so the card the coach is about is in the document. Disarmed
      // only once it has actually started: `startCoach` refuses while another
      // coach is up, and an alert that arrives during the shift-report card
      // must be waited for again rather than silently spent.
      requestAnimationFrame(() => {
        if (startCoach(ALERT_COACH)) disarm();
      });
    });
  }

  /**
   * The other lesson that cannot be given in advance.
   *
   * The shift report is a bar under the standing order that does not exist
   * until a shift ends with something in it, and the room the guide has just
   * had the player order does not report until it comes online — measured,
   * three shifts, four and a half minutes at 1×. So this watches for the line
   * rather than guessing at a delay, and says one sentence the moment it is
   * there to point at. Polled rather than evented: the bar's visibility is a
   * render decision (`renderChangeLine` weighs staleness and unread count),
   * and asking the document is the only thing that cannot disagree with it.
   */
  function armReportCoach() {
    const timer = setInterval(() => {
      const bar = document.getElementById('change-line');
      if (!bar || bar.hidden || !bar.getClientRects().length) return;
      if (startCoach(REPORT_COACH)) clearInterval(timer);
    }, 1000);
  }

  /**
   * One coach at a time. Two cards pointing at different corners of the same
   * screen is not twice the guidance, and the second would be drawn by the
   * same overlay as the first.
   */
  let coachRunning = null;
  function startCoach(steps) {
    if (coachRunning) return false;
    coachRunning = startTutorial({
      store, shell, steps, persist: false, label: 'The silo',
      onEnd: () => { coachRunning = null; },
    });
    return !!coachRunning;
  }

  // Settings ⚙ can run it again. The guide is eight minutes of the game's
  // best explanation of itself and used to be unreachable the moment it ended.
  shell.onReplayGuide = () => {
    store.dispatch({ type: 'FLAG_SET', flags: { tutorialStep: 0 } });
    runGuide();
  };

  if (replayGuideOnEntry) store.dispatch({ type: 'FLAG_SET', flags: { tutorialStep: 0 } });
  runGuide();

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
