# Deepwater

Real-time colony management in **Silo 12** — ninety-two floors, a hundred and
eighty named people, and a sky that kills in under an hour.

An installable PWA. Vanilla ES modules, no framework, no build step, no server,
no network. Canvas for the silo, DOM for everything you read.

---

## Running it

```bash
git clone -b claude/deepwater-game-design-5pml4z \
  https://github.com/jtcaudill2-arch/Silo.git
cd Silo
npm run serve      # http://localhost:8123
```

There is no `npm install` step and there are no dependencies — the game is
vanilla ES modules and runs exactly as it sits in the tree. ES modules and
service workers both refuse to load from `file://`, so it does need to be
served over http, and `tools/serve.mjs` is a fifty-line static server that
does nothing else. Any other static server works just as well.

Open `http://localhost:8123` in a browser. On a phone, serve it on your
machine and visit `http://<your-machine>:8123` — Chrome and Safari will both
offer to install it to the home screen, after which it runs offline with no
network at all.

Progress autosaves to IndexedDB continuously and on tab close. Settings ⚙ has
export/import if you want the save as a file.

## Your first ten minutes

The game opens on a handover note from the previous mayor. It is the tutorial
and it is worth reading; you can reopen it any time from Settings ⚙. The short
version:

1. **Build Recycling, then a Workshop, then a Laboratory.** Scrap and parts
   are what every other room is made of, and nothing but a Laboratory makes
   research points. The starting stores buy about five buildings.
2. **Staff everything you build.** A new room has no crew and produces
   nothing until it does — tap the room, or use *Auto-assign* on the Residents
   panel. The room view says "Unstaffed. This room is producing nothing."
3. **Watch flows, not stockpiles.** The resource strip shows a per-cycle
   delta under each figure. A tank that reads full and is falling is a worse
   position than one that reads low and is rising; the silo will warn you in
   days-of-runway when something turns negative.
4. **Repair before things fail.** Rooms lose condition every shift. A
   generator hall that hits zero takes every other room with it. Build a
   Maintenance Bay early and order repairs when the condition figure is in
   the thirties.
5. **Open the airlock as soon as you can.** Research is gated on artifacts
   and artifacts only come from the surface. The chain is Env-Suit I →
   Airlock → Suit Bay → Armory → Foundry → Chem Lab, and the near ruins drop
   nothing worth having, so keep climbing the suit tiers.

Time runs at one shift per real minute. `1×/2×/4×` is top right, space bar
pauses, and closing the tab is fine — the silo keeps running and hands you a
report on what you missed.

## Tests

```bash
npm test                        # everything, in order, ending with the browser
npm run test:reach              # can the game be finished at all? (milliseconds)
npm run test:sim                # headless: 100 game days, no rendering
npm run test:pacing -- --days=800
node test/harness.mjs --days=300 --verbose
node test/browser.mjs --shots   # real browser, incl. offline boot; writes .shots/
```

`test/browser.mjs` is the only one that needs anything installed
(`npm i -D playwright`); the rest are pure Node.

`reachability.mjs` is the cheapest and the one to run first. It is a
fixed-point solve over the research tree, the loot tables and the band suit
gates — not a simulation — so it holds for every seed and every strategy. It
exists because the game shipped for a while in a state where `env_suit_3`
needed an artifact that only dropped in a band requiring `env_suit_3`, which
made all three endings unreachable forever, and eight hundred days of played
simulation could not tell you that.

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
