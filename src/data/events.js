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
    headline: 'Somebody is at the airlock',
    text:
      'Four of them, maybe five, working at the outer door with a cutting torch and no ' +
      'particular hurry. They are not equipped to get through it. They are equipped to ' +
      'find out how long it would take.',
    resolve: (s) => [
      { type: 'PENDING_RAID', siloId: 5, strength: 0.25 },
      { type: 'ORDER_DELTA', amount: -4, reason: 'raiders at the door' },
    ],
    advice:
      'They left. The next ones will know exactly how long it takes, because these ones measured it.',
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
