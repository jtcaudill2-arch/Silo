/**
 * briefing.js — the handover (spec §17, Phase 10).
 *
 * The tutorial is a document, not an overlay with arrows on it. Your
 * predecessor left it on the desk, and it teaches the game by being a
 * competent person's honest account of the job: here is what will kill you
 * first, here is the order I would do things in, here is the thing nobody
 * told me. Everything factual in it is true of the simulation.
 *
 * The voice is administrative and unsentimental — this is a person filing a
 * handover note, not a narrator. She is original to this game, as is
 * everything else in it.
 */

export const PREDECESSOR = {
  name: 'Halvard Sten',
  title: 'Mayor of Silo 12',
  years: 'Y0–Y14',
};

/**
 * Sections of the note. Each is a screen. `heading` is the only thing set
 * in display type; the body is prose, deliberately, because the game is
 * read rather than watched.
 */
export const BRIEFING = [
  {
    id: 'open',
    heading: 'To whoever has the desk',
    body: [
      'You will have been told that the office is mostly signatures. It is not. ' +
        'The office is deciding which of two things gets the power, and then living ' +
        'in the silo where you decided it.',
      'I ran this place for fourteen years. I am handing you a silo of a hundred and ' +
        'eighty people, ninety-two floors of which fourteen are dug, and about a season ' +
        'of margin on everything that matters. That margin is smaller than it sounds.',
      'What follows is what I would want to have been told. It is not encouraging. ' +
        'It is accurate, which is better.',
    ],
  },
  {
    id: 'first',
    heading: 'The first thing that kills you',
    body: [
      'Not raiders. Not the sky. Arithmetic.',
      'Every room draws power, and the generator hall only makes so much. When demand ' +
        'passes supply the floors go dark from the bottom of your priority list upward — ' +
        'and a browned-out water reclaimer does not reclaim water. People do not die of ' +
        'the brownout. They die four days later, of thirst, and by then the decision that ' +
        'killed them is a long way back in the log.',
      'Check the flow figures, not the stockpiles. A tank that is full and falling is a ' +
        'worse position than a tank that is low and rising.',
    ],
  },
  {
    id: 'build',
    heading: 'The order I would build in',
    body: [
      'Recycling first, then the Workshop. Neither of them is interesting and both are ' +
        'mandatory: scrap and parts are what every other room is made of, and the stock ' +
        'in the depot buys you four or five buildings and then nothing, ever again.',
      'A Laboratory third. Nothing else in the silo produces research points, and every ' +
        'tier below the Mids, every env-suit, every treaty and the chem lab that keeps ' +
        'your clinic stocked is behind one. I left it until I felt comfortable. I was ' +
        'wrong by about a hundred days.',
      'After that, react. Water, food and air in whatever order they are threatening you.',
    ],
  },
  {
    id: 'outside',
    heading: 'The surface',
    body: [
      'You will be tempted to treat the airlock as a luxury. It is the opposite: it is the ' +
        'only lever you have that grows the silo faster than the birth rate. Salvage, ' +
        'recruits, and the artifacts that half the research tree is gated behind — all of ' +
        'it is out there and none of it is down here.',
      'It costs a chain, not a room: Env-Suit research, an Airlock, a Suit Bay, an Armory ' +
        'for the weapons, a Foundry for the alloy the suits are made of, and a Chem Lab, ' +
        'because a squad that comes home cannot be decontaminated without filters and ' +
        'nothing else in the silo makes any.',
      'Do not send anybody you cannot clean when they get back. Skipping decontamination ' +
        'does not put the dose on the squad. It puts it, thinly, on all of us, and it does ' +
        'not leave.',
    ],
  },
  {
    id: 'people',
    heading: 'They are not workers',
    body: [
      'Every name on the roster has a health, a morale, a set of relationships and an ' +
        'opinion of you. They form friendships in the rooms they work in and the corridors ' +
        'they live on. When one of them dies, the people who were close to them get worse ' +
        'at their jobs for a while, and that is not a bug in the model, it is the model.',
      'Order is the number that decides whether any of this holds. Below twenty-five for ' +
        'three days is where a rising starts. You have levers — rationing, curfew, a ' +
        'sheriff — and every one of them buys order by spending morale. There is no lever ' +
        'that is free. I want to be clear about that, because I spent two years looking ' +
        'for one.',
    ],
  },
  {
    id: 'close',
    heading: 'The thing nobody told me',
    body: [
      'The silo keeps running when you are not watching. Close the door, come back ' +
        'tomorrow, and there will be a report waiting that tells you exactly what happened ' +
        'and who it happened to. Read it. All of it. The names are the point.',
      'There is a question underneath all of this that I never got an answer to, and you ' +
        'will find the edges of it in the radio traffic and the deep salvage. I would tell ' +
        'you not to go looking. You will go looking.',
      '— Halvard Sten, Mayor of Silo 12, Y0–Y14',
    ],
  },
];

export default BRIEFING;
