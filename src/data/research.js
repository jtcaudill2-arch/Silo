/**
 * research.js — the tech tree (spec §8).
 *
 * Six branches. The rule that shapes the whole thing: no branch can be
 * completed without expedition-recovered artifacts, and tiers 3-4 of Surface
 * Science and Metallurgy need items found only in deep wasteland ruins or
 * taken from another silo. The tree must pull the player outside.
 *
 * Node schema:
 *   cost      research points
 *   minCycles floor on elapsed time, so a points stockpile can't buy a node
 *             instantly — research is work, not a purchase
 *   requires  prerequisite node ids
 *   artifacts { artifactId: count } consumed on completion
 *   effects   aggregated by sim/research.js into flat modifiers
 */

export const BRANCHES = {
  sustenance: {
    id: 'sustenance',
    name: 'Sustenance',
    short: 'Food',
    glyph: '❦',
    desc: 'Food, water, and the closed loops that keep both from running out.',
  },
  infrastructure: {
    id: 'infrastructure',
    name: 'Infrastructure',
    short: 'Works',
    glyph: '⌗',
    desc: 'Digging deeper, and keeping the lights on once you have.',
  },
  medicine: {
    id: 'medicine',
    name: 'Medicine',
    short: 'Medical',
    glyph: '✚',
    desc: 'Injury, radiation, and the slow argument with mortality.',
  },
  metallurgy: {
    id: 'metallurgy',
    name: 'Metallurgy & Arms',
    short: 'Arms',
    glyph: '⚒',
    desc: 'Alloy, firearms, armour, and the charges that open a sealed door.',
  },
  surface: {
    id: 'surface',
    name: 'Surface Science',
    short: 'Surface',
    glyph: '☀',
    desc: 'Suits, atmosphere, terrain — everything that decides how far you get.',
  },
  governance: {
    id: 'governance',
    name: 'Governance & Signal',
    short: 'Signal',
    glyph: '⌘',
    desc: 'The radio, the archives, and the machinery of holding a silo together.',
  },
};

/** Artifacts recovered from the wasteland. Gates on the deep tree. */
export const ARTIFACTS = {
  intact_servo: { id: 'intact_servo', name: 'Intact Servo', band: 'mid', desc: 'Pre-Collapse actuator, still turning.' },
  sealed_canister: { id: 'sealed_canister', name: 'Sealed Canister', band: 'mid', desc: 'Contents unlabelled. Contents useful.' },
  alloy_ingot: { id: 'alloy_ingot', name: 'Foundry Ingot', band: 'mid', desc: 'An alloy nobody in Silo 12 can reproduce.' },
  optics_array: { id: 'optics_array', name: 'Optics Array', band: 'deep', desc: 'Lenses ground to a tolerance you have no tools for.' },
  reactor_core: { id: 'reactor_core', name: 'Reactor Core Fragment', band: 'deep', desc: 'Hot. Very hot. Worth it.' },
  medical_press: { id: 'medical_press', name: 'Medical Press', band: 'deep', desc: 'Synthesises compounds a chem lab cannot.' },
  suit_weave: { id: 'suit_weave', name: 'Shielded Weave', band: 'mid', desc: 'The reason their suits outlasted yours.' },
  compact_seal: { id: 'compact_seal', name: 'Compact Seal', band: 'approach', desc: 'The document that bound twenty silos, stamped and countersigned.' },
  origin_shard: { id: 'origin_shard', name: 'Origin Shard', band: 'scar', desc: 'It is not a recording. It is an index.' },
};

const N = (def) => ({
  minCycles: 12,
  requires: [],
  artifacts: {},
  effects: {},
  ...def,
});

export const RESEARCH = {
  // ------------------------------------------------------- sustenance ---
  hydroponic_yield_1: N({
    id: 'hydroponic_yield_1', branch: 'sustenance', name: 'Rack Density',
    cost: 55, minCycles: 10,
    effects: { foodYield: 0.15 },
    desc: 'Tighter racking and better lamp spacing. Fifteen percent more out of every bay.',
  }),
  blight_resistance: N({
    id: 'blight_resistance', branch: 'sustenance', name: 'Blight Resistance',
    cost: 130, requires: ['hydroponic_yield_1'],
    effects: { blightResist: 0.5 },
    desc: 'Strain selection. Blight still comes; it takes half as much with it.',
  }),
  food_preservation: N({
    id: 'food_preservation', branch: 'sustenance', name: 'Food Preservation',
    cost: 170, requires: ['hydroponic_yield_1'],
    effects: { foodCap: 400 },
    desc: 'Cold storage and vacuum sealing. A surplus you can actually keep.',
  }),
  protein_vats: N({
    id: 'protein_vats', branch: 'sustenance', name: 'Protein Vats',
    cost: 260, requires: ['blight_resistance'],
    effects: { unlockRoom: ['protein_vats'] },
    desc: 'More calories per watt than anything else in the silo. Nobody likes eating it.',
  }),
  hydroponic_yield_2: N({
    id: 'hydroponic_yield_2', branch: 'sustenance', name: 'Nutrient Cycling',
    cost: 420, requires: ['food_preservation'],
    effects: { foodYield: 0.2, waterYield: 0.1 },
    desc: 'Waste back into the beds. The loop tightens.',
  }),
  closed_loop_agriculture: N({
    id: 'closed_loop_agriculture', branch: 'sustenance', name: 'Closed-Loop Agriculture',
    cost: 950, minCycles: 40, requires: ['hydroponic_yield_2', 'protein_vats'],
    artifacts: { sealed_canister: 2 },
    effects: { foodYield: 0.25, waterYield: 0.2, blightResist: 0.3 },
    desc: 'Nothing leaves the system. Requires seed stock the silo does not have.',
  }),

  // ---------------------------------------------------- infrastructure ---
  deep_excavation_1: N({
    id: 'deep_excavation_1', branch: 'infrastructure', name: 'Deep Excavation I',
    cost: 80, minCycles: 12,
    effects: { unlockTier: ['mids'], unlockRoom: ['laboratory', 'schoolhouse'] },
    desc: 'Opens the Mids: floors twenty-one through forty-eight.',
  }),
  power_efficiency: N({
    id: 'power_efficiency', branch: 'infrastructure', name: 'Load Balancing',
    cost: 140, requires: ['deep_excavation_1'],
    effects: { powerEfficiency: 0.12 },
    desc: 'Every room draws twelve percent less. The cheapest generator you will ever build.',
  }),
  battery_banks: N({
    id: 'battery_banks', branch: 'infrastructure', name: 'Battery Banks',
    cost: 210, requires: ['power_efficiency'],
    effects: { batteryCap: 400, batteryThroughput: 18 },
    desc: 'Ride out a brownout instead of watching the floors go dark one by one.',
  }),
  shoring: N({
    id: 'shoring', branch: 'infrastructure', name: 'Structural Shoring',
    cost: 240, requires: ['deep_excavation_1'],
    effects: { shoringCost: -0.3, collapseResist: 0.6 },
    desc: 'Load-bearing lattice. Below floor thirty-five, unshored rock does not stay rock.',
  }),
  deep_excavation_2: N({
    id: 'deep_excavation_2', branch: 'infrastructure', name: 'Deep Excavation II',
    cost: 380, requires: ['shoring'],
    effects: { unlockTier: ['lowers'], unlockRoom: ['barracks', 'training_yard'] },
    desc: 'Opens the Lowers: manufacturing, armoury, barracks, recycling.',
  }),
  shift_scheduling: N({
    id: 'shift_scheduling', branch: 'infrastructure', name: 'Shift Scheduling',
    cost: 300, requires: ['deep_excavation_1'],
    effects: { shiftRotation: 1 },
    desc: 'Three rotating shifts. Nobody burns out, and nobody is at their post all day either.',
  }),
  // Nothing on the excavation ladder asks for an artifact, and that is a rule
  // rather than an oversight.
  //
  // Going deeper is the one progression in the game the player is supposed to
  // be able to *plan*: it costs research points, shifts, scrap and alloy, all
  // of which a silo can decide to go and get. An artifact cannot be decided
  // on. It falls out of an expedition or a sealed cache, or it does not.
  //
  // This node asked for two intact servos and Shaft Seals asked for two servos
  // and two alloy ingots, and measured over a 900-day autopilot campaign that
  // is where the descent actually stopped: 160 days waiting on the servos and
  // 198 on the ingots, against 31 days of genuinely accumulating the points.
  // Nearly a year of the campaign spent waiting for a die roll in the middle
  // of the one line that is meant to reward deciding.
  //
  // The gates are still expensive — 800 and 1,400 points, thirty and forty
  // shifts — and every floor below them is still bought with scrap, alloy and
  // time. Artifacts keep gating the origin chain and the exotic tech, where
  // waiting on something you can only find is the point of the thing.
  deep_excavation_3: N({
    id: 'deep_excavation_3', branch: 'infrastructure', name: 'Deep Excavation III',
    cost: 800, minCycles: 30, requires: ['deep_excavation_2'],
    effects: { unlockTier: ['deeps'], unlockRoom: ['deep_mine'] },
    desc: 'Opens the Deeps. The boring heads that got this far are all seized.',
  }),
  // The fifth band, on the excavation line rather than the origin chain.
  //
  // The Foundations used to be gated on Origin Systems, which is an endgame
  // node: 2,600 points of its own, behind origin_record's 3,200, behind the
  // artifact that unlocks that. Nearly six thousand points on the ending
  // chain standing between the Deeps and the next twenty levels of the shaft.
  // Measured on the project's own autopilot, that is where the descent went:
  // 373 of 900 days blocked on a research gate, the Foundations opening on
  // day 860, and the Shaft Floor never.
  //
  // This is the same correction Shaft Seals already got one node further
  // down, for the same reason. Origin Systems keeps its `unlockTier` effect,
  // so a silo that goes the origin route still opens the Foundations that
  // way — there are two roads down, and neither one is six thousand points
  // of somebody else's research.
  deep_excavation_4: N({
    id: 'deep_excavation_4', branch: 'infrastructure', name: 'Deep Excavation IV',
    cost: 1200, minCycles: 35, requires: ['deep_excavation_3'],
    effects: { unlockTier: ['foundations'] },
    desc: 'Opens the Foundations. Below this the shaft stops matching the schematics.',
  }),
  reactor_tech: N({
    id: 'reactor_tech', branch: 'infrastructure', name: 'Reactor Containment',
    cost: 1500, minCycles: 48, requires: ['deep_excavation_3', 'battery_banks'],
    artifacts: { reactor_core: 1, optics_array: 1 },
    effects: { unlockRoom: ['reactor'] },
    desc: 'Four times a generator hall, and a failure mode to match.',
  }),

  // -------------------------------------------------------- medicine ---
  antibiotics: N({
    id: 'antibiotics', branch: 'medicine', name: 'Antibiotics',
    cost: 70, minCycles: 10,
    effects: { unlockRoom: ['chem_lab'], healRate: 0.2 },
    desc: 'Chem-lab synthesis. Infection stops being a coin flip.',
  }),
  rad_treatment_1: N({
    id: 'rad_treatment_1', branch: 'medicine', name: 'Chelation Therapy',
    cost: 160, requires: ['antibiotics'],
    effects: { radTreatment: 0.6 },
    desc: 'Pulls the dose back out. Slowly, and it costs meds.',
  }),
  surgery: N({
    id: 'surgery', branch: 'medicine', name: 'Field Surgery',
    cost: 280, requires: ['antibiotics'],
    effects: { healRate: 0.35, injuryDeathResist: 0.4 },
    desc: 'People come back from expeditions in pieces. Now some of them stay back.',
  }),
  rad_treatment_2: N({
    id: 'rad_treatment_2', branch: 'medicine', name: 'Marrow Reconstruction',
    cost: 520, requires: ['rad_treatment_1', 'surgery'],
    effects: { radTreatment: 0.8, radPermanentResist: 0.5 },
    desc: 'Reverses damage that used to be permanent. Most of it.',
  }),
  longevity: N({
    id: 'longevity', branch: 'medicine', name: 'Geriatric Medicine',
    cost: 700, requires: ['surgery'],
    effects: { vitalityDecline: -0.2 },
    desc: 'Vitality falls twenty percent slower. Your best people stay your best people longer.',
  }),
  rad_treatment_3: N({
    id: 'rad_treatment_3', branch: 'medicine', name: 'Cellular Scrubbing',
    cost: 1200, minCycles: 40, requires: ['rad_treatment_2'],
    artifacts: { medical_press: 1 },
    effects: { radTreatment: 1.2, radPermanentResist: 0.85 },
    desc: 'The Scar stops being a one-way trip.',
  }),
  gene_therapy: N({
    id: 'gene_therapy', branch: 'medicine', name: 'Gene Therapy',
    cost: 2100, minCycles: 60, requires: ['rad_treatment_3', 'longevity'],
    artifacts: { medical_press: 2, origin_shard: 1 },
    effects: { vitalityDecline: -0.35, mutationReversal: 1 },
    desc: 'Partial reversal of what the surface did. Partial.',
  }),

  // ------------------------------------------------------ metallurgy ---
  alloy_refining: N({
    id: 'alloy_refining', branch: 'metallurgy', name: 'Alloy Refining',
    cost: 120, minCycles: 12,
    effects: { unlockRoom: ['foundry'] },
    desc: 'Three scrap in, one alloy out. Everything worth carrying starts here.',
  }),
  firearms_1: N({
    id: 'firearms_1', branch: 'metallurgy', name: 'Firearms I',
    cost: 190, requires: ['alloy_refining'],
    effects: { unlockRoom: ['munitions', 'armory'], weaponTier: 1 },
    desc: 'Pipe guns and a munitions line. Better than what the raiders started with.',
  }),
  ballistic_armor_1: N({
    id: 'ballistic_armor_1', branch: 'metallurgy', name: 'Plate Armour',
    cost: 260, requires: ['firearms_1'],
    // armorTier 2, not 1. This node is named "Plate Armour", its description
    // is the Plate Harness's description, and the Plate Harness lists it as
    // the thing that unlocks it — and it granted tier 1, which is the Padded
    // Vest, which needs no research at all. Researching Plate Armour gave you
    // nothing. The same off-by-one ran up the whole ladder: with all 48 nodes
    // complete the Breacher Plate was uncraftable, so a tier-4 armour with a
    // cost, a name and a description was content no player could ever reach.
    effects: { armorTier: 2 },
    desc: 'Salvaged plate on a webbing harness. Heavy, and worth it.',
  }),
  firearms_2: N({
    id: 'firearms_2', branch: 'metallurgy', name: 'Firearms II',
    cost: 400, requires: ['firearms_1'],
    effects: { weaponTier: 2 },
    desc: 'Machined receivers. The first weapons that were designed rather than improvised.',
  }),
  explosives: N({
    id: 'explosives', branch: 'metallurgy', name: 'Explosives',
    cost: 480, requires: ['firearms_2'],
    effects: { explosives: 1, combatBonus: 0.1 },
    desc: 'Demolition charges. Useful in a mine, and in a doorway.',
  }),
  firearms_3: N({
    id: 'firearms_3', branch: 'metallurgy', name: 'Firearms III',
    cost: 900, minCycles: 32, requires: ['firearms_2', 'ballistic_armor_1'],
    artifacts: { alloy_ingot: 2 },
    effects: { weaponTier: 3, armorTier: 3 },
    desc: 'Needs an alloy your foundry cannot make. Somebody out there still can.',
  }),
  // Charges are explosives. `firearms_3` was on this list too, and it was
  // doing gate duty it was never designed for.
  //
  // Measured, three seeds, seven hundred days of competent play: `firearms_3`
  // lands on day 540 and `breaching_charges` lands *never*, on any of them,
  // in campaigns that end between day 676 and day 849. The full closure was
  // 3,450 points and three artifacts, and a conquest is five sorties of
  // six days on top of it — so the one feature the metallurgy line exists
  // to open unlocked at the credits, if at all. The world was not the
  // problem; no high-military silo collapsed in any of those runs. The door
  // was.
  //
  // Off `explosives` alone the chain is firearms_1 -> firearms_2 ->
  // explosives -> here, which is 1,980 points past the node a campaign
  // reaches on day 104. `firearms_3` is still what wins the breach — it is
  // the tier-3 weapon the fight is priced against — it is simply no longer
  // what locks the door. `firearms_4` continues to require both, so the
  // weapons line keeps its order.
  // And no artifacts on it, for the reason the excavation ladder has none —
  // see the note there. Taking a silo is the other progression the player is
  // supposed to be able to *decide* on: it costs points, shifts, suits,
  // supplies and people, all of which a silo can go and get. An artifact
  // cannot be decided on.
  //
  // Measured, three seeds, a player deliberately driving at this and nothing
  // else, before and after re-parenting off `firearms_3`:
  //
  //   with firearms_3    charges on day 443, 602, never
  //   without            charges on day 412, 542, never
  //
  // Thirty to sixty days, and a seed that reached `explosives` on day 117 and
  // then sat for the remaining five hundred and fifty. The chain was never
  // the binding constraint; one alloy ingot and one intact servo were. That
  // is the same die roll in the middle of the same kind of line, and this
  // node is worse than the excavation one was, because a conquest is five
  // sorties of six days *after* the gate opens — so an artifact that
  // arrives late does not delay the reward, it deletes it.
  //
  // Still 1,100 points and thirty-six shifts, still behind Explosives, and
  // every sortie past it still costs suits, supplies and casualties.
  // Artifacts keep gating the origin chain and the exotic tech, where waiting
  // on the wasteland is the point.
  // And it carries `weaponTier: 3`, which is the other half of the same
  // decision and was missed when the door gained a kit requirement.
  //
  // `canLaunchRun` now asks what the breaching party is carrying —
  // `conquest.breachPierce`, 2.5 — and the only thing the benches make that
  // clears it is the Breaching Carbine at 3. That item sat at tier 3 behind
  // `firearms_3`, which is 900 points, `ballistic_armor_1`, and **two alloy
  // ingots off the wasteland**. So the kit requirement quietly put the artifact
  // roll back in front of conquest, in the place this node was re-parented to
  // take it out of: the player reached the charges on schedule, spent two
  // expeditions mapping and undermining a silo, and met a refusal at the door
  // that only a die roll could answer. Measured on seed 0xbeef, that is the
  // whole failure — every time both squads were home with a door open the
  // party averaged 2.0 to 2.3 pierce and nothing on the bench or the rack
  // cleared the gate; seven ladders reached the undermine stage and stopped.
  //
  // The carbine is the door kit. It belongs with the charges, and giving it
  // here keeps the gate's teeth — a party still has to be armed with the thing,
  // roughly 160 alloy and 128 parts across two squads, which is a cost a silo
  // can decide to pay — without making the decision a lottery. `firearms_3`
  // still grants the same tier alongside `armorTier: 3`, so the weapons line
  // keeps its own reason to exist and either route opens the door.
  breaching_charges: N({
    id: 'breaching_charges', branch: 'metallurgy', name: 'Breaching Charges',
    cost: 1100, minCycles: 36, requires: ['explosives'],
    effects: { breaching: 1, weaponTier: 3 },
    desc: 'Opens a sealed silo airlock. There is no other use for this, and everyone knows it.',
  }),
  firearms_4: N({
    id: 'firearms_4', branch: 'metallurgy', name: 'Firearms IV',
    cost: 1900, minCycles: 48, requires: ['firearms_3', 'breaching_charges'],
    artifacts: { optics_array: 2, alloy_ingot: 3 },
    effects: { weaponTier: 4, armorTier: 4 },
    desc: 'Everything the Anvil has, and a little of what the Registry has.',
  }),

  // --------------------------------------------------------- surface ---
  env_suit_1: N({
    id: 'env_suit_1', branch: 'surface', name: 'Env-Suit I',
    cost: 90, minCycles: 10,
    effects: { unlockRoom: ['airlock', 'suit_bay'], suitTier: 1 },
    desc: 'Sealed canvas and a scrubber. An hour outside, maybe two.',
  }),
  atmospheric_analysis: N({
    id: 'atmospheric_analysis', branch: 'surface', name: 'Atmospheric Analysis',
    cost: 150, requires: ['env_suit_1'],
    effects: { radForecast: 1, encounterIntel: 0.2 },
    desc: 'Read the dust before you walk into it. Expeditions stop being blind.',
  }),
  decon_protocols: N({
    id: 'decon_protocols', branch: 'surface', name: 'Decontamination Protocols',
    cost: 230, requires: ['env_suit_1'],
    effects: { deconEfficiency: 0.35, deconFilters: -0.3 },
    desc: 'Faster decon, fewer filters. The difference between a squad and a contamination event.',
  }),
  env_suit_2: N({
    id: 'env_suit_2', branch: 'surface', name: 'Env-Suit II',
    cost: 380, requires: ['decon_protocols'],
    effects: { suitTier: 2 },
    desc: 'Layered shielding. The Mid waste becomes survivable.',
  }),
  terrain_mapping: N({
    id: 'terrain_mapping', branch: 'surface', name: 'Terrain Mapping',
    cost: 520, requires: ['atmospheric_analysis'],
    effects: { mapRange: 1, travelSpeed: 0.2 },
    desc: 'Charted routes. Twenty percent less time in the open.',
  }),
  env_suit_3: N({
    id: 'env_suit_3', branch: 'surface', name: 'Env-Suit III',
    cost: 1000, minCycles: 36, requires: ['env_suit_2', 'terrain_mapping'],
    artifacts: { suit_weave: 2 },
    effects: { suitTier: 3 },
    desc: 'Deep waste and silo approaches. Needs a weave nobody here can spin.',
  }),
  env_suit_4: N({
    id: 'env_suit_4', branch: 'surface', name: 'Env-Suit IV',
    cost: 2000, minCycles: 52, requires: ['env_suit_3'],
    artifacts: { suit_weave: 3, reactor_core: 1 },
    effects: { suitTier: 4 },
    desc: 'The Scar. Twelve days out and back, if the seals hold.',
  }),
  origin_record: N({
    id: 'origin_record', branch: 'surface', name: 'The Origin Record',
    cost: 3200, minCycles: 80, requires: ['env_suit_4', 'pre_collapse_archives'],
    artifacts: { origin_shard: 2, compact_seal: 1 },
    // The Record tells the silo the Foundations are there; Origin Systems is
    // what opens them. Granting the unlock here as well made the node below a
    // 2,600-point no-op — it requires this one, so its only effect was already
    // in hand before it could ever be started.
    effects: { originRecord: 1 },
    endgame: true,
    desc: 'Why the silos were built, who built them, and what the Compact was actually protecting.',
  }),
  origin_systems: N({
    id: 'origin_systems', branch: 'surface', name: 'Origin Systems',
    cost: 2600, minCycles: 60, requires: ['origin_record'],
    effects: { unlockTier: ['foundations'] },
    endgame: true,
    desc: 'The Foundations were never on the schematics you were given.',
  }),
  // The sixth band, and the fourth of the excavation line rather than a fifth
  // link on the origin chain.
  //
  // It was written as requiring Origin Systems, which put it behind
  // origin_record (3200) and origin_systems (2600) as well as its own 1400 —
  // seven thousand two hundred points in sequence, after everything else in
  // the tree. A
  // broadly-played silo opened the Foundations on day 703 of 900 and never
  // reached the Shaft Floor at all, which makes the deepest twenty levels
  // scenery.
  //
  // It does not need that chain to keep its place in the order. The descent is
  // sequential: level 125 is unreachable until the twenty Foundation levels
  // above it are open, and those *are* gated on Origin Systems. The rock
  // enforces the sequence, so the research only has to be hard.
  shaft_seals: N({
    id: 'shaft_seals', branch: 'infrastructure', name: 'Shaft Seals',
    cost: 1400, minCycles: 40, requires: ['deep_excavation_4'],
    effects: { unlockTier: ['shaft'] },
    desc: 'The last twenty levels were sealed from underneath. Nobody wrote down why.',
  }),

  // ------------------------------------------------------ governance ---
  radio_range_1: N({
    id: 'radio_range_1', branch: 'governance', name: 'Radio Range I',
    cost: 75, minCycles: 10,
    effects: { unlockRoom: ['radio_room'], radioTier: 1 },
    desc: 'Silo 12 has been listening for two generations. Now you can transmit.',
  }),
  treaty_law: N({
    id: 'treaty_law', branch: 'governance', name: 'Treaty Law',
    cost: 180, requires: ['radio_range_1'],
    effects: { treatyStrength: 0.25, tradeBonus: 0.15 },
    desc: 'The Compact was written by somebody. Read what they actually wrote.',
  }),
  propaganda: N({
    id: 'propaganda', branch: 'governance', name: 'Public Broadcast',
    cost: 220, requires: ['radio_range_1'],
    effects: { unlockPolicy: ['propaganda'], orderBonus: 0.1 },
    desc: 'The silo hears what you decide it hears.',
  }),
  radio_range_2: N({
    id: 'radio_range_2', branch: 'governance', name: 'Radio Range II',
    cost: 340, requires: ['treaty_law'],
    effects: { radioTier: 2 },
    desc: 'Reaches past the near cluster. Twelve silos, not six.',
  }),
  informant_networks: N({
    id: 'informant_networks', branch: 'governance', name: 'Informant Networks',
    cost: 420, requires: ['propaganda'],
    effects: { unlockPolicy: ['informants'], detectDissidents: 1 },
    desc: 'You will find out who the dissidents are. They will find out you were looking.',
  }),
  encryption: N({
    id: 'encryption', branch: 'governance', name: 'Signal Encryption',
    cost: 560, requires: ['radio_range_2'],
    effects: { intelResist: 0.6, encryption: 1 },
    desc: 'Verrick sells your position to whoever is paying. Not any more.',
  }),
  radio_range_3: N({
    id: 'radio_range_3', branch: 'governance', name: 'Radio Range III',
    cost: 900, minCycles: 32, requires: ['encryption'],
    artifacts: { optics_array: 1 },
    effects: { radioTier: 3 },
    desc: 'All nineteen. Including the one that never answers.',
  }),
  pre_collapse_archives: N({
    id: 'pre_collapse_archives', branch: 'governance', name: 'Pre-Collapse Archives',
    cost: 1400, minCycles: 44, requires: ['radio_range_3'],
    artifacts: { compact_seal: 1, optics_array: 1 },
    effects: { unlockRoom: ['archive'], unlockPolicy: ['open_archives'], researchSpeed: 0.15 },
    desc: 'Most of it is unreadable. Most.',
  }),
};

export const RESEARCH_LIST = Object.values(RESEARCH);

export function getResearch(id) {
  return RESEARCH[id] || null;
}

export function branchNodes(branchId) {
  return RESEARCH_LIST.filter((n) => n.branch === branchId);
}

/**
 * Depth of a node in its branch, for laying the graph out in columns.
 * Computed once and memoised — the tree never changes at runtime.
 */
const depthCache = new Map();
export function nodeDepth(id, seen = new Set()) {
  if (depthCache.has(id)) return depthCache.get(id);
  const node = RESEARCH[id];
  if (!node || !node.requires.length) {
    depthCache.set(id, 0);
    return 0;
  }
  if (seen.has(id)) return 0; // cycle guard; the tree shouldn't have any
  seen.add(id);
  const d = 1 + Math.max(...node.requires.map((r) => nodeDepth(r, seen)));
  depthCache.set(id, d);
  return d;
}

export default RESEARCH;
