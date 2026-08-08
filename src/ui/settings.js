/**
 * settings.js — the settings sheet: audio, motion, and the save.
 *
 * Export/import is plain JSON the player owns. A game with no server and no
 * account needs a way for somebody to move their silo between devices, or
 * keep it when they clear their browser storage, and a file is the only
 * honest answer to that.
 */

import { BAL } from '../config/balance.js';
import * as audio from '../audio/audio.js';
import { exportSave, importSave, listSlots, saveGame, deleteSlot } from '../core/save.js';
import { el, button, row, sectionLabel, modal, toast, humanise, fmtDuration } from './dom.js';

export function openSettings(store, game, shell) {
  let handle = null;
  const rerender = () => {
    handle?.close();
    handle = show();
  };

  function show() {
    const s = store.state;
    const body = el('div');

    // ---- audio ------------------------------------------------------------
    body.appendChild(sectionLabel('Sound'));
    body.appendChild(
      toggleRow('Audio', s.settings.muted === false, 'Ambient hum, machinery, and about twenty cues. All synthesised — no files to download.', async () => {
        const next = s.settings.muted !== false ? false : true;
        if (!next) await audio.start();
        audio.setMuted(next);
        store.dispatch({ type: 'SETTING_SET', settings: { muted: next } });
        if (!next) audio.play('confirm');
        rerender();
      })
    );
    if (s.settings.muted === false) {
      body.appendChild(
        el(
          'div.pad',
          el('div.vital',
            el('span.vital-k', 'Volume'),
            el('input.slider', {
              type: 'range', min: '0', max: '100',
              value: String(Math.round((s.settings.volume ?? 0.6) * 100)),
              oninput: (e) => {
                const v = Number(e.target.value) / 100;
                audio.setVolume(v);
                store.dispatch({ type: 'SETTING_SET', settings: { volume: v } });
              },
            }),
          )
        )
      );
    }

    // ---- motion & accessibility -------------------------------------------
    body.appendChild(sectionLabel('Display'));
    body.appendChild(
      toggleRow('Reduced motion', !!s.settings.reducedMotion, 'Kills the lighting flicker, the depth-gauge pulse and camera easing. Follows your system setting by default.', () => {
        const next = !s.settings.reducedMotion;
        store.dispatch({ type: 'SETTING_SET', settings: { reducedMotion: next } });
        document.body.classList.toggle('reduced-motion', next);
        rerender();
      })
    );
    body.appendChild(
      toggleRow('Larger text', !!s.settings.largeText, 'Raises the base size throughout. Nothing drops below 13px either way.', () => {
        const next = !s.settings.largeText;
        store.dispatch({ type: 'SETTING_SET', settings: { largeText: next } });
        document.documentElement.classList.toggle('large-text', next);
        rerender();
      })
    );

    // ---- the save ----------------------------------------------------------
    body.appendChild(sectionLabel('This silo'));
    body.appendChild(
      row({
        title: `${s.meta.siloName} — year ${s.clock.year}, day ${s.clock.day % 12}`,
        sub:
          `${s.citizenIds.length} residents · ${s.stats.deaths} dead · ` +
          `${Math.round(s.meta.playedMs / 60000)} minutes played`,
      })
    );

    body.appendChild(
      el(
        'div.settings-actions',
        button('Save now', {
          onclick: async () => {
            await saveGame(store.state);
            toast('Saved.');
          },
        }),
        button('Export to a file', {
          onclick: () => downloadSave(store.state),
        }),
        button('Import a file', {
          onclick: () => uploadSave(store, game, shell, handle),
        })
      )
    );

    body.appendChild(
      el(
        'div.note',
        'Export writes a plain JSON file you own. There is no account and no server; ' +
          'that file is the only copy of this silo that survives clearing your browser storage.'
      )
    );

    // ---- start over --------------------------------------------------------
    body.appendChild(sectionLabel('Start over'));
    body.appendChild(
      el(
        'div.pad',
        button('Abandon this silo and begin again', {
          class: 'danger wide',
          onclick: () => confirmNewGame(store, handle),
        })
      )
    );

    // ---- about -------------------------------------------------------------
    body.appendChild(sectionLabel('About'));
    body.appendChild(
      el(
        'div.note',
        'Deepwater. Ninety-two floors, and a sky that kills in under an hour. ' +
          'Runs entirely on your device: no network, no account, no ads.'
      )
    );

    return modal({
      title: 'Settings',
      body,
      actions: [button('Close', { onclick: () => handle?.close() })],
    });
  }

  handle = show();
  return handle;
}

function toggleRow(label, on, desc, onclick) {
  return el(
    'button.policy' + (on ? '.active' : ''),
    { type: 'button', onclick },
    el('div.policy-switch', on ? '■' : '□'),
    el('div.policy-main', el('div.policy-name', label), el('div.policy-desc', desc))
  );
}

function downloadSave(state) {
  const text = exportSave(state);
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `deepwater-y${state.clock.year}d${state.clock.day % 12}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('Save exported.');
}

function uploadSave(store, game, shell, parent) {
  const input = el('input', {
    type: 'file',
    accept: 'application/json,.json',
    onchange: async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const state = importSave(text);
        await saveGame(state, 0);
        parent?.close();
        toast('Imported. Reloading…');
        setTimeout(() => location.reload(), 500);
      } catch (err) {
        toast(`That file did not load: ${err.message}`, 'bad');
      }
    },
  });
  input.style.display = 'none';
  document.body.appendChild(input);
  input.click();
  setTimeout(() => input.remove(), 60000);
}

function confirmNewGame(store, parent) {
  const s = store.state;
  const h = modal({
    title: 'Abandon Silo 12?',
    body: el(
      'div',
      el(
        'div.note',
        `${s.citizenIds.length} people live here. ${s.stats.deaths} have died under your administration. ` +
          'None of that survives this.'
      ),
      el('div.note.warn', 'Export first if you want to keep it. This cannot be undone.')
    ),
    actions: [
      button('Cancel', { onclick: () => h.close() }),
      button('Begin again', {
        class: 'danger',
        onclick: async () => {
          await deleteSlot(0);
          h.close();
          parent?.close();
          location.reload();
        },
      }),
    ],
  });
}

export default openSettings;
