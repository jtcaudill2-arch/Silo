#!/usr/bin/env node
/**
 * reachability.mjs — can the game be finished at all?
 *
 * The research tree and the loot tables gate each other. Suits let you reach
 * a band; the band drops the artifacts that research better suits. That loop
 * is the spine of the whole game, and it is exactly the kind of structure
 * where one artifact filed one tier too deep makes the endgame unreachable
 * without anything looking wrong: every node is individually sensible, every
 * band is individually sensible, and the campaign simply never finishes.
 *
 * It happened. `env_suit_3` required `suit_weave`, `suit_weave` dropped only
 * in the deep band, and the deep band required tier-3 suits — so tier-3
 * suits required tier-3 suits. All three endings sit above that node, so the
 * game was unwinnable by construction, and 800 game days of competent play
 * could not tell you that. This can.
 *
 * The solver is a fixed point, not a simulation: start with nothing, repeat
 * "complete every node whose prerequisites and artifacts are obtainable"
 * until nothing new is obtainable, then report what is left. It is a
 * statement about the data, so it does not depend on a seed or a strategy —
 * if a node is unreachable here, no player can reach it either.
 *
 * Run: node test/reachability.mjs
 */

import { RESEARCH, RESEARCH_LIST, ARTIFACTS } from '../src/data/research.js';
import { LOOT } from '../src/data/items.js';
import { ENDINGS } from '../src/data/events.js';
import { BAL } from '../src/config/balance.js';

const failures = [];
const fail = (m) => failures.push(m);
const ok = (m) => console.log(`  ✓ ${m}`);

// ------------------------------------------------------------- the model ---

const BANDS = BAL.expedition.bands;

/** Every artifact that can drop somewhere, and the cheapest band that has it. */
const artifactSource = new Map();
for (const band of BANDS) {
  const table = LOOT[band.rewardTier];
  if (!table) continue;
  for (const id of Object.keys(table.artifacts || {})) {
    const prev = artifactSource.get(id);
    if (!prev || band.suitTier < prev.suitTier) artifactSource.set(id, band);
  }
}

/** Highest suit tier the completed set grants. */
function suitTierOf(completed) {
  let tier = 0;
  for (const id of completed) {
    const t = RESEARCH[id]?.effects?.suitTier;
    if (t) tier = Math.max(tier, t);
  }
  return tier;
}

// -------------------------------------------------------------- the solve ---

const completed = new Set();
let suitTier = 0;
let obtainable = new Set();
const completedAt = new Map(); // node id -> the round it became reachable
let round = 0;

for (;;) {
  round++;
  suitTier = suitTierOf(completed);
  obtainable = new Set();
  for (const band of BANDS) {
    if (band.suitTier > suitTier) continue;
    for (const id of Object.keys(LOOT[band.rewardTier]?.artifacts || {})) obtainable.add(id);
  }

  let progressed = false;
  for (const node of RESEARCH_LIST) {
    if (completed.has(node.id)) continue;
    if (node.requires.some((r) => !completed.has(r))) continue;
    if (Object.keys(node.artifacts).some((a) => !obtainable.has(a))) continue;
    completed.add(node.id);
    completedAt.set(node.id, round);
    progressed = true;
  }
  if (!progressed) break;
}

// ------------------------------------------------------------- the report ---

console.log('');
console.log('  DEEPWATER — can the game be finished?');
console.log('  ' + '─'.repeat(66));
console.log(`  ${completed.size} of ${RESEARCH_LIST.length} research nodes are reachable in principle.`);
console.log(`  Highest env-suit tier reachable: ${suitTier} of 4.`);
console.log('');
console.log('  band        needs   drops');
for (const band of BANDS) {
  const arts = Object.keys(LOOT[band.rewardTier]?.artifacts || {});
  const reach = band.suitTier <= suitTier ? '' : '   UNREACHABLE';
  console.log(
    `  ${band.key.padEnd(10)} suit ${band.suitTier}   ${(arts.join(', ') || '—').padEnd(46)}${reach}`
  );
}

// Every artifact the tree asks for has to drop somewhere reachable.
console.log('');
const wanted = new Set();
for (const node of RESEARCH_LIST) for (const a of Object.keys(node.artifacts)) wanted.add(a);
for (const id of wanted) {
  const src = artifactSource.get(id);
  if (!src) {
    fail(`"${ARTIFACTS[id]?.name || id}" is required by research but drops from no loot table at all`);
  } else if (src.suitTier > suitTier) {
    fail(
      `"${ARTIFACTS[id]?.name || id}" only drops in the ${src.key} band, which needs tier-${src.suitTier} ` +
        `suits — and tier ${src.suitTier} is not reachable`
    );
  }
}

// The bootstrap invariant: an artifact that gates entry to a band must be
// obtainable *below* that band. Otherwise the band gates itself.
for (const node of RESEARCH_LIST) {
  const grants = node.effects?.suitTier;
  if (!grants) continue;
  for (const a of Object.keys(node.artifacts)) {
    const src = artifactSource.get(a);
    if (!src) continue;
    if (src.suitTier >= grants) {
      fail(
        `${node.name} grants tier-${grants} suits but needs "${ARTIFACTS[a]?.name || a}", which only drops ` +
          `in the ${src.key} band at tier ${src.suitTier}. Tier ${grants} suits require tier ${grants} suits.`
      );
    }
  }
}
if (!failures.length) ok('every suit tier can be bootstrapped from the tier below it');

const unreachable = RESEARCH_LIST.filter((n) => !completed.has(n.id));
if (unreachable.length) {
  console.log('');
  console.log('  unreachable nodes');
  for (const n of unreachable) {
    const missReq = n.requires.filter((r) => !completed.has(r));
    const missArt = Object.keys(n.artifacts).filter((a) => !obtainable.has(a));
    const why = [
      missReq.length ? `needs ${missReq.join(', ')}` : null,
      missArt.length ? `no source for ${missArt.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    console.log(`  ${n.id.padEnd(26)} ${why}`);
  }
  fail(`${unreachable.length} research nodes cannot be reached by any player, on any seed`);
} else {
  ok(`all ${RESEARCH_LIST.length} research nodes are reachable`);
}

// Endings. Each one names research it needs; that research has to be reachable.
console.log('');
console.log('  endings');
for (const ending of ENDINGS) {
  // The check functions read state, so pull their research requirements from
  // the source text — brittle-looking, but it means an ending that starts
  // depending on a new node is caught without anyone remembering to say so.
  const needed = [...String(ending.check).matchAll(/completed\.includes\('([a-z0-9_]+)'\)/g)].map((m) => m[1]);
  const blocked = needed.filter((id) => !completed.has(id));
  console.log(`  ${ending.name.padEnd(14)} needs ${needed.join(', ') || '—'}${blocked.length ? '   BLOCKED' : '   reachable'}`);
  if (blocked.length) {
    fail(`the "${ending.name}" ending needs ${blocked.join(', ')}, which no player can research`);
  }
}
if (!failures.length) ok(`all ${ENDINGS.length} endings are reachable in principle`);

console.log('');
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  console.error(`\n  ${failures.length} failure(s)\n`);
  process.exit(1);
}
console.log('  PASS — the game can be finished\n');
