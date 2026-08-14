/**
 * events.js — scripted crises and the endings.
 *
 * The crises fire on a real-time cadence rather than on random chance
 * (spec §16), because pacing that depends on dice is pacing you don't
 * control. A player two hours in gets the blight whether or not the RNG
 * felt like it; what varies is how ready they are for it.
 *
 * Each crisis carries its own prose. The voice is administrative and plain:
 * this is a log entry written by somebody who has to file it, not narration.
 */

import { BAL } from '../config/balance.js';

export const CRISES = {
  first_blight: {
    id: 'first_blight',
    name: 'Blight',
    atMinutes: 120,
    headline: 'Blight in the hydroponics racks',
    text:
      'Something has got into the beds. The leaves go grey from the stem out and the ' +
      'racks it reaches are a total loss. Farming reckons a third of the standing crop.',
    requires: (s) => Object.values(s.silo.rooms).some((r) => r.type === 'hydroponics'),
    resolve: (s) => {
      const bays = Object.values(s.silo.rooms).filter((r) => r.type === 'hydroponics');
      const actions = [
        { type: 'RESOURCE_DELTA', deltas: { food: -Math.round(s.resources.food * 0.3) } },
      ];
      for (const bay of bays) {
        actions.push({
          type: 'ROOM_PATCH',
          id: bay.id,
          patch: { condition: Math.max(10, bay.condition - 25) },
        });
      }
      actions.push({ type: 'ORDER_DELTA', amount: -5, reason: 'the blight' });
      return actions;
    },
    advice: 'Blight Resistance halves what the next one takes. It will not be the last one.',
  },

  raider_probe: {
    id: 'raider_probe',
    name: 'Raider probe',
    atMinutes: 300,
    /**
     * Waits for a silo that can put somebody on the airlock.
     *
     * 300 minutes is day 25, and the Squads panel is earned on day 26, 33 and
     * 47 across the three seeds this project measures on — so on every one of
     * them the game's own teaching raid arrived before the player was allowed
     * a squad, and its advice line ("Put somebody on the airlock before
     * tomorrow") named a thing they could not do. Measured across three
     * campaigns: 0 defenders, every time.
     *
     * The scrapper band it sends is the weakest in the game and is meant to be
     * turned away by anybody at all — recomputed with a garrison present, the
     * forecast reads 7.4 to 8.4, which is "they will not get through this".
     * That is the lesson it was written to teach, and this is the clause that
     * lets it.
     *
     * A *crewed squad*, not merely the Squads panel. `unlocked(state,
     * 'military')` is the gate `sim/diplomacy.js` puts on emergent raids and
     * it is the right one there — it means "you have the means, and leaving
     * the door open is now your decision". It is not enough here: on seed
     * 0x1234 the panel is earned on day 26 and this fired the same day, which
     * left one grace day to form a squad, crew it and put it on the airlock.
     * A scripted lesson has to be learnable on the day it arrives, so it waits
     * for the thing the lesson is about to exist.
     */
    requires: (s) =>
      (s.military?.squadIds || []).some((id) => (s.military.squads[id]?.members || []).length > 0),
    headline: 'Somebody is at the airlock',
    text:
      'Four of them, maybe five, working at the outer door with a cutting torch and no ' +
      'particular hurry. They are not equipped to get through it today. They are ' +
      'equipped to find out how long it would take, and they are taking their time ' +
      'about it. Whoever is standing at that door tomorrow is the whole of the answer.',
    resolve: (s) => [
      { type: 'PENDING_RAID', siloId: 5, strength: 0.25 },
      { type: 'ORDER_DELTA', amount: -4, reason: 'raiders at the door' },
    ],
    advice:
      'Put somebody on the airlock before tomorrow. A squad standing there turns this ' +
      'kind of party around; an empty corridor lets them take whatever they can carry.',
  },

  refugee_wave: {
    id: 'refugee_wave',
    name: 'Refugees',
    atMinutes: 480,
    headline: 'People at the outer door',
    text:
      'Eleven of them, on foot, carrying children. Their silo stopped producing air four ' +
      'days ago and they walked. They are standing in the open asking to be let in, and ' +
      'the dosimeter on the outer door is climbing while they wait.',
    resolve: (s) => [
      {
        type: 'WORLD_EVENT_QUEUE',
        event: { kind: 'refugees', fromSilo: 4, day: s.clock.day, count: 11 },
      },
    ],
    advice: 'Air capacity decides how many you can take. That number was set months ago.',
  },

  anvil_ultimatum: {
    id: 'anvil_ultimatum',
    name: 'The Anvil',
    atMinutes: 840,
    headline: 'A transmission from The Anvil',
    text:
      'Marshal Guro Sayen, on an open channel, unhurried: "Silo Twelve. We have your ' +
      'position, your headcount and a fair estimate of your armoury. You will send a ' +
      'tithe every twenty days or we will come and take a larger one. Answer or do not; ' +
      'we are not asking."',
    resolve: (s) => [
      { type: 'SILO_PATCH', siloId: 5, patch: { known: true, contact: 'radio' } },
      {
        type: 'SILO_MEMORY',
        siloId: 5,
        entry: { day: s.clock.day, kind: 'threatened', weight: -4, text: 'We put terms to Silo 12.' },
      },
      { type: 'ORDER_DELTA', amount: -6, reason: 'the Anvil’s ultimatum' },
    ],
    advice:
      'Paying is cheaper than fighting and it does not stop. Refusing is expensive once and then it is over.',
  },

  uprising_window: {
    id: 'uprising_window',
    name: 'Organised dissent',
    atMinutes: 1200,
    headline: 'Something is being organised on the residential floors',
    text:
      'Deputies report a meeting on floor four that broke up when they arrived. Nobody ' +
      'will say what it was about. Three separate people have asked, in the last shift, ' +
      'who decided that you were the mayor.',
    resolve: (s) => [
      { type: 'ORDER_DELTA', amount: -8, reason: 'organised dissent' },
      { type: 'DISSENT_SET', value: (s.order.dissentPressure || 0) + 3 },
    ],
    advice:
      'Order below 25 for three days is where a rising starts. You have levers; all of them cost something.',
  },

  // -------------------------------------------------------------------------
  // Everything above fires inside the first hundred game days, and until now
  // there was nothing after it. Measured over six campaigns: four scripted
  // crises per hundred days from day 0 to 100, one from 100 to 200, and zero
  // for the remaining five hundred. Expeditions collapse over the same
  // stretch, from 16.8 a hundred days to 2.5. Days 200 to 300 were the
  // emptiest part of the game and it ran to day 700.
  //
  // These eight cover day 150 to day 750, at twelve real minutes a game day.
  // Each one leans on a system the player already has, so it is a demand on
  // the silo they have built rather than a new rule arriving late; and each
  // carries `requires`, so a crisis about the deep does not fire at a silo
  // that has never been there.
  // -------------------------------------------------------------------------

  bearing_failure: {
    id: 'bearing_failure',
    name: 'Generator fault',
    atMinutes: 1800, // ~day 150
    headline: 'Number two generator is making a noise',
    text:
      'A bearing, maintenance thinks, and not one they carry. It has been getting louder ' +
      'for two shifts and it is now loud enough that the floor below has stopped ' +
      'pretending not to hear it. They can keep it turning. They cannot keep it turning ' +
      'and quiet, and they would like it in writing which of those you want.',
    requires: (s) => Object.values(s.silo.rooms).some((r) => r.type === 'generator_hall'),
    resolve: (s) => {
      const halls = Object.values(s.silo.rooms).filter((r) => r.type === 'generator_hall');
      const worst = halls.sort((a, b) => a.condition - b.condition)[0];
      const actions = [{ type: 'RESOURCE_DELTA', deltas: { parts: -Math.min(24, s.resources.parts || 0) } }];
      if (worst) {
        actions.push({ type: 'ROOM_PATCH', id: worst.id, patch: { condition: Math.max(12, worst.condition - 40) } });
      }
      actions.push({ type: 'ORDER_DELTA', amount: -3, reason: 'the generator' });
      return actions;
    },
    advice: 'A Maintenance Bay repairs faster than a room degrades. Without one this is a countdown.',
  },

  sealed_stair: {
    id: 'sealed_stair',
    name: 'The sealed stair',
    atMinutes: 2400, // ~day 200 — the middle of the hole
    headline: 'The stairwell does not stop where the plans say it stops',
    text:
      'A survey crew chasing a draft found a bulkhead behind the stair on the lowest floor ' +
      'you have opened. It is not on any drawing you hold. It is welded from the far side, ' +
      'and the air coming past the seal is colder than the silo and carries no dust at all, ' +
      'which means it is coming from somewhere with nothing in it to disturb.',
    requires: (s) => (s.silo.floors || []).filter((f) => f.excavated).length >= 12,
    resolve: (s) => [
      { type: 'ORDER_DELTA', amount: 4, reason: 'something to talk about' },
      { type: 'MORALE_ALL', amount: 2 },
    ],
    advice:
      'Whatever is behind it is further down than you have dug. That is the only direction ' +
      'this silo has ever had.',
  },

  aquifer_drop: {
    id: 'aquifer_drop',
    name: 'The water table',
    atMinutes: 3000, // ~day 250
    headline: 'The reclaimers are pulling air',
    text:
      'Intake pressure has been falling for eleven days and nobody flagged it because it ' +
      'fell slowly. The table under the silo is lower than it was. Reclamation will hold ' +
      'the standing population; it will not hold the one you are on course for.',
    requires: (s) => s.citizenIds.length >= 70,
    resolve: (s) => [
      { type: 'RESOURCE_DELTA', deltas: { water: -Math.round((s.resources.water || 0) * 0.35) } },
      { type: 'ORDER_DELTA', amount: -4, reason: 'the water' },
    ],
    advice: 'Water is the one shortage that kills faster than it warns. Build ahead of the headcount, not behind it.',
  },

  hollowing: {
    id: 'hollowing',
    name: 'A silo goes quiet',
    atMinutes: 3840, // ~day 320
    headline: 'Silo Seventeen has stopped answering',
    text:
      'Nine days of scheduled traffic missed. The operator has been calling on the hour ' +
      'because she knew the man on the other end. This morning the carrier was up and ' +
      'nobody was on it, which is worse than the carrier being down.',
    requires: (s) => (s.world.radioTier || 0) > 0,
    resolve: (s) => [
      {
        type: 'WORLD_EVENT_QUEUE',
        event: { kind: 'refugees', fromSilo: 17, day: s.clock.day, count: 9 },
      },
      { type: 'ORDER_DELTA', amount: -3, reason: 'Silo 17' },
    ],
    advice: 'They walked. Air capacity decides how many of them you can take, and that was decided months ago.',
  },

  deep_contamination: {
    id: 'deep_contamination',
    name: 'Contamination',
    atMinutes: 4800, // ~day 400
    headline: 'The dosimeter on the deep stair is climbing',
    text:
      'Slowly, and only below the mid floors, and only since the digging reached the shale. ' +
      'Nobody has been made sick yet. The reading is the kind that does not make anybody ' +
      'sick for a long time and then makes everybody sick at once.',
    requires: (s) => (s.silo.floors || []).filter((f) => f.excavated).length >= 40,
    resolve: (s) => {
      const actions = [{ type: 'RESOURCE_DELTA', deltas: { filters: -Math.min(30, s.resources.filters || 0) } }];
      actions.push({ type: 'ORDER_DELTA', amount: -4, reason: 'the readings on the deep stair' });
      return actions;
    },
    advice: 'A Chem Lab makes filter media and nothing else does. This is the point where that stops being optional.',
  },

  tithe_due: {
    id: 'tithe_due',
    name: 'The tithe',
    atMinutes: 5760, // ~day 480
    headline: 'The Anvil has sent a number',
    text:
      'Not a demand this time, an invoice. Tonnages, a delivery window, and a line at the ' +
      'bottom noting what they assess your garrison at — which is close enough to correct ' +
      'that somebody has been counting. Marshal Sayen adds, in her own hand: "You have ' +
      'been reasonable so far."',
    requires: (s) => !!s.world.silos[5],
    resolve: (s) => [
      { type: 'SILO_PATCH', siloId: 5, patch: { known: true, contact: 'radio' } },
      {
        type: 'SILO_MEMORY',
        siloId: 5,
        entry: { day: s.clock.day, kind: 'threatened', weight: -6, text: 'The Anvil put a number on us.' },
      },
      { type: 'ORDER_DELTA', amount: -5, reason: 'the Anvil’s tithe' },
    ],
    advice:
      'A squad standing at your own door is worth more against this than one out in the ' +
      'waste. So is a neighbour who owes you something.',
  },

  the_question: {
    id: 'the_question',
    name: 'The question',
    atMinutes: 6720, // ~day 560
    headline: 'Somebody has asked, out loud, what the surface is like',
    text:
      'A schoolteacher on floor six, in a lesson, to a room of eleven-year-olds. She was ' +
      'not agitating. She was answering a question honestly, which is that she does not ' +
      'know and neither does anybody else, and that the readings the silo publishes come ' +
      'from a machine nobody living has seen. Three parents have complained. Two more have ' +
      'asked whether she is right.',
    requires: (s) => s.stats.expeditionsReturned > 0,
    resolve: (s) => [
      { type: 'ORDER_DELTA', amount: -6, reason: 'the question' },
      { type: 'DISSENT_SET', value: (s.order.dissentPressure || 0) + 2 },
      { type: 'MORALE_ALL', amount: -1 },
    ],
    advice:
      'The Origin Record is the only thing in this game that answers her. Everything else ' +
      'is a way of not being asked again.',
  },

  floor_ninety_one: {
    id: 'floor_ninety_one',
    name: 'Floor ninety-one',
    atMinutes: 7800, // ~day 650
    headline: 'There is a machine down there that is still running',
    text:
      'A dig crew on the deep stair reports power draw from a sealed bay on ninety-one that ' +
      'is not on your grid and never has been. Whatever is in there has its own supply, has ' +
      'had it for a very long time, and is doing something often enough to show up on a ' +
      'meter. The crew would like to know whether to open it. They would also like it noted ' +
      'that they asked.',
    requires: (s) => (s.silo.floors || []).filter((f) => f.excavated).length >= 70,
    resolve: (s) => [
      { type: 'ORDER_DELTA', amount: 3, reason: 'something worth knowing' },
      { type: 'MORALE_ALL', amount: 2 },
    ],
    advice:
      'Nothing in the silo publishes a number it did not get from somewhere. This is where ' +
      'the dosimeter readings come from.',
  },
};

export const CRISIS_LIST = Object.values(CRISES).sort((a, b) => a.atMinutes - b.atMinutes);

// ------------------------------------------------------------------ flavour --

/**
 * Small, cheap events that give the silo texture between crises. Weighted,
 * rolled once a day, and none of them are decisions — they are things that
 * happened, which the player reads about and adjusts to.
 */
export const FLAVOUR = [
  {
    id: 'birth_of_twins', weight: 4,
    requires: (s) => s.citizenIds.length > 40,
    text: 'Twins on floor three. The clinic is pleased with itself and the residence is not.',
    effects: () => [{ type: 'ORDER_DELTA', amount: 1.5, reason: 'good news' }],
  },
  {
    id: 'ration_argument', weight: 8,
    requires: (s) => s.order.value < 55,
    text: 'A fight in the cafeteria queue. Both of them are in holding and neither will say who started it.',
    effects: () => [{ type: 'ORDER_DELTA', amount: -1.5, reason: 'a fight' }],
  },
  {
    id: 'old_recording', weight: 5,
    requires: (s) => s.research.completed.length > 3,
    text:
      'Somebody found a pre-Collapse recording in the archive stacks. Forty minutes of a ' +
      'man reading weather reports for a place none of the maps have.',
    effects: () => [{ type: 'MORALE_ALL', amount: 1 }],
  },
  {
    id: 'pipe_burst', weight: 7,
    requires: (s) => Object.values(s.silo.rooms).some((r) => r.condition < 70),
    text: 'A feed line let go on the mid floors. Maintenance caught it inside a shift.',
    effects: (s) => [{ type: 'RESOURCE_DELTA', deltas: { water: -Math.round(s.resources.water * 0.05) } }],
  },
  {
    id: 'good_harvest', weight: 6,
    requires: (s) => Object.values(s.silo.rooms).some((r) => r.type === 'hydroponics'),
    text: 'A better yield than the schedule predicted. Nobody can explain it and nobody is asking hard.',
    effects: (s) => [{ type: 'RESOURCE_DELTA', deltas: { food: 60 } }],
  },
  {
    id: 'name_day', weight: 5,
    text:
      'Somebody has painted a name on the stairwell bulkhead on floor two. It is the name ' +
      'of a resident who died last year. Nobody has painted over it.',
    effects: () => [{ type: 'MORALE_ALL', amount: 1 }],
  },
  {
    id: 'suit_found', weight: 3,
    requires: (s) => s.research.completed.includes('env_suit_1'),
    text: 'A sealed env-suit, pre-Collapse pattern, in a locker nobody had opened. The seals held.',
    effects: () => [{ type: 'RESOURCE_DELTA', deltas: { alloy: 14, parts: 12 } }],
  },
  {
    id: 'quiet_shift', weight: 10,
    text: 'A shift with nothing in the log. The first in a while.',
    effects: () => [{ type: 'MORALE_ALL', amount: 0.5 }],
  },
  {
    id: 'radio_ghost', weight: 4,
    requires: (s) => s.world.radioTier > 0,
    text:
      'The operator logged a carrier on a Compact frequency for eleven minutes. No traffic, ' +
      'no callsign. It was not any of the nineteen.',
    effects: () => [],
    kind: 'radio',
  },
  {
    id: 'stairwell_shrine', weight: 4,
    requires: (s) => s.stats.deaths > 12,
    text:
      'Somebody has been leaving things at the bottom of the stairwell. Small things. ' +
      'A comb, a spoon, a child’s shoe. Nobody will say whose.',
    effects: () => [],
  },
];

// ------------------------------------------------------------------ endings --

/**
 * Three endings, mutually exclusive (spec §16). Each one is checked against
 * state; the first that qualifies fires. They are deliberately hard and
 * deliberately different — the Compact is patient, Dominion is expensive,
 * and Surface is the only one that answers the actual question.
 */
export const ENDINGS = [
  {
    id: 'compact',
    name: 'The Compact',
    check: (s) => {
      const allies = Object.values(s.world.silos).filter((x) =>
        (x.treaties || []).some((t) => t.kind === 'alliance')
      ).length;
      const registry = s.world.silos[9];
      return (
        allies >= BAL.endings.compactAlliesRequired &&
        registry &&
        registry.reputation > 60 &&
        s.research.completed.includes('origin_record')
      );
    },
    text:
      'The Custodian transmits for eleven hours without stopping. The Origin Record is not ' +
      'a story; it is an index, and what it indexes is a decision — made by people with ' +
      'names, in a room, about who would be allowed to survive and who would be told they ' +
      'had been chosen. Eight silos hear it at once, because eight silos asked together. ' +
      'The Compact was never a treaty between silos. It was a gag order, and you have just ' +
      'watched twenty of them take it off.',
  },
  {
    id: 'dominion',
    name: 'Dominion',
    check: (s) =>
      s.world.satellites.length >= BAL.endings.dominionSilosRequired &&
      s.research.completed.includes('origin_record'),
    text:
      'You take the Registry the way you took the other five: charges on the outer door and ' +
      'five floors of people who did not want you. The Custodian is eighty-one and does not ' +
      'run. She hands you the Record and asks, without any particular edge, whether you ' +
      'intend to read it or only to own it. It says the silos were an experiment in who ' +
      'would still be governable after everything else was gone. You are the result they ' +
      'were looking for.',
  },
  {
    id: 'surface',
    name: 'Surface',
    check: (s) =>
      s.research.completed.includes('origin_record') &&
      s.research.completed.includes('env_suit_4') &&
      (s.map.discovered || []).includes('scar'),
    text:
      'The dosimeter at the centre of the Scar reads lower than the one at your airlock. ' +
      'It has read lower for a long time. The air is thin and cold and it will not kill ' +
      'anybody, and the readings your silo has been given for three generations were ' +
      'produced by a machine on floor ninety-one that has one job. The surface has been ' +
      'survivable for at least forty years. Somebody decided you should not know that, ' +
      'and then that somebody died, and the machine kept going.',
  },
];

export default { CRISES, CRISIS_LIST, FLAVOUR, ENDINGS };
