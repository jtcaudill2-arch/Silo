# Deepwater

Real-time colony management in **Silo 12** — ninety-two floors, a hundred and
eighty named people, and a sky that kills in under an hour.

An installable PWA. Vanilla ES modules, no framework, no build step, no server,
no network. Canvas for the silo, DOM for everything you read.

---

## Running it

```bash
npm run serve      # http://localhost:8123
```

ES modules and service workers both refuse to load from `file://`, so it needs
to be served over http — that's all `tools/serve.mjs` does.

## Tests

```bash
npm test                    # headless sim: 100 game days, no rendering
node test/harness.mjs --days=300 --verbose
node test/browser.mjs       # real-browser smoke test, including offline boot
node test/browser.mjs --shots   # ...and write screenshots to .shots/
```

The headless harness runs two silos: a *sufficient* one that must survive 100
days without diverging, and the real six-room opening, which is supposed to
start starving around day 15. Both assert the same invariants — no NaNs, caps
hold, no citizen dies without a named cause in the log, no action dispatched
without a reducer.

## Build tools

None are required to play. These regenerate committed artefacts:

```bash
node tools/gen-precache.mjs   # rewrite the service worker's precache list
node tools/gen-icons.mjs      # regenerate the PWA icons
node tools/fetch-fonts.mjs    # vendor the woff2 files into assets/fonts
```

Run `gen-precache` after adding any file under `src/` or `assets/`, or it won't
be available offline.

---

## Layout

```
index.html  sw.js  manifest.webmanifest
src/
  config/balance.js    EVERY tunable number. No exceptions.
  core/                loop, store, reducers, save, catchup, rng, events, game
  sim/                 pure (state, ctx) -> actions. No DOM, no mutation.
  render/              canvas, floors, citizens, depth gauge
  ui/                  plain DOM panels
  data/                rooms, research, silos, encounters, items, names, traits
```

### The rules this codebase actually enforces

- **Every tunable number lives in `config/balance.js`.** If a number changes
  how the game plays, it is not allowed to be inline.
- **All randomness routes through `core/rng.js` with an explicit seed.**
  Callers derive a named stream from `(seed, purpose, entityId, tick)`, so a
  fight resolves identically whether you watched it or it was replayed during
  offline catch-up. There is no save-scumming.
- **Sim modules are pure.** They take state and return actions. They never
  touch the DOM and never mutate. That's what makes the headless harness able
  to exercise exactly the code the browser runs.
- **Reducers are the only writers.** `CITIZEN_DIE` writes its own log entry
  with a name and a cause, so a death can't go unrecorded by accident.
- **No feature ships without a save migration.** Bump `SCHEMA_VERSION` and
  write the migration in the same commit.

---

## Design

The full specification lives in `docs/DESIGN.md`. Four pillars:

1. Every decision costs somebody something.
2. The world outside is real and mostly hostile.
3. You are the mayor, not the hand of god.
4. Progress is legible and slow.

---

## Licence & attribution

Original work. Names, silos, factions and lore are original to this project.

Bundled fonts — Saira Condensed, IBM Plex Sans, IBM Plex Mono — are SIL Open
Font License 1.1; see `assets/fonts/LICENCE.txt`.
