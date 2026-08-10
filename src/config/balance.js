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
    totalFloors: 92,
    slotsPerFloor: 6,
    startExcavatedFloors: 14,
    tiers: [
      { key: 'upper', name: 'Upper', from: 1, to: 14, gate: null },
      { key: 'mids', name: 'Mids', from: 15, to: 34, gate: 'deep_excavation_1' },
      { key: 'lowers', name: 'Lowers', from: 35, to: 58, gate: 'deep_excavation_2' },
      { key: 'deeps', name: 'Deeps', from: 59, to: 80, gate: 'deep_excavation_3' },
      { key: 'foundations', name: 'Foundations', from: 81, to: 92, gate: 'origin_systems' },
    ],
    excavation: {
      baseScrap: 40,
      baseLabor: 30,
      // Compounding across all 92 floors at 1.18 reaches 10^6 — floor 60
      // would cost eighteen million scrap and take seven hundred game days.
      // Growth compounds *within* a tier and steps between them instead, so
      // the Deeps stay expensive without becoming arithmetically impossible.
      growth: 1.09,
      tierMultiplier: 2.2,
      maxDigCycles: 120,
      ticksPerLaborHour: 1,
      shoringRequiredBelowFloor: 35,
      shoringAlloyPerFloor: 6,
      collapseChancePerDayUnshored: 0.02,
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
      // Fraction of the room's build cost charged to restore it fully.
      // Always cheaper than rebuilding, and scales with the room's value.
      fractionOfBuildCost: 0.55,
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
    filterConsumptionPerBayPerCycle: 0.05,
  },

  // --------------------------------------------------------------- power ---
  power: {
    // Brownout: rooms shut off from the bottom of the priority list up.
    brownoutMoraleHit: -2,
    batteryDischargePerCycle: 12,
    batteryChargePerCycle: 8,
    defaultPriority: [
      // Life support, then generation, then *income*. Recycling and the
      // Workshop sit this high because they are the way out of a brownout,
      // not a luxury to be shed during one: they were tenth and ninth, below
      // the residences and the cafeteria, which produced a spiral with no
      // exit — demand passes generation, the salvage plants are the first
      // things cut, scrap income stops, and the Generator Hall that would end
      // it can never be afforded. An obedient player sat on "Build a Generator
      // Hall" for 49 days and starved with the answer written on the screen.
      //
      // The Laboratory and the Chem Lab join them for the same reason, and it
      // is worth being explicit about why they were wrong where they were.
      // This list does two jobs: it is the order rooms are shed in during a
      // brownout, and (via jobs.js) it is the order posts are *crewed* in.
      // The second job is the one that bites in a small silo. Auto-assign
      // only ever posts people who have no job, and a 44-person opening that
      // has grown to two hundred is still two-thirds children — so the silo
      // runs at zero spare labour permanently and simply never reaches the
      // bottom of this list. At twenty-second the Laboratory was below the
      // holding cells and the training yard: measured, its two benches held
      // one scientist at day 275 and none at all through most of the two
      // hundreds, and research stopped dead for a hundred days. The Chem Lab
      // at eleventh, under the residences and the cafeteria, went a hundred
      // and fifty-five days with nobody in it — and it is the only source of
      // filters and meds in the game, so the clinic ran dry and the airlock
      // could not decontaminate anybody who went outside.
      //
      // Both belong with recycling and the workshop, above the comforts, on
      // exactly the argument the paragraph above makes: they are how a silo
      // gets *out* of the state it is in. power_efficiency is a research
      // node — a silo that sheds its labs in a brownout can never research
      // the thing that ends brownouts.
      'water_reclaimer',
      'air_filtration',
      'hydroponics',
      'generator_hall',
      'reactor',
      'recycling',
      'workshop',
      'laboratory',
      'chem_lab',
      'residences',
      'clinic',
      'cafeteria',
      'foundry',
      'munitions',
      'storage_depot',
      'suit_bay',
      'airlock',
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
    workingAgeMin: 16,
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
  },

  // ---------------------------------------------------------- research ---
  research: {
    // Research throughput is per *lab*, and the number of labs a silo can
    // staff is a function of its population — so cutting the opening from 180
    // people to 44 cut research by roughly the same factor, against a 46-node
    // tree whose costs were set against the large silo. A broadly-played silo
    // reached 6 nodes in 300 days, which makes most of the tree scenery. This
    // buys that back per bench rather than by re-pricing 46 hand-tuned nodes;
    // the expensive nodes at the bottom of the tree (2100–3200) are what
    // absorb the throughput of a silo that has grown back to full strength.
    //
    // 1.5 was not enough, and the reason is that a *bench* is not a lab. A
    // laboratory only ever runs at the fraction of its two posts that are
    // crewed, auto-assign fills posts in power-priority order, and the
    // laboratory is twenty-second on that list — so the small silo runs its
    // one lab at a capability of 0.25–0.5 for most of the first two hundred
    // days, not 1. Measured at 1.5: nine nodes by day 300 and a whole hundred
    // days, day 175 to day 275, in which the tree did not move at all. At 2.4
    // the same run reaches fourteen by day 300 and thirty-eight by day 700,
    // which is a tree the player can see the shape of. It is deliberately not
    // enough to outrun the artifact gates: a third of the nodes still need
    // something carried in from the surface, and no amount of bench time
    // substitutes for opening the airlock.
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
    satellitePenaltyPerDay: -1,
    uprisingThreshold: 25,
    // Below this the silo has politics and the Order panel opens. Above it
    // there is nothing there to decide, and an empty panel on the first
    // morning is one more thing to work out before you can start playing.
    contentThreshold: 55,
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

  // ---------------------------------------------------------- military ---
  military: {
    squadMin: 4,
    squadMax: 8,
    maxSquads: 6,
    trainingSkillPerDay: 1.5,
    trainingAmmoPerDay: 2,
    barracksFoodPerSoldierPerDay: 0.4,
    garrisonOrderBonusPerSquad: 2.5,
    readinessWeights: { training: 0.3, equipment: 0.3, health: 0.2, morale: 0.1, ammo: 0.1 },
    stipendChitsPerSoldierPerDay: 0.5,
  },

  // -------------------------------------------------------------- gear ---
  gear: {
    durabilityMax: 100,
    durabilityLossPerCombat: 6,
    durabilityLossPerExpeditionDay: 1.5,
    repairPerCyclePerQuartermaster: 2.2,
    repairScrapPerPoint: 0.35,
    suit: {
      integrityMax: 100,
      repairAlloyPerPoint: 0.2,
      repairPartsPerPoint: 0.1,
      degradePerHourOutside: [0.55, 0.42, 0.3, 0.2], // by suit tier
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
      // against an air plant that burns roughly 0.05 a shift per filtration
      // bay — so a silo large enough to need six bays and small enough to
      // staff exactly one Chem Lab runs a filter balance of about zero and
      // banks nothing. At 2 a head that put a four-person decon at 8 filters,
      // which such a silo takes over a hundred days to save up: measured, the
      // squad was suited, armed and standing at the airlock from day 172 and
      // did not get through it until day 284. 1 halves the fare without
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
    gearTierMult: [1.0, 1.4, 1.9, 2.5], // weapon tier 1-4
    armorPerTier: 0.12,
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

  // ------------------------------------------------------- conquest ---
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

  conquest: {
    scoutRunsRequired: 2,
    scoutFailAlertRep: -12,
    undermineDefenseReduction: 0.25,
    breachSquadsRequired: 2,
    breachSuitTier: 3,
    breachChargesRequired: 4,
    holdCombats: 5,
    holdGarrisonDays: 30,
    conqueredStartOrder: 5,
    satelliteEfficiency: 0.4,
    satelliteOrderPerDay: -1, // what each satellite costs *your* order, daily
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
    maxIdleCitizensPerFloor: 8,
    tileSize: 32,
    floorHeight: 40,
    floorWidth: 384, // 6 slots * 64
    slotWidth: 64,
    maxSpritesPerFrame: 400,
    citizenFloorsRendered: 3,
    depthGaugeBarHeight: 3,
    cameraLerp: 0.18,
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
    crises: [
      { key: 'first_blight', atMinutes: 120, once: true },
      { key: 'raider_probe', atMinutes: 300, once: true },
      { key: 'refugee_wave', atMinutes: 480, once: true },
      { key: 'anvil_ultimatum', atMinutes: 840, once: true },
      { key: 'uprising_window', atMinutes: 1200, once: true },
    ],
  },

  // ------------------------------------------------------- endings ---
  endings: {
    compactAlliesRequired: 8,
    dominionSilosRequired: 6,
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
    // hall burning 0.3 fuel a shift and a filtration bay burning 0.05
    // filters — because neither is a decision for the first fifty days, and
    // there is nothing in the catalogue on the first morning that changes
    // either figure. A number that cannot be acted on teaches the player to
    // stop reading the strip it sits on.
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
    // This supersedes `order.contentThreshold` (55) for that one job, which
    // is the only job that key ever had. 55 cannot be the line: order starts
    // at 64 and drifts toward `order.driftToward` — 50 — at a quarter of the
    // gap a day, so it crosses 55 on day four or five of every silo ever
    // played, whatever the mayor does. Measured across three seeds: day 5,
    // day 5, day 5. That is not politics arriving, it is a timer, and it put
    // the Order panel on screen ahead of Research in every game.
    //
    // 45 is the number the Order panel itself already draws as a warning
    // rather than as normal, and it sits under the drift attractor, so
    // reaching it means the silo is genuinely losing its grip: deaths,
    // overcrowding, idle hands, an execution. Measured on the same seeds it
    // first trips on days 61, 75 and 83 — each time on a silo in real
    // trouble. A player who wants the panel sooner can still have it for 120
    // scrap: a Sheriff's Office opens it at any order at all.
    orderTroubleBelow: 45,
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
