# Deepwater

Real-time colony management in **Silo 12** — a hundred and forty-four floors,
forty-four named people, and a sky that kills in under an hour.

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

Progress autosaves to IndexedDB continuously and on tab close. Settings ⚙ has
export/import if you want the save as a file.

## Playing it on a phone

The layout is phone-first — 390×844 is the viewport the tests drive and the
screenshots are taken at — so the browser is a first-class way to play, not a
fallback.

**Over Wi-Fi, from your own machine.** `npm run serve` listens on every
interface and prints the LAN address:

```
  Deepwater — http://localhost:8123/

  On your phone, same Wi-Fi, open:
      http://192.168.1.24:8123/
```

Type that into the phone and play. The laptop has to stay awake and on the
same network; guest Wi-Fi with client isolation blocks it entirely, in which
case a personal hotspot from the phone with the laptop joined to it works.

**From a URL, with no laptop involved.** Pushing to the default branch runs
`.github/workflows/pages.yml`, which publishes to
`https://jtcaudill2-arch.github.io/Silo/`. GitHub Pages needs the repository
to be public, or an account with Pages enabled for private repositories.

That URL is HTTPS, which matters for more than privacy: browsers only grant
service workers and install prompts to a secure context, and a plain-http LAN
address is not one. So over Wi-Fi you get the game; from the Pages URL you
also get *Add to Home Screen* and genuine offline play afterwards.

A project site is served from `/Silo/`, not `/`. Every path in the game is
relative for that reason, and `npm run test:mobile` plays the whole game from
a subpath — boot, manifest scope, service worker scope, offline reload — so a
stray root-absolute path fails locally instead of on the live site.

Whichever route: the save lives in IndexedDB keyed to the origin, so a silo
started on the LAN address is a different silo from one started on the Pages
URL. Settings ⚙ → *Export save* moves one across.

## Your first ten minutes

The game opens on two screens of handover note from the previous mayor — who
is handing over, and that the clock does not stop — and then a guided first
session that spotlights a real control, says one sentence about it, and waits
for you to use it (the steps are `TUTORIAL` in `src/data/tutorial.js`). Both
are reopenable from Settings ⚙, along with the full note, which is worth
reading. The short version:

1. **Build Recycling, then a Workshop, then a Laboratory.** Scrap and parts
   are what every other room is made of, and nothing but a Laboratory makes
   research points. The starting stores buy about five buildings.
2. **Staff everything you build.** A new room has no crew and produces
   nothing until it does — tap the room, or use *Auto-assign* on the **People**
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

Time runs at one shift per ninety real seconds — eight shifts to the day, so a
game day is twelve minutes. That figure is `TICKS_PER_CYCLE × TICK_MS` in
`src/config/balance.js`, and the two places the game states it out loud derive
it from there rather than repeating it. `1×/2×/4×` is top right, space bar
pauses, and closing the tab is fine — the silo keeps running and hands you a
report on what you missed.

## Importing artwork

Commissioned art goes through `tools/import-art.mjs`. Drop the source images
into `art-src/` named by their asset id, then:

```bash
node tools/import-art.mjs --report   # what's mapped, what's missing, what's extra
node tools/import-art.mjs            # convert art-src/ -> assets/art/
node tools/gen-precache.mjs          # so they work offline
```

`src/data/artwork.js` maps asset ids to rooms, citizens and threats — the
generated art uses a different working title and its own room vocabulary, so
living quarters are Residences and the mess hall is the Cafeteria. Edit that
file, not filenames.

The importer keys mottled magenta plates by RGB distance rather than exact
match (generated plates are rarely flat `#FF00FF`), trims each sprite to its
own content, scales every frame of a strip by one shared factor so a walk
cycle doesn't bob, and resamples nearest-neighbour. It uses the Chromium that
Playwright already provides rather than adding an image-processing dependency.

**Where art is used, and where it isn't.** The silo cross-section draws a room
into a 64×40 slot and a citizen into about six pixels by nine; high-resolution
art is a smudge at that size, so the procedural atlas — authored for it — stays.
Imported art is used in the room detail panel, the citizen card, and the
surface screens, where there is room to look at it. Everything is optional at
runtime: with no `assets/art/` the game draws exactly as it did before.

## Tests

```bash
npm test                        # everything, in order, ending with the browser
npm run test:reach              # can the game be finished at all? (milliseconds)
npm run test:sim                # headless: 100 game days, no rendering
npm run test:pacing -- --days=800
node test/harness.mjs --days=300 --verbose
node test/browser.mjs --shots   # real browser, incl. offline boot; writes .shots/
npm run test:mobile             # a phone, by finger, served from /Silo/
```

`test/browser.mjs` and `test/mobile.mjs` are the only ones that need anything
installed (`npm i -D playwright`); the rest are pure Node.

`mobile.mjs` covers what the desktop test structurally cannot: it builds
`dist/`, serves it from a subpath the way GitHub Pages does, and drives it as
a touch device. It caught the bug where `node.hidden = true` set the property
correctly on every hidden resource counter and locked panel while all of them
stayed on screen — `[hidden]` is a user-agent rule and loses to the author
`display: flex` on `.res` and `.nav-btn`. The old assertion counted
`!node.hidden` and passed throughout. Both tests now count what renders.

`reachability.mjs` is the cheapest and the one to run first. It is a
fixed-point solve over the research tree, the loot tables and the band suit
gates — not a simulation — so it holds for every seed and every strategy. It
exists because the game shipped for a while in a state where `env_suit_3`
needed an artifact that only dropped in a band requiring `env_suit_3`, which
made all three endings unreachable forever, and eight hundred days of played
simulation could not tell you that.

The headless harness runs two silos: a *sufficient* one that must survive 100
days without diverging, and the real opening position — five rooms and
forty-four people, per `STARTING_ROOMS` in `core/newgame.js` — left to run with
nobody touching it. That one used to be six rooms in a food deficit that killed
everybody by day twenty-five; it was cut down twice, and now it holds. Both
assert the same invariants — no NaNs, caps hold, no citizen dies without a named
cause in the log, no action dispatched without a reducer.

## Build tools

None are required to play. These regenerate committed artefacts:

```bash
node tools/gen-precache.mjs   # rewrite the service worker's precache list
node tools/gen-icons.mjs      # regenerate the PWA icons
node tools/fetch-fonts.mjs    # vendor the woff2 files into assets/fonts
npm run build                 # assemble dist/ for a static host
npm run serve:dist            # build, then serve it at /Silo/ like Pages does
```

`build-site.mjs` copies rather than bundles — nothing is transpiled and
`npm run serve` still needs no prior command. What it adds is the check: it
fails if a precached path is missing from the shipped tree, if a shipped
module is missing from the precache list, or if a root-absolute path crept
into the HTML, manifest or worker. Each of those produces a game that works
locally and breaks on a host, or works online and dies offline.

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
