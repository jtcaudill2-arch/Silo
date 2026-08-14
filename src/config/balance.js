/**
 * balance.js — EVERY tunable number in Deepwater.
 *
 * Rule from the spec: zero magic numbers in sim code. If a number changes how
 * the game plays, it lives here. Sim modules import BAL and read from it.
 *
 * Organised by system so a balance pass can be done section by section.
 */

export const BAL = {
  // ---------------------------------------------------------------- meta ---
  meta: {
    // NOTE: schema version lives in core/migrations.js, not here.
    defaultSeed: 0x5110c12,
    saveSlots: 3,
    autosaveEveryTicks: 30,
    logMaxEntries: 600,
  },

  // ---------------------------------------------------------------- time ---
  time: {
    TICK_MS: 1000, // 1 real second
    // Every production and consumption rate in this file is per *day*, divided
    // down by CYCLES_PER_DAY — so this number sets how much real time you get
    // to react in, and changes no balance at all. It was 60 (an 8-minute day),
    // which meant a shift resolved while you were still reading the last one.
    TICKS_PER_CYCLE: 90, // 1 cycle  = 1 shift  = 90 seconds real
    CYCLES_PER_DAY: 8, // 1 day    = 12 minutes real
    DAYS_PER_YEAR: 12, // 1 year   = ~2.4 hours real
    maxCyclesPerFrame: 300, // accumulator drain cap before spilling to catch-up
    worldTickEveryDays: 1,
    diplomacyTickEveryDays: 3,
  },

  // ------------------------------------------------------------- catchup ---
  catchup: {
    fullFidelityMs: 5 * 60 * 1000, // <= 5 min: replay cycle by cycle
    capMs: 12 * 60 * 60 * 1000, // > 12 h: simulate 12 h only
    maxFullFidelityCycles: 400, // hard safety on the fine path
  },

  // ----------------------------------------------------------------- silo ---
  silo: {
    // The silo is 144 levels. All of them exist from the first morning and all
    // of them are drawn — the point of the number is the scale of what is under
    // you, not how much of it you can currently open.
    totalFloors: 144,
    // How far down the stair goes. The bands now cover all 144, so this is the
    // whole silo — it stays a separate number because it is the guard that
    // stops `tierForFloor`'s out-of-range fallback (the *first* tier) from
    // quietly pricing the bottom of the silo like the top.
    reachableFloors: 144,
    slotsPerFloor: 6,
    // Six: the five the starting rooms occupy, and one spare to build the
    // first thing into. It was fourteen, which handed the player nine empty
    // floors on the first morning — enough room for everything the early game
    // asks for, so the silo could be played for hours without ever digging,
    // and digging read as a chore rather than as how the silo grows. Six makes
    // the first excavation an early decision with a price on it, and every one
    // after that a larger one.
    startExcavatedFloors: 6,
    // Six bands across 144. Five stretched over that depth would put thirty
    // levels behind each gate, which is a long time between arrivals — the
    // bands are what make going down feel like getting somewhere, so there is
    // one more of them and none is longer than twenty-eight levels.
    tiers: [
      { key: 'upper', name: 'Upper', from: 1, to: 20, gate: null },
      { key: 'mids', name: 'Mids', from: 21, to: 48, gate: 'deep_excavation_1' },
      { key: 'lowers', name: 'Lowers', from: 49, to: 76, gate: 'deep_excavation_2' },
      { key: 'deeps', name: 'Deeps', from: 77, to: 104, gate: 'deep_excavation_3' },
      { key: 'foundations', name: 'Foundations', from: 105, to: 124, gate: 'deep_excavation_4' },
      { key: 'shaft', name: 'Shaft Floor', from: 125, to: 144, gate: 'shaft_seals' },
    ],
    excavation: {
      baseScrap: 40,
      // Labour is dig time and nothing else — `shortfall` skips it and the
      // cost line never prints it, so this constant sets how many shifts a
      // floor takes and touches no other price in the game.
      //
      // It was 30, which put 409 days of pure digging between the top of the
      // silo and the bottom of the shaft: floor 110 was four and a half days
      // with the crew committed, floor 143 was nine. Even a silo that was
      // never once blocked on money, alloy or research could not reach the
      // Shaft Floor inside a 900-day campaign, which made the deepest twenty
      // levels — and the Reactor and the Deep Bench standing on them —
      // scenery. Measured against the same autopilot, digging was only 26% of
      // where the descent's time actually went, so this is a real cut and not
      // the whole answer; the research ladder above was the larger half.
      //
      // At 18 the same descent is 245 days of digging, the bottom floor is
      // five and a half days rather than nine, and the shape is untouched: a
      // floor still costs more time than the one above it and a tier boundary
      // is still a step.
      baseLabor: 18,
      // Per floor of absolute depth, so the cost only ever rises — see
      // excavationCost() for what resetting it per tier did.
      //
      // Scrap deliberately is NOT what gates the bottom of the silo. At 1.03
      // over 144 levels the last floor costs 12,287 scrap against a store that
      // caps at 900, or 1,400 with depots: the player would spend the last
      // third of the game unable to hold the price of a single level, which is
      // not difficulty, it is a wait. At 1.012 the bottom floor is about a
      // thousand — one full store, bankable in a few days at a decent salvage
      // rate — and the depth is paid for in the two currencies below instead.
      growth: 1.012,
      // The step on crossing into a new tier, on top of the depth growth. Each
      // boundary is also a research gate, so this is what makes the first
      // floor of the Mids feel like arriving somewhere rather than like the
      // next floor of the Uppers.
      tierMultiplier: 1.35,
      // Time is the first of the two real costs. Labour scales on the same
      // curve, so a shallow floor is a few shifts and a floor in the Shaft
      // Floor is over a week of game time with the crew committed to it.
      maxDigCycles: 120,
      ticksPerLaborHour: 1,
      shoringRequiredBelowFloor: 35,
      // Alloy is the second, and the one that bites. It was a flat 6 a floor,
      // which is a rounding error by the time a silo is deep enough to need
      // it. It now scales with the same tier step, so the deep bands cost
      // twenty to thirty alloy a level — and alloy is the same resource the
      // surface chain wants for suits. A silo cannot outfit a squad and drive
      // for the bottom at the same time, which is the decision the descent was
      // missing.
      shoringAlloyPerFloor: 6,
    },
    // What it costs to keep the deep, rather than to reach it.
    //
    // Until this existed the bottom of the silo was dangerous for exactly one
    // day — the day the seal came off — and safe for ever after. A player who
    // survived the dig owned the floor outright, which made a hundred and
    // forty-four levels a list of things you had done rather than a place you
    // were holding.
    //
    // The rock does not stop. Below the shoring line every floor works against
    // its own supports, and what it works against them with is the weight you
    // put on it: an empty level holds itself indefinitely and is not tracked
    // at all, and a level carrying six bays of machinery is the one that needs
    // watching. That is deliberate — the danger should be proportional to what
    // the player decided to put down there, so the Reactor on floor 136 is a
    // commitment to floor 136 and not just a good afternoon.
    strain: {
      // The base rate the load factor below multiplies, at the first strained
      // tier and with the shoring intact. Everything else multiplies this.
      //
      // Sized against the levels it is meant to bite. A fully built floor runs
      // down in about 140 days in the Foundations, 104 on the Shaft Floor and
      // 345 in the Mids — so the top of the strained range is a formality and
      // the bottom is a standing commitment. Two bays on a deep floor last
      // about 390 days, which is the point: holding less costs less.
      decayPerDayPerSlot: 0.13,
      // A floor in use carries a burden of its own, before anything is counted
      // by the bay: it is lit, it has people walking it, and it is being held
      // open. Empty floors are still skipped entirely, so this is not a tax on
      // depth — it is the difference between a level the silo uses and one it
      // merely owns.
      //
      // It is here because the first cut was purely per-slot, and measured
      // against a real campaign that made the whole system inert: a played
      // silo does not build six bays on floor 108, it restores the one room
      // the dig turned up there. Nine hundred days, twelve loaded deep floors,
      // not one warning and not one collapse. A mechanic the player never
      // meets is a mechanic that does not exist, so a lightly used deep floor
      // now drifts to the warning line in a couple of hundred days rather than
      // a couple of thousand. A fully built one moves too, but barely: its load
      // factor goes from 6.0 to 1.5 + 6x0.85 = 6.6, a tenth faster.
      occupiedFloorBase: 1.5,
      perSlot: 0.85,
      // The tier step, same shape as the dig price. Depth is the difficulty
      // dial everywhere else in the descent; it would be strange here alone
      // for the Foundations to strain like the Mids.
      tierMultiplier: 1.35,
      // What intact shoring buys. Large, because shoring is the whole lever:
      // a floor whose supports have gone runs down four times as fast, which
      // turns a collapse into a countdown rather than a coin toss.
      shoredMultiplier: 0.25,
      // The floor starts saying so. At the fastest strain in the game — six
      // bays on the Shaft Floor, shoring intact — a sound floor reaches this
      // line after about 47 days, and from here the player has 26 days before
      // the structure starts eating the rooms and 57 before the floor gives.
      // If the shoring has already failed those become 6 and 14: that is what
      // makes re-shoring urgent rather than merely advisable.
      warnBelow: 55,
      // Below this the structure starts working on the rooms themselves,
      // scaling to `roomWearPerDay` as integrity reaches zero. A floor eating
      // its own machinery is the last warning before it goes.
      strainBelow: 30,
      roomWearPerDay: 1.2,
      // At zero the floor gives way: the shoring is gone, everything standing
      // on it is breached, and some of the crew do not get clear.
      crewLostChance: 0.35,
      // Re-shoring an open floor. Alloy on top of the dig's own shoring bill,
      // because this is the same job done again in a working silo with rooms
      // in the way, plus the scrap for the timber and plate.
      reshoreAlloyMultiplier: 1.5,
      reshoreScrapPerFloor: 40,
    },
    merge: {
      maxWidth: 3,
      efficiencyPerStep: 0.15, // +15% output per merge step
      powerDiscountPerStep: 0.12, // -12% power draw per merge step
    },
    condition: {
      start: 100,
      decayPerCycleWorking: 0.055,
      decayPerCycleIdle: 0.012,
      penaltyBelow: 40, // output penalty starts scaling below this
      failAt: 0,
      breachChancePerDayAtZero: 0.06,
      maintenanceRestorePerCyclePerCrew: 2.6,
      maintenanceTargets: 6, // how many of the worst rooms a crew covers
    },
    repair: {
      // Fraction of the room's build cost charged to restore it fully. Always
      // cheaper than rebuilding, and scales with the room's value.
      //
      // 0.55 until the pricing helper was corrected. That correction was right
      // — repair is a share of `buildCost x width`, which is what building
      // really costs — but it raised every merged room's bill by 1.5x to 3x,
      // and the four tuning passes before it had all been measured on top of
      // the broken cheap version. A reviewer isolated the change over eight
      // seeds of 900 days: campaigns reaching an ending fell from seven in
      // eight to five, banked scrap at day 900 fell 37%, dig-days blocked on
      // resources roughly doubled, and days unable to afford a restore went
      // from 171 to 707.
      //
      // So the ratio stays honest and the constant comes down to meet it. At
      // 0.40 a full restore is 40% of a real rebuild — still the clearly better
      // deal it is meant to be, with the bills about a quarter under where the
      // correction put them. It also restores the margin the suite lost: the
      // deepest found level was sitting at 49.52% against a 50% ceiling.
      fractionOfBuildCost: 0.40,
    },
    upgrade: {
      maxLevel: 5,
      scrapBase: 60,
      scrapGrowth: 1.7,
      chitsBase: 25,
      chitsGrowth: 1.6,
      downtimeCycles: 6,
      outputPerLevel: 0.35, // +35% of base output per level above 1
      staffSlotsPerLevel: [1, 1, 2, 2, 3], // index = level-1
    },
  },

  // ------------------------------------------------------------ resources ---
  resources: {
    // Starting stockpiles for a new game.
    start: {
      power: 0,
      water: 400,
      food: 520,
      meds: 60,
      scrap: 700,
      // Enough alloy to actually open the door with. Nothing in the silo
      // makes alloy until the Foundry, the Foundry needs alloy_refining, and
      // at forty-four residents that node lands around day 125 — so whatever
      // is in the store on the first morning is the whole budget until then.
      // The surface chain costs 14 for the Airlock, 18 for the Suit Bay and
      // 6 a suit for a four-person squad: 56 before anybody steps outside.
      // At 40 the arithmetic simply did not close, and it failed in the least
      // legible way possible — the airlock and the suit bay both went up, the
      // squad formed, and then four people stood in a finished suit bay for
      // sixty days while the alloy dribbled in two at a time. 90 pays for the
      // chain, the squad and one replacement suit, and no more: a second
      // squad or a tier-2 suit still waits on a Foundry.
      alloy: 90,
      ammo: 120,
      chits: 250,
      filters: 40,
      parts: 60,
      fuel: 260,
      ore: 0,
      coolant: 0,
    },
    baseCaps: {
      power: 200, // battery capacity; power is mostly flow, not stock
      water: 800,
      food: 900,
      meds: 200,
      scrap: 900,
      alloy: 300,
      ammo: 600,
      chits: Infinity,
      filters: 250,
      parts: 300,
      fuel: 700,
      ore: 400,
      coolant: 200,
    },
    depotCapBonus: {
      water: 400,
      food: 500,
      scrap: 500,
      alloy: 200,
      ammo: 300,
      meds: 120,
      filters: 150,
      parts: 200,
      fuel: 350,
      ore: 250,
      coolant: 120,
    },
    perCitizen: {
      foodPerDay: 1.0,
      waterPerDay: 1.2,
      airLoadPerCitizen: 1.0,
    },
    // Shortage consequences, applied per game day.
    shortage: {
      starvation: { healthPerDay: -8, orderPerDay: -5, moralePerDay: -6 },
      dehydration: { healthPerDay: -11, orderPerDay: -4, moralePerDay: -5 },
      noMeds: { injuryHealMult: 0.15, radPermanentChance: 0.5 },
      brownoutMoralePerDay: -2,
    },
  },

  // ------------------------------------------------- what is behind the door ---
  // Opening a sealed floor used to produce the same sentence every time, which
  // made digging a purchase rather than a decision. These are the two things
  // depth now buys: more worth finding, and more that can go wrong. Each array
  // is indexed by tier — [Uppers, Mids, Lowers, Deeps, Foundations, Shaft Floor].
  // Six entries, one per band: these are read as `array[tierIndex]`, so a
  // five-entry array does not clamp, it returns undefined and poisons the
  // arithmetic with NaN the moment a silo opens level 125.
  excavationFinds: {
    // Scrap from an untouched storeroom (parts come out at a sixth of it).
    // The Uppers were lived in and stripped; the Foundations were not.
    storesPerTier: [70, 130, 210, 320, 460, 620],
    // A half-flooded level, which is water the reclaimers did not have to make.
    cisternPerTier: [60, 110, 170, 230, 300, 360],
    // Alloy from a sealed cache. Nothing else in the early silo makes alloy,
    // so this is the reason to go down before the Foundry exists.
    cacheAlloyPerTier: [0, 14, 26, 40, 58, 80],
    // Chance a cache also holds something the Laboratory can work on. The
    // research tree turns artifact-gated below the Mids, and this is the
    // second source besides the surface — a silo that never digs and never
    // opens its airlock cannot finish the tree at all.
    artifactChance: 0.45,
    // Condition taken off a room on the floor above when a seal gives way.
    collapseConditionPerTier: [12, 20, 30, 40, 52, 68],
    // Air quality lost when whatever was sealed in there is still leaking.
    contaminationAirPerTier: [4, 8, 13, 18, 24, 32],
    // What the alloy spent on shoring actually buys: collapses become roughly
    // a third as likely. Below `shoringRequiredBelowFloor` the dig is charged
    // for it whether or not the player thinks about it, so the premium is
    // visible in the cost and the payout is visible here.
    shoredCollapseMultiplier: 0.35,
  },

  // ------------------------------------------------------------------ air ---
  air: {
    start: 92,
    max: 100,
    min: 0,
    // Air quality drifts toward capacity/load ratio each cycle.
    driftPerCycle: 0.9,
    healthDecayBelow: 60,
    healthDecayPerDay: -4,
    massCasualtyBelow: 30,
    massCasualtyChancePerDay: 0.05,
    massCasualtyFraction: 0.04,
    // A filtration bay's filter draw is *not* here. It is
    // `air_filtration.consumes.filters` in src/data/rooms.js, alongside the
    // power the same bay draws, because the economy charges every room's
    // upkeep from its own definition and never asks this file about it. There
    // was a `filterConsumptionPerBayPerCycle: 0.05` sitting in this block that
    // nothing had ever read; two comments elsewhere then cited it as the knob,
    // which is how a dead number becomes a wrong one. Deleted rather than
    // wired up: one room type consuming one resource is room data, and putting
    // it here would mean the same figure in two places.
  },

  // --------------------------------------------------------------- power ---
  power: {
    // Brownout: rooms shut off from the bottom of the priority list up.
    brownoutMoraleHit: -2,
    batteryDischargePerCycle: 12,
    batteryChargePerCycle: 8,
    defaultPriority: [
      // What gets switched off when the lights start to go, bottom first.
      // This list has exactly one job now. It used to have two — it was also
      // the order posts were *crewed* in, because jobs.js read it — and the
      // Laboratory's position was a compromise between them: high enough that
      // somebody would eventually be posted to a bench, low enough that the
      // cafeteria and the clinic did not lose their crews to it. Crewing has
      // its own list in `jobs.staffingPriority` now, so neither half of that
      // trade has to be paid any more and this one can be read as what it
      // says: shed order, and nothing else.
      //
      // Life support, then generation, then *income*. Recycling and the
      // Workshop sit this high because they are the way out of a brownout,
      // not a luxury to be shed during one: they were tenth and ninth, below
      // the residences and the cafeteria, which produced a spiral with no
      // exit — demand passes generation, the salvage plants are the first
      // things cut, scrap income stops, and the Generator Hall that would end
      // it can never be afforded. An obedient player sat on "Build a Generator
      // Hall" for 49 days and starved with the answer written on the screen.
      //
      // So the Laboratory moves back down the shed order — nineteenth as the
      // list now stands: below the surface
      // chain, above the sheriff, the barracks, the yard and the archive.
      // That is where it belongs on the only question this list still answers.
      // A shift of lost bench time costs points; everything above it costs
      // water, air, food, income, medicine, or the door to the surface.
      //
      // The move is free, and that is worth recording because the last pass
      // could not have known it. Swept over twelve seeds at 300 days with the
      // Laboratory at twelfth, seventeenth and twenty-second, research lands
      // at 157 nodes at all three — the position does not decide whether the
      // tree moves at all. The reason is in the same runs: the Laboratory is
      // dark on 98%, 99% and 100% of brownout cycles respectively, because a
      // real brownout is short of far more than one room's six power and sheds
      // it wherever it sits. What decided research was never the shed rank.
      // It was whether anybody was standing in the room, and that is now
      // `jobs.staffingPriority`'s question to answer.
      'water_reclaimer',
      'air_filtration',
      'hydroponics',
      'generator_hall',
      'reactor',
      // Part of the plant, not a customer of it. The Heat Exchange is the only
      // source of the coolant the Reactor burns, so shedding it to keep the
      // Reactor lit starves the Reactor a shift later — the same shape as
      // cutting the salvage plants to survive a brownout and then never being
      // able to afford the Generator Hall that would end it.
      'heat_exchange',
      'recycling',
      'workshop',
      // Ninth, and it was nowhere at all: `maintenance_bay` was the one room
      // type of twenty-nine missing from this list, and `defaultRank()` gives
      // anything unlisted 999 against a list that sorts ascending — so the only
      // room in the silo that restores condition was the *first* thing shed in
      // every brownout ever run. That is the exact crisis it exists for: a
      // brownout is the plant at its limit, the plant at its limit is the
      // generator hall wearing out fastest, and a room that reaches zero
      // condition stops. Shedding the repair crew to save three power — the
      // smallest draw of anything below life support — buys one cycle and
      // costs the hall.
      //
      // Here rather than higher because it is a rate, not a floor: the bay
      // restores condition over shifts, so one dark shift is recoverable in a
      // way that a dark reclaimer is not. Here rather than lower because
      // everything under it is comfort, security or storage, and none of those
      // keep the generation running.
      'maintenance_bay',
      'residences',
      'clinic',
      'cafeteria',
      'chem_lab',
      'foundry',
      'munitions',
      'storage_depot',
      'suit_bay',
      'airlock',
      'laboratory',
      'sheriffs_office',
      'holding_cells',
      'barracks',
      'training_yard',
      'armory',
      'schoolhouse',
      'radio_room',
      'archive',
      'protein_vats',
      'deep_mine',
    ],
  },

  // ------------------------------------------------------------ citizens ---
  citizens: {
    // How likely each skill is to be somebody's speciality.
    //
    // It used to be a flat `rng.sample(SKILLS, 1..2)` — every skill equally
    // likely — against demand that is nothing like flat. When this table was
    // written, engineering was wanted by eight room types and combat by one,
    // and the opening forty-four came out with three engineers and two
    // mechanics against fifteen farmers and nine soldiers. Recycling, the
    // Workshop, the Foundry, the Heat Exchange, the Suit Bay, the Armory,
    // Munitions and the Deep Mine were all in one queue and it simply ran out
    // of people: over 300 days the Suit Bay was built on day 79 and ran on
    // none of the 222 days it stood there, and the Armory was dark for 225 of
    // 265. Promoting either up the crewing order moved nothing, because there
    // was nobody to promote — which is the tell that a shortage is in the
    // population and not in the ordering.
    //
    // The catalogue has moved since, and these weights have not been re-derived
    // from it, so what the counts are *now* is worth writing down: engineering
    // 5 and mechanics 5, admin 4, combat 3, farming 3, medicine 2, science 2.
    // Engineering shed three — both weapons benches went to combat crews and
    // the Suit Bay turned out to need no crew at all — which is why engineering
    // is weighted well above its five rooms and combat above its three. Both
    // are still where the demand is; if the catalogue moves again, re-measure
    // before trusting the ratio.
    //
    // Two deliberate departures from a straight room count, both about what a
    // skill unlocks rather than how many rooms want it.
    //
    // Combat staffs three rooms, but it also fills every squad and every
    // expedition, and the people outside are not available to work — so it is
    // weighted to a fifth of the population rather than the seventh a flat roll
    // gave it. Measured on the way down: at 3.5 it fell to a ninth, squads went
    // into the same fights weaker, and battles ran nine rounds against a
    // readable limit of eight. The point of this table is to stop starving
    // engineering, not to start starving anything else.
    //
    // Science is wanted by two, and sits level with mechanics anyway, because
    // the Laboratory is the one bench the entire research tree runs through.
    // This is measured, not asserted: the first cut of these weights set
    // science at 3 and the opening silo came out with one or two scientists,
    // which slowed the research spine enough to push the Surface panel — the
    // hinge of the early game — out to day 65 on one of the three unlock
    // seeds. Nothing else in the game makes a research point, so a shortage
    // there is not one system running slowly, it is all of them.
    skillWeights: {
      engineering: 8,
      mechanics: 5,
      science: 5,
      admin: 4,
      combat: 7,
      farming: 3,
      medicine: 3,
    },
    // A silo you can hold in your head. 180 was the full-strength population
    // and it needed eight staffed rooms on the first morning just to stand
    // still, which is most of the game's systems running before the player has
    // met any of them. Starting small turns the climb back to a full silo into
    // the arc rather than the prologue.
    //
    // Not *too* small, though. Room output scales by the fraction of its posts
    // that are crewed, so a population that cannot staff the rooms it builds
    // browns out rather than growing: at 28 the generator ran half-crewed at
    // 35 of a possible 70 power, which unpowered the recycling, which stopped
    // the scrap income, which meant no second generator could ever be
    // afforded. 44 crews the opening five rooms and the three a player adds
    // next, with people spare.
    startPopulation: 44,
    // The harness's control silo has slack in every direction and about thirty
    // staff posts to fill. Crewing that from a 28-person opening is what a
    // *failing* silo looks like, not a sufficient one — every room runs part-
    // staffed, output scales by the staffed fraction, and generation falls
    // under the draw. The control keeps a workforce that can actually run it.
    sufficientPopulation: 120,
    statMin: 1,
    statMax: 10,
    birthStatRoll: { min: 2, max: 6 },
    skillMax: 100,
    skillGrowthBase: 0.4,
    skillGrowthIntDivisor: 20, // + int/20 per game day
    skillDiminishingAbove: 70,
    skillDiminishingMult: 0.4,
    schoolGrowthMult: 2.2,
    schoolMinAge: 6,
    schoolMaxAge: 17,
    // What a soldier gains in combat skill per day under Hard School, before
    // the node's own multiplier. At 1.6 that is 0.6 x this a day: about nine
    // points over two hundred days, which turns a fresh recruit into somebody
    // worth standing next to over the course of a campaign without ever
    // reaching what a career veteran starts with.
    soldierSkillPerDay: 0.08,
    workingAgeMin: 16,
    // The chance each day that grief lifts. At 0.012 the median is about
    // fifty-eight days and the tail runs past two hundred, which is what
    // "it will pass, or it will not" should feel like — and it stops the
    // trait accreting across the whole silo, which is what it did when
    // nothing removed it at all.
    griefPassChance: 0.012,
    workingAgeMax: 999,

    vitality: {
      flatUntilAge: 40,
      declineStartAge: 40,
      declinePerYearEarly: 1.5, // 40 -> 60
      declineSteepAge: 60,
      declinePerYearLate: 4.0,
      childRampAge: 18, // below this, vitality ramps up with age
      childMin: 45,
    },
    death: {
      vitalityThreshold: 30,
      divisor: 400, // P = (30 - vitality) / 400 per game day
      healthFactor: 0.9, // low health multiplies death chance
      radiationFactor: 1.6,
      clinicMitigationPerLevel: 0.12,
    },
    health: {
      start: 100,
      max: 100,
      regenPerDayFed: 1.6,
      regenClinicPerLevel: 1.1,
      injuryFloor: 5,
      deathAtZero: true,
    },
    morale: {
      start: 62,
      max: 100,
      min: 0,
      driftToward: 55, // baseline morale gravity
      driftRate: 0.35,
      cafeteriaBonusPerLevel: 0.6, // morale/day per level
      overcrowdPenaltyPerOver: 0.25,
      idlePenaltyPerDay: -1.2,
      overworkPenaltyPerDay: -3,
      overworkHealthPerDay: -1,
      overworkShiftThreshold: 6,
      friendDeathHit: -12,
      acquaintanceDeathHit: -4,
    },
    radiation: {
      max: 100,
      sicknessThreshold: 45,
      sicknessHealthPerDay: -3,
      cancerThreshold: 70,
      cancerChancePerDay: 0.012,
      clinicTreatPerDayPerLevel: 0.9,
      medsPerRadPoint: 0.35,
    },
    birth: {
      minAge: 18,
      maxAge: 45,
      relationshipThreshold: 60,
      requiredOrder: 40,
      // Days of food in the larder before anybody starts a family. Per
      // head, deliberately: the old rule wanted 40 units of surplus in
      // absolute terms, which a silo of two hundred and a silo of two
      // thousand both satisfy from a full larder — so it read like a brake
      // and was nothing of the kind. Because the food cap only rises when
      // you build depots, this makes storage the real ceiling on population
      // and makes growing the silo a decision rather than a certainty.
      foodDaysRequired: 4,
      // Free beds at which the birth rate is at full strength. Below this
      // it tapers to nothing rather than switching off at exactly zero, so
      // a silo slows as it fills instead of running flat into the wall.
      roomyBeds: 14,
      gestationDays: 12, // ~1 game year
      // Growth is the arc now. The opening is a quarter of the silo it used
      // to be, and everything downstream — labs staffed, squads fielded, the
      // research tree, the surface — is priced in absolute numbers, so at the
      // old 0.022 a 44-person silo reached 92 in 300 days and simply never
      // got there: 7 nodes of the tree and no expedition ever launched.
      //
      // 0.045 overcorrected, and the reason is that a birth is not a worker
      // for sixteen years, which at twelve days to the year is 192 days —
      // more than half the length of the pacing run. At that rate the silo
      // doubled every ~125 days, so it outran its own nursery: measured, the
      // working fraction fell from 80% on the first morning to 26–34% and
      // stayed there, and because auto-assign only posts people who have no
      // job, the silo ran at zero spare labour permanently. Population 357 by
      // day 400 with 116 adults in it — every extra birth was a mouth, a bed
      // and an air load, and no pair of hands inside the campaign. The rooms
      // at the bottom of the crewing order paid for it: 7 research nodes at
      // day 300 against 20 at this rate.
      //
      // 0.030 keeps the climb — 44 to ~525 over 700 days, still the arc —
      // while growth stays slower than maturation, so the working fraction
      // holds around 40% mid-campaign instead of collapsing. Measured across
      // 0.028/0.030/0.032 the silo survives 700 days at all three with 37–42
      // nodes and 73–76 expeditions, which is a plateau rather than a knife
      // edge. The food-days rule and the bed taper above still throttle it,
      // so this is a ceiling on pace, not a guarantee of it.
      chancePerDayPerCouple: 0.030,
      housingRequired: true,
    },
    relationships: {
      min: -100,
      max: 100,
      sameRoomGrowthPerDay: 1.1,
      cafeteriaGrowthPerDay: 0.5,
      randomPairsPerDay: 6,
      // Neighbours. Without these the only bond in the silo is a shift
      // roster, which makes every unemployed citizen socially inert and
      // pins the birth rate to the job count instead of the headcount —
      // a silo of four hundred then produces exactly as many couples as a
      // silo of two hundred, and the population curve flattens. The groups
      // are stable, so the same faces recur and a bond can actually climb;
      // random strangers across four hundred people never meet twice.
      neighbourhoodSize: 6,
      neighbourGrowthPerDay: 0.8,
      friendThreshold: 55,
      rivalThreshold: -45,
      decayPerDay: 0.05,
    },
    housing: {
      slotsPerResidenceLevel: 6,
      overcrowdOrderPerOver: 0.35,
    },
  },

  // ------------------------------------------------------------ traits ---
  traits: {
    // chance a newborn / recruit rolls a trait at all
    rollChance: 0.42,
    maxAtBirth: 2,
  },

  // -------------------------------------------------------------- jobs ---
  jobs: {
    matchedSkillOutput: 1.0,
    mismatchedOutput: 0.4,
    skillOutputCurve: 0.55, // output = base * (0.45 + skill/100 * curve_scale)
    skillOutputFloor: 0.45,
    vitalityWeight: 1.0,
    healthWeight: 1.0,
    moraleWeight: 0.35, // morale contributes this fraction of output swing
    idleFoodMult: 1.0,
    idleDissentPerCitizenPerDay: 0.012,
    shiftsPerDay: 8,
    restShiftsRequired: 2,

    // ---- crewing order ---------------------------------------------------
    // Who gets posted where, when there is somebody spare to post. This was
    // `power.defaultPriority` until now, which is the order rooms are *shed*
    // in during a brownout — a different question with a different answer.
    // You cut the Laboratory before the water plant; you do not crew the
    // water plant's twelfth post before the Laboratory's first.
    //
    // The order below is "what stops if nobody is standing here":
    //  - Water, food and power first. Nothing else is a question until these
    //    are answered.
    //  - Recycling above Air Filtration, which looks wrong and is not. A
    //    filtration bay with no crew still delivers 55% of its capacity
    //    (economy.js pays uncrewed passive provision at that rate), so the
    //    first mechanic posted to one buys 45% of a bay. The first engineer
    //    posted to a recycling plant buys 100% of the scrap and fuel it
    //    makes, and the fuel is what the generators burn.
    //  - The Laboratory eighth, above every comfort and every military room.
    //    Nothing else in the game makes a research point; power_efficiency,
    //    the yields, decon and all four suit tiers are behind one. Under the
    //    old shared list it was twenty-second, then twelfth, and at neither
    //    position did a small silo reliably get anybody into it — measured,
    //    one scientist at day 275 and nobody through most of the two hundreds.
    //  - Then the surface chain, then order, comms and schooling, then the
    //    rooms whose absence costs nothing this month.
    staffingPriority: [
      'water_reclaimer',
      'hydroponics',
      'generator_hall',
      'reactor',
      'recycling',
      'air_filtration',
      'workshop',
      'laboratory',
      // The Foundry, on exactly the argument that put the Laboratory above it.
      // Nothing else in the game *makes* alloy. Sealed caches and surface
      // salvage turn some up, which is what carries a silo before the first
      // Foundry, but neither is something a player can plan around: the
      // Foundry is the only tap you can open. Two whole progressions run
      // through it: every floor below the shoring line is bought with it, and
      // so is every tier of env-suit. It sat thirteenth, below the canteen and
      // the maintenance bench, which meant the one room that unlocks both
      // halves of the late game was the first bench to stand empty whenever
      // people were short.
      //
      // Measured over a 900-day campaign: the Foundry existed for 821 days and
      // was uncrewed for 277 of them — a third of its life — while the silo
      // spent 221 days unable to afford the alloy a floor costs to shore — 8
      // in the Mids rising to 27 on the Shaft Floor.
      // Not a supply problem. The same run finished with 3,119 alloy banked
      // and 9,309 smelted; it was starved in the middle and drowning at the
      // end, because the bench only got people once everything else had them.
      'foundry',
      // Immediately below it, and for the same reason one step further on:
      // nothing else makes coolant, and an uncrewed Heat Exchange is a dark
      // Reactor, which is four generator halls' worth of power standing still.
      'heat_exchange',
      'chem_lab',
      // Ammunition, on the same argument as the three rooms above it: nothing
      // else in the game makes any at a rate that matters, and every
      // expedition the silo will ever run carries two rounds per person per
      // day. Only what is fired is spent — the rest comes home — but a squad
      // that meets something spends it all. At sixteenth it was built on day 134 and then
      // crewed on two of the next 167 days, which is a room the silo paid 280
      // scrap and 16 alloy for and never once used.
      'munitions',
      'clinic',
      'maintenance_bay',
      'cafeteria',
      // No 'suit_bay'. It has no `staff` block — see the note on the room —
      // and `openSlots` skips anything without one, so a rank for it is never
      // read. A dead entry in a hand-ordered list reads as a decision.
      'armory',
      'sheriffs_office',
      'radio_room',
      'schoolhouse',
      'training_yard',
      'archive',
      'deep_mine',
      'protein_vats',
      'holding_cells',
    ],
    // How many places down the list a room slides for each post it has
    // already filled. Output scales with the crewed fraction and a room at
    // zero crew produces nothing at all, so the first post of an important
    // room is worth more than the fourth post of a slightly more important
    // one — but not infinitely more, which is what a pure breadth-first fill
    // assumes. At 0 this is the old behaviour: saturate each room in list
    // order before starting the next.
    //
    // Swept 0 / 2 / 3 / 4 / 5 / 6 / 8 / 12 over twelve seeds at 300 days.
    // Deaths ran 1 / 2 / 0 / 0 / 1 / 0 / 0 / 3 and research nodes across the
    // twelve silos 154 / 153 / 157 / 164 / 155 / 160 / 168 / 147, so anything
    // from 3 to 8 is a plateau and the two ends are not. Three rather than
    // the middle of that plateau, because the fragile silo in this suite is
    // not the average one: the obedient player keeps no reserve, and when its
    // standing order becomes a repair it cannot pay for it stops doing
    // anything else at all until it can. That silo lives or dies on whether
    // it happens to have twenty parts banked on the wrong morning. Of four
    // candidate crewing orders it survives 200 days at 3 under every one of
    // them, and is a coin toss at every other value tried.
    staffingDepthPenalty: 3,
  },

  // ---------------------------------------------------------- research ---
  research: {
    // Research throughput is per *lab*, and the number of labs a silo can
    // staff is a function of its population — so cutting the opening from 180
    // people to 44 cut research by roughly the same factor, against a 48-node
    // tree whose costs were set against the large silo. A broadly-played silo
    // reached 6 nodes in 300 days, which makes most of the tree scenery. This
    // buys that back per bench rather than by re-pricing 48 hand-tuned nodes;
    // the expensive nodes at the bottom of the tree (2100–3200) are what
    // absorb the throughput of a silo that has grown back to full strength.
    //
    // 1.5 was not enough, and the reason is that a *bench* is not a lab. A
    // laboratory only ever runs at the fraction of its two posts that are
    // crewed, and at the time this was measured auto-assign filled posts in
    // power-priority order, where the laboratory was twenty-second — so the
    // small silo ran its one lab at a capability of 0.25–0.5 for most of the
    // first two hundred days, not 1. (Crewing has its own list now,
    // `jobs.staffingPriority`, and the laboratory is eighth on it, so the
    // premise behind this figure is gone even though the figure is not: a lab
    // still only runs at the fraction of its posts a small silo can spare, and
    // 2.4 is what makes the tree move at that. It has not been re-swept
    // against the new crewing order.) Measured at 1.5: nine nodes by day 300 and a whole hundred
    // days, day 175 to day 275, in which the tree did not move at all. At 2.4
    // the same run reaches fourteen by day 300 and thirty-eight by day 700,
    // which is a tree the player can see the shape of. It is deliberately not
    // enough to outrun the artifact gates: eleven of the forty-eight nodes
    // still need something carried in from the surface, and
    // no amount of bench time substitutes for opening the airlock.
    pointsPerLabPerCycleBase: 2.4,
    scientistSkillWeight: 0.9,
    archiveBonus: 0.25,
    openArchivesBonus: 0.2,
    maxQueue: 5,
  },

  // ------------------------------------------------------------- order ---
  order: {
    start: 64,
    max: 100,
    min: 0,
    driftToward: 50,
    // The line below which the Order figure is drawn as a warning rather than
    // as normal. It sits under `driftToward`, so reaching it means the silo is
    // genuinely losing its grip rather than merely drifting: deaths,
    // overcrowding, idle hands, an execution.
    //
    // It lived in the `unlocks` block, as the level that opened the Order
    // panel. That gate was rewritten to read only things the reducers
    // increment — a gate under the drift attractor opened the panel and then
    // closed it again two days later — which left this number with no reader
    // at all, while `ui/panels/policy.js` had grown its own inline `45`
    // alongside it. One number, two homes, neither of them right.
    warnBelow: 45,
    driftRate: 0.25,
    kiaPenalty: -3,
    birthBonus: 1.5,
    executionPenalty: -6,
    victoryBonus: 4,
    tradeBonus: 1,
    surplusFoodBonus: 0.8,
    sheriffBonusPerLevel: 1.6,
    deputyBonus: 0.7,
    dissidentMultiplier: 1.35,
    uprisingThreshold: 25,
    uprisingConsecutiveDays: 3,
    uprisingChancePerDay: 0.34,
    maxPoliciesBase: 2,
    policyPerAdminSkill: 40, // 2 + floor(adminSkill / 40)
    crime: {
      baseChancePerDay: 0.05,
      orderScaling: 0.9, // lower order -> more crime
      curfewMult: 0.5,
      theftFraction: 0.05,
      sabotageConditionHit: -45,
      investigationDays: 3,
      wrongVerdictOrder: -8,
      rightVerdictOrder: 5,
      // Evidence points at the culprit on average and at an innocent often
      // enough that a verdict is a real decision, not a formality.
      evidenceSignal: 0.5,
      evidenceNoise: 0.38,
      evidencePerDeputy: 0.05,
    },
  },

  // -------------------------------------------------------- directives ---
  // The standing order — one line, derived from state every shift, in
  // `sim/directives.js`. That module ranks every applicable order by weight
  // and shows the highest. The bands are:
  //
  //   97    somebody is at the airlock and there is one day to answer
  //   88-95 a hard stop already reached, or a floor about to come down
  //   50-95 something is trending to zero, sooner is higher
  //   85-   a room about to fail, 85 minus its condition
  //   76-79 no income at all of a resource every room is built from, with the
  //         first Laboratory at the bottom of the band
  //   74-75 income of one that exists but is running short
  //   72    rooms standing empty, which is free output being thrown away
  //   62    a Laboratory with nothing on the bench
  //   51-55 the surface chain
  //   40    a seized room waiting to be restored
  //   <40   growth
  //
  // Each individual order's rank is written where the order is, because the
  // ranking *is* that module's design and reads better beside the sentence it
  // decides. What lives here are the shared numbers — the ones that shape more
  // than one order, or that decide whether an order is issued at all.
  directives: {
    // Above everything, including a resource that runs out today.
    //
    // A shortage is a curve — it has been getting worse for days and it will
    // keep getting worse for days — and the player can act on it tomorrow.
    // A raid is a cliff with a date on it: one day to answer, no partial
    // credit, and the answer is a different panel from anything else in this
    // list. It is also the only order that expires whether or not it is
    // obeyed, which is exactly the kind of thing a single-line thread has to
    // put first or not bother showing at all.
    raidTop: 97,
    // A holding sliding toward revolt. Below life support on purpose: losing
    // one is expensive and survivable, and an order about a silo six days'
    // walk away must not outrank the scrubbers. Above the income band,
    // because a month of a garrison's output is worth more than a Workshop.
    satelliteTop: 80,
    // How far down the slide the warning starts. `conqueredStartOrder` is 62
    // and `revoltOrderThreshold` is 20, so 45 gives about eighteen days'
    // notice at `satelliteDecayPerDay` — long enough to form and post a
    // squad, short enough that a warmed, contented holding never nags.
    satelliteWarnOrder: 45,
    // The top of the life-support band: a resource that runs out today.
    lifeSupportTop: 95,
    // How a falling resource's urgency decays with its runway.
    //
    // It used to be `95 - min(days, 15)`, which clamped: a silo 424 days from
    // running out of food ranked exactly as urgent as one 15 days from it, at
    // 80, and 80 outranks the Laboratory at 76 for ever. Measured directly —
    // the return report read "Food +73" and the standing order simultaneously
    // read "Build a Hydroponics Bay — Food is falling — it runs out in about
    // 424 days at the current rate." A silo can carry a slow leak for a year
    // and never once be told to build the one room that makes research points,
    // which stalls the whole unlock spine (see sim/unlocks.js — Research is
    // gated on a Laboratory existing).
    //
    // So the near end of the curve is left exactly as it was — 0 days is 95,
    // 15 days is 80, the tuned part nothing was wrong with — and beyond the
    // horizon it keeps falling, linearly, to a floor. At 120 days it is 50:
    // still ahead of digging (30) and of a third Laboratory (15), behind the
    // surface chain (53-55), and behind the first Laboratory (76) from about
    // 29 days of runway on. Which is the crossover being asked for: under a
    // month of food left, fix the food; a season of it, build the lab.
    runwayHorizonDays: 15,
    runwayTailDays: 120,
    runwayFloor: 50,
    // A life-support surplus thinner than this fraction of current draw is
    // treated as a problem you can still build your way out of, rather than
    // one you can't.
    thinMargin: 0.35,
    // The top of the margin band. Above "no income" (76-79) — running out of
    // food outranks being poor — and below a line that is already falling.
    marginTop: 79,
    // How far an income order climbs above its own rank as income approaches
    // nothing. The income orders sat flat at 75 and 74 whatever the figure was,
    // which is fine at nine tenths of target and wrong at a sixteenth of it: a
    // silo earning 0.4 scrap a shift against a target of 6.5 is not slightly
    // poor, it is unable to act on any order it will ever be given, and every
    // other order it takes instead makes that worse.
    //
    // Measured on the knife-edge it decides. Two obedient silos, same seed,
    // differing only in how often the player acted: at three actions a day the
    // treasury crossed 130 while "Build another Recycling plant" (75) sat one
    // place above "Build another Hydroponics Bay" (76 at that margin), income
    // went 0.5 -> 2.9 -> 4.0 -> 6.9 over the next twenty days and the silo was
    // solvent for good. At eight actions a day the food margin was a hair
    // tighter, the bay ranked 77, the silo bought the bay instead — and spent
    // the following hundred and sixty days at 0.1 scrap a shift, never able to
    // afford anything again, and suffocated on day 181. Scaling the income
    // order by how far under target it is settles that the same way both times.
    incomeUrgencyRange: 4,
    // How far an order sinks when the silo cannot currently pay for it.
    //
    // A standing order you cannot carry out is worse than no order at all: it
    // is the game asking for something it will not let you do, and a player who
    // trusts it simply waits. Measured, that is fatal — the order read "Build a
    // Hydroponics Bay" for twenty consecutive days at forty scrap short while
    // eighty people died of thirst, because the water reclaimer never got a
    // turn to be suggested. An unaffordable order still appears when nothing
    // else is possible, and then its reason says what the silo is short of.
    //
    // Large enough to sink the most urgent blocked order below the cheapest
    // affordable one.
    unaffordablePenalty: 40,
    // Saving up is only advice while it is a plan that finishes. Past this many
    // days from affording the thing the silo most needs, at the income it
    // actually has, the honest order is to go and fix the income instead —
    // that is what the promoted salvage order is for.
    //
    // Ten days rather than five: the alternative to holding is spending, and
    // spending is what the treadmill was made of. A silo four or five days from
    // a Generator Hall that is told to buy a salvage plant instead is a silo
    // that is never *not* four or five days from a Generator Hall.
    holdHorizonDays: 10,
    // What a savings plan is not allowed to defer. While the silo is saving
    // for something it cannot yet afford, no *less* urgent building order may
    // spend the reserve — that alternation was the treadmill. But an order in
    // the life-support band that the silo can pay for today is never worth
    // deferring for one it cannot, so this is the line the lockout stops at.
    holdYieldsAbove: 80,
    // Restoring a room a dig turned up. Above digging (30), because a level
    // you have already opened and not used is worth more than the next one
    // down; below every order about something the silo needs today, because a
    // seized room that stays seized costs nothing. Ranking it by condition
    // like an ordinary repair put it in the eighties and had obedient silos
    // buying schoolhouses instead of laboratories.
    restoreFound: 40,
    // The top of the shoring band, minus the floor's remaining integrity. A
    // fresh warning at 55 lands on 33 — just above digging, which is exactly
    // the trade being offered: hold what you have before you open more. A
    // floor at 5 lands on 83, above everything but life support.
    shoreTop: 88,
  },

  // ---------------------------------------------------------- military ---
  military: {
    squadMin: 4,
    squadMax: 8,
    maxSquads: 6,
    trainingSkillPerDay: 1.5,
    trainingAmmoPerDay: 2,
    // The combat skill at which a garrison stops being four people standing in
    // a corridor. Below it, `directives.js` raises a standing order to train,
    // because nothing else in the game ever mentions that the Training Yard or
    // the training assignment exist — measured, a 223-person silo fifty
    // expeditions deep had exactly one person above 40.
    //
    // 40 rather than a rounder number because it is where the raid table above
    // starts to bend: it is roughly the skill at which four defenders on home
    // ground stop losing to Dust Runners, which is the second of the four
    // bands and the first one a peaceful silo is likely to meet. Reaching it
    // from a green squad is about twenty days of training at 1.5 a day, which
    // is a real commitment of ammunition and of four people who are then not
    // outside earning.
    trainedEnough: 40,
    barracksFoodPerSoldierPerDay: 0.4,
    garrisonOrderBonusPerSquad: 2.5,
    readinessWeights: { training: 0.3, equipment: 0.3, health: 0.2, morale: 0.1, ammo: 0.1 },
    stipendChitsPerSoldierPerDay: 0.5,
  },

  // -------------------------------------------------------------- gear ---
  gear: {
    durabilityMax: 100,
    // Charged per surviving member per fight, from `applyResolution`. This sat
    // here read by nothing for the project's whole history — `GEAR_WEAR` had a
    // reducer and no dispatcher — so every weapon in every campaign finished
    // at 100 and the Armory's repair loop never ran. Measured at 6: five
    // unrepaired fights cost 16 points against a Warband at the door. See the
    // table in combat.js.
    durabilityLossPerCombat: 6,
    // STILL READ BY NOTHING, and left that way on purpose rather than wired
    // in the same pass. Per-combat wear alone already takes a weapon down 30
    // points across a five-floor hold, and a second, unmeasured source on top
    // of it would make the balance question "is gear wear right?" impossible
    // to answer — two variables, one measurement. Wire it, or delete it, but
    // do it against its own numbers.
    durabilityLossPerExpeditionDay: 1.5,
    repairPerCyclePerQuartermaster: 2.2,
    repairScrapPerPoint: 0.35,
    suit: {
      integrityMax: 100,
      repairAlloyPerPoint: 0.2,
      repairPartsPerPoint: 0.1,
      // `degradePerHourOutside` was one array doing two jobs — the dose
      // multiplier and the integrity burn — for four suits. Both now live on
      // the item, as `stats.shielding` and `stats.wear`, at the same values
      // the array held. Splitting them is what lets the Registry Skin be a
      // better suit: dose already clamps at 100 on every band a tier-4 suit
      // can reach, so a suit that only shielded better would be a stat the
      // player cannot see.
      //
      // What fraction of an hour outside actually lands on the seals. This was
      // an inline 0.35 in expedition.js and a second inline 0.35 in
      // conquest.js — two copies of one tunable, in a project whose rule is
      // that every tunable lives here. Both now read this.
      wearHoursFraction: 0.35,
      degradePerCombatHit: 5,
      breachRadPerHour: 12,
      breachHealthPerHour: 1.5,
    },
  },

  // -------------------------------------------------------- expeditions ---
  expedition: {
    hoursPerDay: 24,
    decon: {
      shiftsPerMember: 1,
      // Filters to hose down one returning body. The Chem Lab is the only
      // thing in the silo that makes filter media, and it makes 0.6 a shift
      // against an air plant that burns 0.05 a shift per filtration bay — both
      // figures from the room definitions in src/data/rooms.js, which is where
      // a room's own upkeep lives — so a silo large enough to need six bays and
      // small enough to staff exactly one Chem Lab is running 0.6 against 0.3,
      // a two-to-one surplus on paper. On paper is the whole of it: the Chem
      // Lab is 13th in `power.defaultPriority` and 11th in
      // `jobs.staffingPriority`, so it is among the first rooms a silo at the
      // edge of its generation stops running, and the airlock burns another
      // 0.05 a shift on top. At 2 a head a four-person decon cost 8 filters,
      // and measured, the squad was suited, armed and standing at the airlock
      // from day 172 and did not get through it until day 284. 1 halves the fare without
      // making decon free — it is still the reason a Chem Lab is on the
      // critical path, and skipping it still spreads the dose through the
      // whole silo.
      filtersPerMember: 1,
      radRemovedFraction: 0.75,
      skipRadSpreadFraction: 0.3, // fraction of squad rad pushed into the silo
      skipOrderPenalty: -4,
    },
    supplies: {
      foodPerMemberPerDay: 1.4,
      waterPerMemberPerDay: 1.6,
      medsPerMemberPerDay: 0.2,
      ammoPerMemberPerDay: 2,
    },
    bands: [
      {
        key: 'near',
        name: 'Near ruins',
        travelDays: 1,
        radPerHour: 2,
        rewardTier: 1,
        suitTier: 1,
        encounterWeightShift: 0,
      },
      {
        key: 'mid',
        name: 'Mid waste',
        travelDays: 3,
        travelDaysMin: 2,
        radPerHour: 5,
        rewardTier: 2,
        suitTier: 2,
        encounterWeightShift: 1,
      },
      {
        key: 'deep',
        name: 'Deep waste',
        travelDays: 5,
        travelDaysMin: 4,
        radPerHour: 9,
        rewardTier: 3,
        suitTier: 3,
        encounterWeightShift: 2,
      },
      {
        key: 'approach',
        name: 'Silo approach',
        travelDays: 6,
        travelDaysMin: 5,
        radPerHour: 7,
        rewardTier: 3,
        suitTier: 3,
        encounterWeightShift: 2,
      },
      {
        key: 'scar',
        name: 'The Scar',
        travelDays: 10,
        travelDaysMin: 8,
        radPerHour: 15,
        rewardTier: 4,
        suitTier: 4,
        encounterWeightShift: 3,
      },
    ],
    encountersPerTravelDay: 1,
    survivorRecruitChance: 0.55,
    survivorRadRange: [5, 45],
    survivorDissidentChance: 0.18,
  },

  // ----------------------------------------------------------- mutation ---
  mutation: {
    levels: [1.0, 1.35, 1.8],
    // level chance shifts with distance band + total elapsed days
    baseWeights: [0.72, 0.22, 0.06],
    bandShift: 0.09, // per band index, moves weight to higher levels
    dayShiftPer100Days: 0.11,
    modifiers: [
      { key: 'irradiated', name: 'Irradiated', radOnHit: 4 },
      { key: 'carapaced', name: 'Carapaced', incomingMult: 0.7 },
      { key: 'frenzied', name: 'Frenzied', damageMult: 1.5, healthMult: 0.7 },
    ],
    modifierChance: 0.35,
  },

  // ------------------------------------------------------------ combat ---
  combat: {
    weights: { str: 0.3, agi: 0.2, combat: 0.5 },
    // What a weapon tier used to be worth, and what a tier of armour used to
    // add, both now live on the item: `items[].stats.power` and
    // `items[].stats.dr`. The crafted four carry exactly the numbers that were
    // here — [1.0, 1.4, 1.9, 2.5] and 1 + tier * 0.12 — so nothing tuned
    // against them moved. A tier is a rank; a stat is a trade-off, and the
    // looted kit needed to be able to say "harder-hitting and hungrier",
    // which one array indexed by tier cannot.
    //
    // What is left here is the one case with no item to hang it on.
    unarmedPower: 0.8, // bare hands, and a weapon nobody has heard of
    // Party size at or below which Spearhead pays. `squadMin` is 4, so this
    // is "a squad at its smallest" — a player who takes Spearhead is choosing
    // to run under-strength on purpose, and paying for it in headcount at the
    // door.
    // Commending a soldier: what it costs and what it gives.
    //
    // The tree has seven slots and a fixed total price of 142, so a silo that
    // plays well runs out of things to buy with about a third of the campaign
    // left — measured, the best seeds earn 285 and can spend 142, and the
    // Scar, the ground that pays four a run, opens *after* most seeds have
    // already filled the tree. The richest ground in the game was paying in a
    // currency that had stopped meaning anything.
    //
    // This is the sink, and it is the thematically exact one: a commendation
    // is a thing you give a soldier. It also answers a real gap — nothing else
    // in the game makes anyone better at fighting, and a militia's mean combat
    // skill *falls* across a campaign because recruits arrive worse than the
    // veterans they replace. Turnover never stops, so neither does the sink.
    commendCost: 8,
    commendSkill: 3,
    spearheadMaxParty: 4,
    ammoFactorFull: 1.0,
    ammoFactorEmpty: 0.45,
    moraleModBase: 0.8,
    moraleModRange: 0.4,
    sizeModPerLog2: 0.08,
    ambushSwing: 0.25,
    terrainSwing: 0.15,
    suitIntegrityMin: 0.7,
    rollMean: 1.0,
    rollSd: 0.14,
    rollClamp: [0.6, 1.5],
    leaderChaDivisor: 50,
    leaderCombatDivisor: 100,
    raiderFleeLossFraction: 0.4,
    outcomes: [
      { min: 2.0, key: 'decisive', name: 'Decisive victory', cas: [0.0, 0.05], loot: 1.3, win: true },
      { min: 1.4, key: 'victory', name: 'Victory', cas: [0.08, 0.18], loot: 1.0, win: true },
      { min: 1.1, key: 'costly', name: 'Costly victory', cas: [0.2, 0.35], loot: 0.8, win: true },
      { min: 0.9, key: 'stalemate', name: 'Stalemate', cas: [0.15, 0.3], loot: 0.2, win: false },
      { min: 0.6, key: 'defeat', name: 'Defeat', cas: [0.35, 0.6], loot: 0, win: false, gearLost: true },
      { min: -Infinity, key: 'rout', name: 'Rout', cas: [0.6, 0.9], loot: 0, win: false, gearLost: true, captureRisk: 0.25 },
    ],
    injury: {
      survivorHealthLoss: [8, 34],
      permanentTraitChance: 0.16,
      permanentTraits: ['crippled', 'scarred', 'shellshocked'],
    },
    casualtyWeightExponent: 1.6, // weak members die first, inversely to unitPower
  },

  // ------------------------------------------------------------- world ---
  world: {
    daysPerTick: 1,
    populationDriftDivisor: 100, // (economy - military*0.3) / 100
    militaryDriftWeight: 0.3,
    stabilityDrift: 0.06,
    collapseAtStability: 0,
    collapseRefugeeChance: 0.45,
    collapseRaiderHostChance: 0.3,
    warChancePerDayPerPair: 0.0016,
    warStabilityDrain: 1.2,
    warMilitaryDrain: 0.8,
    radioIntelChancePerDay: 0.3,
  },

  // -------------------------------------------------------- diplomacy ---
  diplomacy: {
    evaluateEveryDays: 3,
    reputationWeight: 0.6,
    offerWeight: 120, // how much a generous offer is worth in accept-score
    offerFloor: 25, // stops tiny asks producing enormous ratios
    needDiscount: 0.4, // offering what they need is worth up to 40% more
    fearBonus: 25,
    aggressionPenaltyWeight: 40,
    honestyWeight: 8,
    paranoiaWeight: 40,
    memoryDecayPer10Days: 1,

    // ---- who comes for you, and why ----
    //
    // See the note in sim/diplomacy.js. Only two silos of twenty have the
    // aggression to raid at all — The Anvil (0.95) and Gallow Deep (0.7) —
    // which is deliberate: being raided should mean something specific about
    // your neighbours, not be weather.
    raidAggression: 0.6,
    // The grudge path. Was -40, which measured unreachable: a 400-day
    // campaign left the worst reputation in the world at -15, and 300 days of
    // deliberately antagonising The Anvil reached -23. -20 is inside what a
    // player who declares war (-50 at once) or keeps getting caught scouting
    // (-12 a time) can actually reach.
    raidGrudgeReputation: -20,
    // The opportunity path, against `playerPower`. Economy is rooms x 2.2
    // capped at 100, so 40 is a silo of about eighteen rooms — established,
    // visibly worth the walk.
    //
    // Military is `soldiers x 4 + weaponTier x 8`. The threshold was 20
    // first, and measured that never fired: an autopilot silo forms one squad
    // early and sits at 24 for the rest of the campaign, so it read as
    // "defended" for ever on the strength of four people with pipe guns.
    // Against a Warband that is not a garrison, it is a rounding error. 40 is
    // roughly two crewed squads, or one with researched weapons — the point
    // at which a raider would genuinely go and look at somebody else.
    //
    // Both halves have to hold. A poor silo is not worth robbing and a
    // defended one is somebody else's problem, and that conjunction is what
    // makes standing a squad down a decision rather than a default.
    raidTemptEconomy: 40,
    raidTemptMilitary: 40,
    // Per aggressive silo per diplomacy tick, once the condition holds. Note
    // *per tick*, not per day: `simulateTick` returns early unless
    // `evaluateEveryDays` have passed, so a per-day reading of these numbers
    // overstates them threefold.
    //
    // Set from measured campaigns, and the measurement had to be a *whole*
    // campaign. Tuned on a 400-day window these read 0.10 / 0.06 and looked
    // right — 4 and 8 raids, a standing squad worth keeping. Run to an ending
    // at 900 days the same numbers compounded to 26 raids on one seed, a raid
    // every 35 days, and cost the campaign its depth: raids take scrap, parts
    // and alloy, which are exactly what the descent is bought with, and the
    // silo that dug all 144 floors without them stopped at 124 with them.
    //
    //   opportunity   raids (two seeds)   floors reached
    //   0.06           4 and 26           124 and 124
    //   0.03           1 and 17           136 and 144
    //   0.02           1 and 11           136 and 144
    //
    // Those four rows were measured while the trigger still sat inside the
    // contact-gated loop in diplomacy.js, which suppressed 84% of it. With
    // the raid pass lifted out of that gate the same 0.02 reads 4 and 11
    // raids and 144 floors on both seeds — more raids and *more* depth, which
    // is the gate having been the thing distorting it rather than the rate.
    // The rate was left at 0.02: it is the one that was chosen against the
    // depth measurement, and the depth is now comfortably intact.
    //
    // 0.02 is the rate that leaves the bottom of the silo reachable. The gap
    // between the two seeds is the world, not the dice: a silo whose
    // aggressive neighbours collapse early is genuinely safer than one next
    // to a living Anvil, and flattening that would make the world table say
    // less than it does now.
    raidChanceGrudge: 0.035,
    raidChanceOpportunity: 0.02,
    memoryFloorFraction: 0.15, // never fully forgets
    thresholds: {
      merchant: 12,
      technocrat: 22,
      isolationist: 40,
      warlord: 40,
      agrarian: 6,
      opportunist: 16,
      archivist: 44,
      theocratic: 34,
      democratic: 18,
      nomadic: 12,
      militarized: 30,
      slaver: 18,
      fractured: 12,
      scientific: 16,
      industrial: 24,
      unknown: 95,
    },
    allyCallToArmsRefusalRep: -40,
    allyCallToArmsBroadcastRep: -10,
    treatyBreakRep: -35,
    giftRepPerValue: 0.05,
    tradeRepPerDeal: 2,
    radioRangeTiers: [6, 12, 19], // how many silos each radio tier can reach
  },

  // ---------------------------------------------------------- alerts ---
  alerts: {
    // Things whose exhaustion kills people, watched by days-of-runway rather
    // than by level — a full tank with a negative flow reads as safe and is
    // not, and by the time the number visibly moves there are days left.
    runwayWatch: ['water', 'food', 'fuel'],
    runwayWarnDays: 8,
    runwayCriticalDays: 3,
    // A room wears out silently and then stops, and if it was the generator
    // hall the whole silo stops with it — production ends, the tanks drain in
    // three days, and the first the log says about it is "has failed
    // completely", which by then is an obituary rather than a warning.
    conditionWarnAt: 35,
    conditionCriticalAt: 18,
    // Salvage throughput the silo should be running, per hundred residents.
    // Scrap is the universal currency — rooms, repairs and excavation are all
    // priced in it — so a silo whose income is below this cannot act on its
    // own advice, and every order it is given is one it cannot pay for.
    // There is a floor as well as a rate. Costs are not proportional to
    // population — a Generator Hall is 180 scrap whether forty people or four
    // hundred need it — so a purely per-head target reads "income is fine" in
    // a small silo that in fact cannot afford a single room. At forty-four
    // residents the old figure asked for 2 scrap a shift, which is eleven days
    // of total income per generator; the standing order sat on "Build a
    // Generator Hall" for 49 days running and never once became payable. These
    // match the thresholds the autopilot uses, which is the heuristic that
    // survives 200 days.
    scrapBasePerCycle: 5,
    scrapPerCyclePerHundred: 3.3,
    partsBasePerCycle: 1.5,
    partsPerCyclePerHundred: 0.6,
    // Labs bank points whether or not anything is being researched, and the
    // only signal was a badge on a nav button that looks the same on day one
    // as on day two hundred. A silo can run a staffed laboratory for most of
    // a year and complete nothing.
    idleResearchDays: 4,
  },

  // ------------------------------------------------------------ raid ---
  //
  // What happens when somebody comes to *you*. Until this existed the world
  // could put a raiding party on the airlock, write a line in the log, and
  // then do nothing at all: `PENDING_RAID` wrote `world.pendingRaid` and
  // nothing in the game ever read it. The coaching line in shell.js said
  // "Squads defend the silo; without one, the raid takes what it wants",
  // which was the clearest statement of a mechanic this game did not have.
  //
  // It is the only fight the player does not choose. Everything else in the
  // military layer is opt-in — you decide to open the airlock — so this is
  // what makes an Armory worth building for a reason other than leaving.
  raid: {
    // The beat between the alert and the assault. One day, so the warning is
    // a warning rather than a result: long enough to recall nobody (a squad
    // outside is days away and stays outside, which is the point) and long
    // enough for the player to see the alert before the outcome lands.
    graceDays: 1,
    // Defending ground you know, into combat's `terrainSwing`. +1 is the top
    // of that scale, and a silo corridor against people who have never seen
    // the inside of it is as one-sided as terrain gets in this game.
    homeTerrain: 1,
    // Raiders come as one of the four human bands in data/encounters.js,
    // picked by the strength the world event carried. `strength` is the
    // attacker's `power.military / 100`, so Silo 5 — The Anvil, at military
    // 95 — sends a warband and a scavenger silo sends scrappers.
    bandByStrength: [0.25, 0.45, 0.7],
    // A raiding party is a detachment, not an army. This started at 1.4 — on
    // the reasoning that a raid is everything a silo can spare — and that was
    // backwards twice over: the wasteland bands are already sized as roving
    // forces met in the open (a Warband is sixteen bodies with vehicles and
    // 960 power), and scaling one *up* produced a fight with no answer.
    // Measured at 1.4, a Warband raid was 0 wins in 40 at every squad size
    // and gear tier tested, losing five people each time. A raid that cannot
    // be defended is the same failure as a raid that does nothing; it just
    // fails in the other direction, and it makes a liar of the coaching line
    // that says squads defend the silo.
    //
    // 0.5, measured the same way — 40 seeds a cell, defenders on home ground:
    //
    //                    4 def T1   6 def T1   8 def T3   6 def T3
    //   Scrappers          40W        40W        40W        40W
    //   Dust Runners       23W        36W        40W        40W
    //   The Slag Crews      2W         9W        40W        38W
    //   Warband             0W         0W        27W        17W
    //
    // Every band has an answer and none of them has the same answer. Pipe
    // guns turn back scrappers and nothing else; the Slag Crews are what
    // makes the Armory's tier-3 kit worth building; a Warband off The Anvil
    // is survivable only by a silo that kept a full, well-armed squad at home
    // on purpose. Two of the twenty silos can send one, which is what the
    // `raidAggression` note above this block says and what the code does:
    // `aggression > 0.6` admits only The Anvil (0.95) and Gallow Deep (0.7).
    // This used to read "three — The Anvil (95), Pell (82) and Gallow Deep
    // (74)", which listed military ratings while claiming to gate on
    // aggression. Pell's aggression is 0.4 and it can never raid at all.
    sizeScale: 0.5,
    // What they carry off. Portable things only — nobody walks out with a
    // reclaimer, and power and water are not in barrels. Ammunition is on the
    // list on purpose: losing a raid makes the *next* one harder to fight,
    // which is what stops a sacked silo from shrugging it off.
    theftKeys: ['scrap', 'parts', 'food', 'meds', 'ammo', 'alloy', 'fuel'],
    // With nobody standing in the way they take a third of the stores. Enough
    // to hurt a silo that ignored the warning, not enough to end it — this is
    // a setback, and a game that deletes a campaign for one missed alert
    // teaches the player to distrust the alert rather than to act on it.
    undefendedTheft: 0.34,
    // Beaten defenders slow them down even when they lose.
    defendedTheftOnLoss: 0.18,
    // A repelled raid still costs the stores that burned in the corridor.
    theftOnWin: 0.04,
    // Nobody armed, nobody trained, and a door that opens. Deaths are drawn
    // from whoever was nearest, which is not a squad and not a choice.
    undefendedDeathChance: 0.55,
    undefendedDeathsMax: 3,
    orderOnRepelled: 6,
    orderOnSacked: -14,
    // What the attacker thinks of you afterwards. Positive on a repulse
    // deliberately: see the note at the dispatch site in sim/raid.js for why a
    // symmetric penalty made the grudge path inescapable.
    //
    // +6 against -20 is not forgiveness. It takes four clean repulses to undo
    // one sacking, so a silo that keeps beating you off eventually stops
    // bothering, and one that gets through keeps coming.
    reputationOnRepelled: 6,
    reputationOnSacked: -20,
  },

  // -------------------------------------------------------- conquest ---
  conquest: {
    scoutRunsRequired: 2,
    scoutFailAlertRep: -12,
    undermineDefenseReduction: 0.25,
    breachSquadsRequired: 2,
    breachSuitTier: 3,
    // What it takes to get through somebody else's door.
    //
    // The ladder gated the breach on charges, two squads and tier-3 suits, and
    // on nothing the squad was *carrying*. So a party could walk up to a
    // sealed silo with pipe guns — power 1, pierce 1, twenty-two scrap and
    // four parts apiece — and the game would let them try.
    //
    // `pierce` is the stat the weapon table already scales for exactly this,
    // and the Breaching Carbine is named for the job: tier 3, pierce 3,
    // "short, heavy, and unpleasant to be in front of at any range". It and
    // the Breacher Plate — "built for standing in a doorway somebody else is
    // shooting at" — were craftable, described in those words, and required by
    // nothing.
    //
    // 2.5 is the line, and it is deliberately between the tiers rather than on
    // one. A squad of Service Rifles (pierce 2) cannot force a door however
    // many of them there are; a squad of Breaching Carbines (3) can; and a
    // mixed party gets through if most of it is carrying the right thing,
    // which is what the mean rather than the minimum is for. Nobody has to
    // re-equip the whole squad to move the ladder one stage.
    //
    // It is reachable two ways, which is the point of putting it on a stat
    // rather than on an item id: craft it behind Firearms III, or bring back a
    // Garrison Rifle or a Rail-Carbine (pierce 4) from the surface. Salvage is
    // a route to the door, not just to a better damage number.
    breachPierce: 2.5,
    holdCombats: 5,
    holdGarrisonDays: 30,
    // ---- how hard they fight back ----
    //
    // `garrisonForce` used to scale with the target and nothing else, so the
    // hardest silo in the game was a fixed ceiling of 95 x 6 x 0.75 = 428 —
    // and a party's force has no ceiling at all. Measured, breach wins out of
    // 25 against military 20 / 60 / 95:
    //
    //   4 green    (force 132)   21 /  2 /  0     <- a real curve
    //   8 green    (force 203)   25 / 21 /  8
    //   4 trained  (force 263)   25 / 25 / 17
    //   8 trained  (force 582)   25 / 25 / 25     <- no curve at all
    //
    // Past about 430 of force the world table's military column stopped
    // deciding anything, and it is the column the whole diplomacy screen is
    // built around. Note what actually flattens it: not headcount — eight
    // green troopers are 203 — but *training*. Four veterans out-fight eight
    // recruits, which is correct, and then out-fight the game.
    //
    // So a garrison now answers the force at its door. That is not
    // rubber-banding for its own sake, it is what a silo would do: they can
    // see what is coming up the approach, and a duty shift meets four
    // scavengers while everyone who can hold a rifle meets a company. It is
    // deliberately sub-linear, so bringing more is still worth doing — at 0.5
    // a party twice the force faces a garrison only 1.41x heavier, and nets a
    // real advantage for it.
    //
    // Measured at 0.5, same cells:
    //
    //   4 green    21 /  0 /  0      a minimum squad cannot brute-force anything
    //   8 green    25 / 12 /  0      numbers alone do not do it
    //   4 trained  25 / 18 /  3      nor does quality alone
    //   8 trained  25 / 25 / 19      the best party takes the worst silo ~76%
    //
    // and the breach is stage three of four — the hold is still five fights
    // after it. Both dimensions decide something now, and neither is
    // sufficient by itself.
    garrisonResponse: 0.5,
    // What "a party worth waking up for" is measured against: a minimum squad
    // in decent kit, which is 132 of force. Below this the exponent would
    // *weaken* the garrison, so it is clamped at 1.
    garrisonReferenceForce: 130,

    // ---- what taking a silo is actually worth ----
    //
    // Conquest paid nothing at all. `resolveRun` had no loot pipeline, so five
    // sorties and a month of fighting returned the satellite stream and
    // literally nothing else — measured against salvage on the same band with
    // the same squad over 330 days: +950 stores and 0 artifacts, against
    // +4,257 and 25. Since eleven of the forty-eight research nodes and all
    // three endings are artifact-gated, that is not a weaker option, it is a
    // strictly dominated one, and a strictly dominated option is dead content
    // whatever else is true of it.
    //
    // The fix is deliberately not "make conquest pay like salvage". It pays
    // for different things, so that the two are a choice:
    //
    //   salvage    a steady, repeatable, artifact-rich trickle off the ground
    //   conquest   one large sack, a shot at what is in their archive, and
    //              then a permanent share of everything they make
    //
    // Both figures come off the world table's own columns, which is the other
    // thing this buys: `power.economy` and `power.science` have decided almost
    // nothing for the player until now. A rich silo is worth robbing and a
    // clever one is worth reading, and the table has been saying which is
    // which for six phases.
    sack: {
      // Units of stores per point of the target's `power.economy`, split
      // across what a storeroom actually holds. Ferrous, the richest silo in
      // the table at economy 90, gives 990 — under a quarter of what 330 days
      // of salvage returns, but
      // arriving at once, and on top of the satellite.
      perEconomy: 11,
      keys: ['scrap', 'parts', 'alloy', 'food', 'meds', 'ammo', 'fuel'],
      // The breach opens the storerooms; the hold is what lets you empty them.
      breachShare: 0.35,
      // Chance per artifact on their table, per point of `power.science`. At
      // science 66 that is a 33% shot at each. This is the only reason to
      // choose a clever target over a rich one, and the only artifact source
      // in the game that is not a dice roll on the wasteland.
      artifactChancePerScience: 0.005,
      // Which table they are drawn from. Tier 3 is the deep band's — a silo
      // that has been standing since the collapse has the same class of thing
      // in it as the deep ruins, which is the fiction and also keeps
      // `origin_shard` (tier 4, the Scar) as something you have to walk to.
      artifactTier: 3,
      // What comes off their armoury racks, per point of `power.military` —
      // the column that until now decided only how hard the fight was, and
      // paid nothing for having been hard. At The Anvil's 95 that is 0.95 a
      // piece per sack against Selby's 0.20, so a hard silo is worth roughly
      // five times a soft one. Split across the breach and the hold on
      // `breachShare`, like the stores and the archive.
      //
      // Neither of these is craftable. Beating somebody who had a Garrison
      // Rifle is the only way to hold one.
      gearChancePerMilitary: 0.010,
      gearTable: ['garrison_rifle', 'slag_plate'],
      // The hardest silos keep something the benches cannot make.
      //
      // Tier-5 otherwise exists only behind `env_suit_4`, which lands with a
      // hundred and twenty days left in a campaign, so the top of the ladder
      // was reachable by exactly one route through a closing door. This is
      // the second one, and it is the one the player asked for: the harder
      // the target, the better what is on its racks. Below `sackEliteMinimum`
      // it pays nothing at all, so softening up Selby is not a farm.
      // 50, because 60 was unreachable. Measured across six campaigns the
      // reference player takes nineteen silos and the hardest is rated 58, so
      // a threshold of 60 meant this branch never once executed — priced
      // content behind a door nothing opens, which is the exact fault this
      // branch has spent its life removing. At 50 it fires on the top few
      // targets and can be measured; a player who deliberately goes after The
      // Anvil at 95 gets roughly twice the yield of one who takes a mid silo,
      // which is the gradient the whole idea is for.
      sackEliteMinimum: 50,
      sackEliteChancePerMilitary: 0.008,
      sackEliteTable: ['rail_carbine', 'compact_cuirass'],
    },

    // ---- what a stage costs to actually attempt ----
    //
    // The four stages were a status readout and nothing else: `canAdvance`
    // was read only by the radio panel to draw a reason string, and
    // `CONQUEST_PATCH` was dispatched from nowhere in src/ — only by
    // test/conquest.mjs, driving the reducer by hand. The panel's own note
    // said "Four stages, each a separate expedition", and the expedition
    // record has carried unused `target` and `purpose` fields since Phase 5.
    // These are the numbers that make that sentence true.
    band: 'approach', // which expedition band a conquest run goes out on
    // A scout run that goes badly tells them you were looking. That is the
    // stated cost of failure in CONQUEST_STAGES, and `scoutFailAlertRep` is
    // what it is worth; this is the ratio below which a run counts as seen.
    scoutSpottedBelowRatio: 1,
    // How hard the two non-combat stages are to pass, against the root of the
    // target's military rating. See `contest` in sim/conquest.js for why it is
    // the root and not the rating itself. Undermining is the harder of the
    // two because it has to touch something rather than just look at it.
    // Measured, 60 seeds a cell, against silo military ratings across the
    // world table's real spread (20 / 48 / 66 / 95), with a party of four:
    //
    //                 tier-2 kit          tier-4 kit
    //   scout         26 / 7 / 2 / 0      59 / 52 / 43 / 41  (of 60)
    //   undermine      8 / 0 / 0 / 0      54 / 43 / 33 / 26
    //
    // 1.6 was the first value and it made the scout stage a formality for
    // anyone holding good weapons — 53 of 60 against the hardest silo in the
    // game — which quietly killed `scoutFailAlertRep`. A cost that never
    // lands is not a cost, and "Failure alerts them" is the only thing the
    // stage risks. At 2.6 a well-equipped party still scouts the soft targets
    // almost every time and gets caught on The Anvil about a third of the
    // time, which is what makes sending them a decision.
    scoutDetection: 2.6,
    undermineDetection: 3.6,
    // What each body over `squadMin` costs an approach run. A stealth job is
    // one a small team does better, which is the only thing making the size
    // of a conquest party a decision rather than "always send everyone".
    approachSizePenalty: 0.09,
    // The garrison. `silo.power.military` is a 0-100 rating, so this converts
    // it into something `combat.resolve` can be handed, scaled by whatever
    // undermining has already done to `conquest.defenseMult`.
    //
    // This was 1.15 first, which was picked by eye and was wrong by about a
    // factor of five. The tell was not that fights were easy, it was that the
    // *target did not matter*: a four-person squad in tier-4 gear took Selby
    // (military 20) and The Anvil (military 95) with the same zero
    // casualties, so the world table's military column — the one number that
    // says which silos are dangerous — decided nothing. For scale, at 1.15
    // the hardest silo in the game fielded 76 power against a Warband of 960
    // that the same squad meets on an ordinary deep run.
    //
    // 6 was measured, not guessed. Forty seeds per cell, a full squad of
    // `squadMax` in tier-4 suits and mag rifles, defences undermined to 0.75,
    // *through the shipped path* — which now includes `garrisonResponse`, so
    // these are what a player meets rather than what this constant does on
    // its own:
    //
    //                 breach            hold (5 fights, one load-out)
    //   military 20   40W /  0L         40/40 taken, 0.1 dead
    //   military 40   39W /  1L         26/40 taken, 2.5 dead
    //   military 60   20W / 20L          5/40 taken, 4.5 dead
    //   military 88    4W / 36L          0/40 taken, 4.6 dead
    //
    // Note the crew: those are citizens at their default combat skill. The
    // same eight *trained* to 45 breach military 95 twenty-one times in
    // twenty-five and hold it eleven — see `garrisonResponse`, which is what
    // makes training the axis rather than headcount. Untrained troops in the
    // best kit in the game cannot take the hardest silo, and that is the
    // intended reading.
    //
    // Measured without the response — this constant alone, as it shipped
    // before that fix — the same cells read 40W/0L, 40W/0L, 34W/6L, 15W/25L
    // with 40/40, 38/40, 21/40, 5/40 held. Recorded because the two tables
    // are easy to confuse and only one of them is the game.
    garrisonPowerPerMilitary: 6,
    // The breach is one fight against everything they have at the door.
    breachGarrisonScale: 1,
    // Then five floors, with what is left of what you carried in. Each fight
    // is against a smaller share of the garrison and each one costs you
    // ammunition you cannot replace, which is the whole difficulty of the
    // stage: `holdCombats` fights on one load-out.
    holdGarrisonScale: 0.45,
    holdAmmoDecayPerFight: 0.15,
    // Losing the breach or the hold is not a reset to zero. The stage stands
    // and can be tried again; what it costs is the squad that tried it. There
    // is no `holdFailuresAllowed` — there was one, read by nothing, and a
    // constant that describes a rule the code does not have is the exact
    // defect this module was written to remove.
    // What a silo's own order reads the day it is taken, and the number that
    // makes `holdGarrisonDays` mean something.
    //
    // It was 5, against a `revoltOrderThreshold` of 20 — so an ungarrisoned
    // satellite was already below the line before the first day's decay was
    // applied, and revolted immediately, every time. That made
    // `satelliteDecayPerDay` dead weight: its value could be -0.001 and
    // nothing would change. It also made the `hold` stage's own description —
    // "then 30 days of garrison or they revolt" — wrong by thirty times and
    // wrong in shape: it described a slide and delivered a cliff.
    //
    // 62 is derived, not picked: (62 - 20) / 1.4 is exactly
    // `holdGarrisonDays`. A silo you take and walk away from throws you out a
    // month later, which is the sentence the panel has always shown the
    // player. Garrisoned, it warms from 62 at `satelliteWarmPerDay`.
    conqueredStartOrder: 62,
    satelliteEfficiency: 0.4,
    satelliteOrderPerDay: -1, // what each satellite costs *your* order, daily
    // What a held silo sends home each day, before the three scalings below
    // it. These were literals in sim/world.js — 18 and 10 — which is both
    // against the rule that every tunable lives here and the reason nobody
    // noticed a satellite was running at a loss.
    //
    // The arithmetic, at the old numbers. Yield is
    // `base * (economy/100) * satelliteEfficiency * (order/100)`, so Selby at
    // economy 97 and the starting order of 62 scaled to 0.24: 4.3 of its
    // specialty and 2.4 chits, 6.7 a day. Measured across every satellite-day
    // of two full campaigns the average was 4.05. Its garrison is six
    // soldiers at `barracksFoodPerSoldierPerDay` 0.4 and
    // `stipendChitsPerSoldierPerDay` 0.5 — 5.4 a day — before the six
    // foregone jobs and the Order. A holding cost more to keep than it sent
    // back, which is not "a permanent share of everything they make"; it is a
    // tax on winning.
    //
    // At 60/30 the same silo sends 14.4 and 7.2, about 22 a day. Against a
    // mature silo's measured 242-293 a day of gross production that is 8% —
    // visible on the counters, worth the garrison, and nowhere near enough to
    // replace the surface programme. Three of them is a quarter of a second
    // economy, which is what taking a third of the world should feel like.
    satelliteYieldPerDay: 60,
    satelliteChitsPerDay: 30,
    // What happens to the occupied silo's own order. Warming needs a squad
    // sitting on it; without one the place slides toward throwing you out.
    // One garrison squad per satellite is the real price of Dominion — six
    // silos means six squads standing still, fed and paid, forever.
    satelliteWarmPerDay: 0.6,
    satelliteDecayPerDay: -1.4,
    revoltOrderThreshold: 20,
  },

  // ---------------------------------------------------------- render ---
  render: {
    // Below this health a citizen is drawn limping rather than walking. It is
    // a rendering threshold, not a simulation one, but it decides what the
    // player sees and so it lives here like everything else that does.
    injuredBelowHealth: 45,
    // How many people are drawn at one post, and loose on one floor. A silo of
    // two hundred and fifty has forty residents on a residential floor, and
    // drawing all forty produces a wall of overlapping heads that reads as a
    // rendering fault rather than as a crowd. A handful, well spaced, says
    // "busy" far better — the roster is where the real headcount lives.
    maxCitizensPerRoom: 5,
    // Off-shift people per floor. Raised from 8 once `idleFloor` stopped
    // stacking the entire off-shift population onto two floors: with everyone
    // dealt across the residential floors instead, 12 is a busy corridor
    // rather than a smear, and the lanes in `citizenX` keep them apart.
    maxIdleCitizensPerFloor: 12,
    tileSize: 32,
    floorHeight: 40,
    floorWidth: 384, // 6 slots * 64
    slotWidth: 64,
    maxSpritesPerFrame: 400,
    citizenFloorsRendered: 3,
    // ---- what people are doing when they are not at a post ----------------
    //
    // Before these, every off-duty citizen in the silo was drawn walking, for
    // ever, because the only question the renderer asked was "do they have a
    // post". Measured over a 200-day campaign the game used two of its five
    // animations; idle and sleep were unreachable and 110 baked frames were
    // never displayed.
    //
    // An off-duty citizen alternates between wandering and standing still on a
    // cycle seeded from their id, so a corridor has people moving through it
    // and people loitering in it rather than a procession.
    idleWanderSeconds: 11,
    idleStandFraction: 0.45,
    // ---- what people are doing *at* a post --------------------------------
    //
    // Somebody at a post used to be pinned to a mark. `citizens.js` read
    // `still = onDuty(c) ? !!room : …`, so a citizen with a room never moved a
    // pixel — the walk cycle in the atlas, six frames of it, was drawn for
    // off-duty people and for nobody else. A working silo rendered as rows of
    // figures standing to attention, which is the one thing a working silo is
    // not.
    //
    // So a post is two places now, not one: the lane the crewing code deals
    // them, and a second station somewhere else in the same room. They work at
    // one, cross to the other, work there, cross back. The lanes still decide
    // where people *stop*, which is what stops a crowded post reading as a
    // pile of overlapping heads; what changed is that stopping is no longer
    // the whole of the job.
    //
    // The period is per-citizen (see `shiftPhase`), spread across this range,
    // so eight people at one post are on eight different rhythms rather than
    // marching. Under six seconds a post reads as agitated rather than busy.
    postCycleSeconds: [9, 21],
    // The share of a cycle spent standing at a station rather than crossing
    // between them. Split across the two stations, so at 0.72 a citizen is
    // working about a third of the time at each end and walking the rest.
    postDwellFraction: 0.72,
    // How far the second station sits from the first, as a share of the room's
    // usable width. Kept off 0.5 so two people who happen to share a rhythm
    // do not converge on the same middle.
    postStationSpread: [0.28, 0.62],
    // Two people standing near each other talk. The pairing is by adjacent
    // lane and costs nothing to compute, but pairing *every* neighbour made a
    // floor look like a staged crowd scene, so only some pairs strike up.
    talkWithinPx: 26,
    talkPairFraction: 0.55,
    // Night. Off-duty people on a floor with beds sleep through these shifts,
    // which is what finally makes the sleep frames reachable.
    nightShifts: [0, 1, 7],
    // The most unacknowledged deaths that can be marked at once, newest first.
    //
    // Marks wait to be tapped rather than expiring, which is the point of
    // them — but a campaign kills people steadily, and a day-220 silo had
    // fifteen skulls standing in it at the same time. That is a graveyard the
    // player has to clear by hand before they can read their own floors, and
    // it buries the living. The older ones are not dismissed, only hidden:
    // clear one and the next comes up, so nothing is lost and the
    // cross-section never fills.
    maxDeathMarks: 6,
    // How close a tap has to land to clear a death mark, in world units. A
    // skull is 16 world units and test/mobile.mjs holds every control to 30
    // screen px, so the box is deliberately larger than the sprite.
    deathMarkTapRadius: 14,
    depthGaugeBarHeight: 3,
    cameraLerp: 0.18,
    // ---- flick to scroll ----
    // Letting go mid-drag used to stop the silo dead under the finger, which
    // reads as the gesture having been dropped rather than finished. These
    // give it a coast, in world units per millisecond.
    //
    // Velocity is smoothed across recent moves so one stray sample at the end
    // of a slow drag cannot launch the view; 0.35 keeps roughly the last three
    // moves. A release more than flingStaleMs after the last movement is a
    // finger that came to rest before lifting, and coasts nothing.
    flingVelocitySmoothing: 0.35,
    flingStaleMs: 90,
    flingMinVelocity: 0.02,
    // Per millisecond, so the coast lasts the same wall-clock time whatever
    // the frame rate: 0.995 sheds half the speed every ~140ms and settles in
    // about half a second, which is a coast rather than a slide.
    flingDecayPerMs: 0.995,
    flickerAmplitude: 0.06,
    flickerSpeed: 0.9,

    // ---- placement mode (pick a building, then tap a lit bay) ----
    // Everything the cross-section does while the player is choosing where a
    // building goes. Sodium amber, never toxin: the green in this game means
    // radiation and nothing else.
    placement: {
      pulseMs: 1500, // one full breath of a lit bay; dead under reduced motion
      washAlpha: 0.58, // how far the rest of the silo dims behind the targets
      // The bay glows; the outline and the corner ticks are what actually
      // carry it at 390px wide. Fill it any harder and forty lit bays read as
      // a wall of amber slabs rather than as forty empty bays.
      fillAlpha: 0.09, // amber inside a legal bay at the bottom of the breath
      fillPulse: 0.11, // added at the top of it
      edgeAlpha: 0.9, // the outline
      bracket: 6, // corner tick length, world px
      nearestBays: 8, // how many bays the placing bar lists as shortcuts
    },
  },

  // -------------------------------------------------------- pacing ---
  pacing: {
    flavourChancePerDay: 0.3,
    // When each scripted crisis fires is *not* here. It is `atMinutes` on the
    // crisis itself in src/data/events.js, which is what sim/events.js reads
    // and what test/pacing.mjs checks against. There was a second copy of the
    // schedule in this block — same five keys, same five times — that nothing
    // had ever read, so moving a crisis meant editing one of two lists with no
    // way to tell which. The times belong beside the prose and the resolution
    // they schedule; a duplicate that cannot disagree loudly is worse than no
    // duplicate at all.
  },

  // ------------------------------------------------------- endings ---
  endings: {
    compactAlliesRequired: 8,
    // Held at once, not taken over a campaign — `events.js` reads
    // `world.satellites.length`, and a holding that revolts or collapses
    // leaves that list.
    //
    // This was 6, and 6 was unreachable by playing well rather than merely
    // hard. Two things made it so. Each holding needs a garrison squad
    // standing still on it for ever, so six means six squads fed, paid and
    // doing nothing else; and the neighbours are on a collapse timer the
    // player cannot touch. Measured across three 900-day campaigns: takeable
    // silos fall from 14 at day 100 to between 2 and 5 by day 700, while
    // `breaching_charges` — deliberately last in the research order — does
    // not land until day 423-514. By the time the door opens the room is
    // emptying, and two of those three campaigns ended with *no* standing
    // neighbours at all.
    //
    // The reference player peaks at 2, 1 and 1 concurrent holdings on the
    // three seeds. Three is therefore still beyond it: reaching Dominion
    // means deliberately building garrison squads it does not build and
    // taking silos it does not bother with, which is what an ending should
    // ask for. Six asked for a world that had stopped existing.
    dominionSilosRequired: 3,
    surfaceResearchRequired: 'origin_record',
  },

  // ------------------------------------------------------- unlocks ---
  // How much of itself the silo shows, and when. The gates themselves — which
  // panel arrives after which, and on what evidence — live in
  // src/sim/unlocks.js; only the numbers they read are here.
  unlocks: {
    // A resource earns a counter on the strip when the rooms the player has
    // built draw at least this much of it per cycle, summed at base rate.
    // Set above the two trickles the opening silo already runs — a generator
    // hall rated at 0.3 fuel a shift and a filtration bay at 0.05 filters,
    // both from their room definitions in src/data/rooms.js — because neither
    // is a decision for the first fifty days, and there is nothing in the
    // catalogue on the first morning that changes either figure. A number that
    // cannot be acted on teaches the player to stop reading the strip it sits
    // on.
    resourceDrawPerCycle: 0.5,
    // ...and regardless of that, when the stock will be gone inside this many
    // days at the current rate. This is the safety net under the rule above:
    // it is what puts fuel and filters up before they stop the generators and
    // the scrubbers, whether or not the player ever builds something that
    // makes them. Deliberately wide, so a counter that appears does not
    // vanish again next cycle — closing a thirty-day gap means building a
    // producer, and building one puts the counter up permanently anyway.
    resourceRunwayDays: 30,
    // Order at which the silo has politics and the Order panel opens.
    //
  },

  // ---------------------------------------------------- legibility ---
  // What the silo says about itself while you are watching it: the shift
  // report under the standing order, the flash on a counter that moved, and
  // how long an alert stays up. None of these change what happens; they
  // change whether you can tell what happened. Appended as its own section
  // because the numbers above were tuned against a green suite.
  legibility: {
    // How many shift-report lines the shell keeps for the Log panel's
    // Changes tab. Deliberately small: this is "what just happened", and the
    // permanent record is the log itself.
    changeLogMax: 40,
    // Shifts a change line stays under the standing order once it has been
    // read. Unread lines stay until they are. Six is most of a day, which is
    // long enough to come back to and short enough not to go stale.
    changeLineShifts: 6,
    // A resource whose net flow crosses zero is the single most useful thing
    // to say out loud — it is the moment a full tank starts emptying — but
    // during a brownout rooms shed and pick back up cycle by cycle and the
    // sign chatters. The deadband ignores rounding noise; the quiet period
    // stops the same resource being reported twice in a day.
    flowFlipDeadband: 0.05,
    changeQuietCycles: 8,
    // How long a counter that moved stays marked, and how far a stockpile
    // has to move in one shift before it counts as having moved at all —
    // whichever of the two is larger, so small stores are not permanently lit
    // and large ones are not silent.
    // How a counter moves to its new value.
    //
    // `counterEase` is the fraction of the remaining gap closed each paint, so
    // the roll always converges even though the target moves — a store both
    // fills and drains every cycle, and a fixed-duration tween restarts on
    // every change and never arrives. `counterSnapAt` stops it crawling the
    // last fraction for ever; `counterSnapAbove` skips the roll entirely for a
    // jump that is not a trickle, because rolling a counter from 300 to 4,000
    // after a catch-up is a slot machine rather than a readout.
    counterEase: 0.22,
    counterRollMs: 420,
    counterSnapAt: 0.5,
    counterSnapAbove: 120,
    counterFlashMs: 2600,
    stockMoveFraction: 0.04,
    stockMoveMin: 5,
    // The alert rail: how many cards stand at once, how long one lasts, and
    // how long a card that has been opened for its reason lasts. Both were
    // literals in shell.js.
    // One card stands at a time. Three did, and on an ordinary day eleven —
    // a brownout, a water warning and a worn room — the rail covered floors
    // one to seven, which was every room the silo had. The two-tap card is
    // worth reading; three of them at once are a blindfold. The rest of the
    // stack collapses to a count, and the player opens it when they want it.
    alertMaxCards: 1,
    // How many are kept behind that count before the oldest is let go.
    alertStackMax: 4,
    alertDwellMs: 7000,
    alertOpenedDwellMs: 14000,
    // Rooms named per side in a resource's own explanation. Beyond a handful
    // the list stops being an answer and becomes an inventory.
    resourceRoomsShown: 6,
    // How long the depth gauge marks a floor the player was just sent to, so
    // the eye can follow a jump made from a line of text.
    gaugeFocusMs: 2200,
  },

  // ---------------------------------------------------- wayfinding ---
  // Appended as its own section by the navigation/placement pass, so nothing
  // above it had to move. Everything here answers the same question from a
  // different angle: on a 390px screen, which of the things the silo could
  // show you right now is the one you are supposed to be looking at.
  wayfinding: {
    // ---- when the Order panel arrives ----
    // The old line was a live reading of `order.value`, which is pulled back
    // toward `order.driftToward` every day — so the gate could, and did,
    // close again two days after it opened. These two replace it with the
    // wreckage low order leaves behind, both of which are counters the
    // reducers only ever increment. See src/sim/unlocks.js.
    //
    // Two crimes rather than one: a single theft on day twenty is an
    // incident, and crime scales with disorder, so a badly run silo reaches
    // the second one sooner. Measured on three autopilot seeds, it trips on
    // days 45, 32 and 49 — fourth, third and fourth of the five panels. It is
    // not last and was never meant to be: the day-32 one is a murder with a
    // verdict waiting, and a panel the player is required to use has to be
    // there when the verdict is.
    orderCrimesBefore: 2,
    // …and the silo that is failing quietly rather than criminally. Six
    // funerals is well past what a stable silo of forty-four buries in the
    // first two months, and `stats.deaths` never travels backwards.
    orderDeathsBefore: 6,

    // ---- placement: which bays are worth looking at ----
    // Pick-then-place lit every legal bay equally: twenty-four identical
    // amber boxes across six floors on the first morning, of which exactly
    // one — the merge — was a different decision from the other
    // twenty-three. That is not a choice, it is a coin flip with extra
    // steps. Bays are now ranked, and only the ranked few are drawn as
    // targets; the rest stay legible as free space and stay tappable.
    placement: {
      // A bay that would join an identical neighbour into a wider unit.
      // Wider units make more per slot and draw less power per slot, so this
      // is the only bay on the floor that is genuinely better than its
      // neighbours — and it used to be a 2px bar in the same colour as the
      // corner ticks either side of it.
      mergeEdge: 1, // stroke alpha for a merge target
      mergeFill: 0.3, // and how hard the arrow into the neighbour is drawn
      // How many plain bays get the full treatment. One per floor, nearest
      // the middle of the screen, so every floor with room on it offers a
      // target without offering six.
      suggestedPerFloor: 1,
      // Floors either side of the camera that get a suggestion on bare rock —
      // a floor with nothing built on it has no bay that is better than any
      // other, so the only reason to mark one at all is to give the player
      // something to tap where they are already looking. The whole excavated
      // silo fits on an 844px screen at the six floors it opens on, so this
      // has to be small or "one per floor" is five more amber boxes on a
      // screen that already has one.
      suggestFloorRadius: 1,
      // Everything else: still legal, still tappable, drawn as an empty bay
      // with a hairline rather than as a target competing for the eye.
      quietEdge: 0.28,
      quietFill: 0.04,
    },

    // ---- the catalogue ----
    // Twenty-nine rows, thirteen of them greyed, is three thousand pixels of
    // scrolling on a phone to find the sixteen things that can actually be
    // built. The locked ones are still worth *knowing about* — they are the
    // shape of the game ahead — so they are kept, collapsed behind one line
    // that says how many there are and what they are waiting on.
    lockedRowsCollapsed: true,
    // A room that has more free bays than this is not interesting enough to
    // print a number for; below it, the count is a warning that the silo
    // needs digging. It used to print "24 bays free" on every row,
    // identically, which is the definition of a chip nobody reads.
    baysChipBelow: 12,
  },
};

/** Derived, read-only helpers so sim code never re-derives time math. */
export const TIME = {
  ticksPerCycle: BAL.time.TICKS_PER_CYCLE,
  ticksPerDay: BAL.time.TICKS_PER_CYCLE * BAL.time.CYCLES_PER_DAY,
  ticksPerYear: BAL.time.TICKS_PER_CYCLE * BAL.time.CYCLES_PER_DAY * BAL.time.DAYS_PER_YEAR,
  cyclesPerDay: BAL.time.CYCLES_PER_DAY,
  cyclesPerYear: BAL.time.CYCLES_PER_DAY * BAL.time.DAYS_PER_YEAR,
  daysPerYear: BAL.time.DAYS_PER_YEAR,
};

export default BAL;
