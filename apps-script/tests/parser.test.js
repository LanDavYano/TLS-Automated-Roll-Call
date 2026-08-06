/**
 * Fixture tests for the pure layers — Parser.js, Groups.js, Template.js.
 *
 * Run with:  node apps-script/tests/parser.test.js
 *
 * These files deliberately avoid SpreadsheetApp/Utilities/Logger so they can be
 * exercised outside the Apps Script runtime. This is what makes that property
 * pay for itself.
 *
 * The failure this guards against is silent by construction. A Groups keyword
 * that stops matching does not throw, does not log, and does not alert — the
 * roll call simply never arrives, and nobody notices until a staffer asks why
 * they weren't tagged. `esports` not being a substring of `VALORANT` is exactly
 * that shape of bug, and every case below is a real event name from the tracker
 * or from the season's schedule.
 *
 * Apps Script shares one global scope across files, so the sources are
 * concatenated and evaluated together rather than required as modules.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCES = ['Parser.js', 'Groups.js', 'Template.js', 'Log.js'];

const context = vm.createContext({ console });
vm.runInContext(
  SOURCES.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n'),
  context
);

// Log.js's ledger reads the spreadsheet. Swap in an in-memory one AFTER loading,
// so findPriorSend_ — the thing that makes a mid-season mode change safe — can be
// exercised. It resolves hasBeenSent_ from the global scope at call time, so the
// replacement takes effect.
const SENT = {};
context.hasBeenSent_ = (key) => SENT[key] === true;

const {
  parseEventName_, sportFamily_, eventCategory_, resolveTarget_, normalizeMode_,
  normalizeForMatch_, splitKeywords_, sportMatchesKeyword_, groupEventsForSending_,
  renderDigest_, collapseTimes_, buildGroupKey_, findPriorSend_,
} = context;

let failures = 0;
let checks = 0;

function check(label, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures++;
    console.log(`  FAIL  ${label}\n          expected ${e}\n          actual   ${a}`);
  }
}

function section(name) {
  console.log(`\n${name}`);
}

// ---------------------------------------------------------------------
// The Groups tab as the season is configured (row order = priority)
// ---------------------------------------------------------------------

const GROUPS = [
  ['fencing', '-100', '11', 'session'],
  ['athletics', '-101', '11', 'session'],
  ['golf', '-102', '11', 'session'],
  ['3x3', '-200', '12', 'session'],
  ['basketball', '-200', '12', 'event'],
  ['blitz chess', '-300', '13', 'session'],
  ['chess', '-300', '13', 'session'],
  ['beach volleyball', '-400', '14', 'event'],
  ['volleyball', '-400', '14', 'event'],
  ['football', '-500', '15', 'event'],
  ['baseball, softball', '-600', '16', 'event'],
  ['esports, valorant, nba2k', '-700', '17', 'event'],
];

const groupMap = GROUPS.map((r, i) => ({
  keyword: normalizeForMatch_(r[0]),
  keywords: splitKeywords_(r[0]),
  label: r[0],
  chatId: r[1],
  threadId: r[2],
  mode: normalizeMode_(r[3]),
  rowNumber: i + 2,
}));

/** A parsed event, as parseMonthEvents would produce it. */
function event(name, overrides) {
  const p = parseEventName_(name);
  return Object.assign({
    year: 2026, month: 3, day: 13, weekday: 'Friday',
    sport: p.sport, family: p.family, category: p.category,
    opponent: p.opponent, hasOpponent: p.hasOpponent,
    detail: p.detail, rawName: p.raw,
    venue: 'Makati Coliseum', time: '9:00 am',
    deliverables: ['HN', 'Buzzer', 'Album Caption'],
    recapNames: ['Jireh'], livetweetNames: ['Migo'],
    sheetRow: 5,
  }, overrides || {});
}

// ---------------------------------------------------------------------

section('Sport family — what session mode collates by');

[
  ["R1 Men's Football: DLSU v UST", 'Football'],
  ["R1 Women's Football: DLSU v ADMU", 'Football'],
  ["R1 Men's Basketball: DLSU v AdU", 'Basketball'],
  ["R1 Men's 3x3 Basketball: DLSU vs UP", '3x3 Basketball'],
  ["R1 Women's Chess: DLSU v ADMU", 'Chess'],
  ["R4 Men's Blitz Chess: DLSU v FEU", 'Blitz Chess'],
  ["Men's Volleyball: DLSU vs UST", 'Volleyball'],
  ["Men's Beach Volleyball: DLSU vs UST", 'Beach Volleyball'],
  ["Fencing Day 1: Men's Sabre Individual", 'Fencing'],
  ["Fencing Day 3: Men's Sabre Team", 'Fencing'],
  ["Fencing Day 2 Women's Foil Team", 'Fencing'],   // colon-less variant
  ['Athletics Day 1', 'Athletics'],
  ['Golf Day 2', 'Golf'],
  ["Men's Baseball: DLSU vs UP", 'Baseball'],
  ["Women's Softball: DLSU vs UP", 'Softball'],
  ['VALORANT: DLSU vs UP', 'VALORANT'],
  ['NBA2k: DLSU vs ADMU', 'NBA2k'],
].forEach(([name, expected]) => check(name, sportFamily_(parseEventName_(name).sport || name), expected));

// The variants that share a GC must NOT collapse into their parent sport.
check('3x3 !== Basketball',
  sportFamily_("R1 Men's 3x3 Basketball") === sportFamily_("R1 Men's Basketball"), false);
check('Blitz !== Chess',
  sportFamily_("R4 Men's Blitz Chess") === sportFamily_("R1 Men's Chess"), false);
check('Beach !== Volleyball',
  sportFamily_("Men's Beach Volleyball") === sportFamily_("Men's Volleyball"), false);
// ...while the categories of one sport must.
check("Men's/Women's Football same family",
  sportFamily_("R1 Men's Football") === sportFamily_("R1 Women's Football"), true);

section('Category — the bracket on the opponent line');

check("Men's from prefix", eventCategory_("R1 Men's Football"), "Men's");
check("Women's from prefix", eventCategory_("R1 Women's Football"), "Women's");
check("Women's not misread as Men's", eventCategory_("Women's Softball"), "Women's");
check('none when absent', eventCategory_('Athletics Day 1'), '');

section('Opponent extraction');

check('DLSU on the left', parseEventName_("R1 Men's Football: DLSU v UST").opponent, 'UST');
check('DLSU on the right', parseEventName_("R1 Men's Football: UST vs DLSU").opponent, 'UST');
check('no vs → no opponent', parseEventName_('Athletics Day 1').hasOpponent, false);
check('ceremony → no opponent', parseEventName_('UAAP: Opening ceremony').hasOpponent, false);
check('esports title keeps its own colon',
  parseEventName_('Esports Mobile Legends: Bang Bang!: DLSU vs UP').opponent, 'UP');

section('Routing — every event reaches the right GC');

[
  ["R1 Men's Football: DLSU v UST", 'football'],
  ["R1 Men's Basketball: DLSU v AdU", 'basketball'],
  ["R1 Women's 3x3 Basketball: DLSU vs UP", '3x3'],
  ["R4 Men's Blitz Chess: DLSU v FEU", 'blitz chess'],
  ["R1 Women's Chess: DLSU v ADMU", 'chess'],
  ["Men's Beach Volleyball: DLSU vs UST", 'beach volleyball'],
  ["Men's Volleyball: DLSU vs UST", 'volleyball'],
  ["Fencing Day 1: Men's Sabre Individual", 'fencing'],
  ['Athletics Day 1', 'athletics'],              // no colon — needs the raw-text pass
  ['Golf Day 2', 'golf'],                        // no colon
  ["Men's Baseball: DLSU vs UP", 'baseball, softball'],
  ["Women's Softball: DLSU vs UP", 'baseball, softball'],
  ['Esports Mobile Legends: Bang Bang!: DLSU vs UP', 'esports, valorant, nba2k'],
  ['VALORANT: DLSU vs UP', 'esports, valorant, nba2k'],   // no shared word with "esports"
  ['NBA2k: DLSU vs ADMU', 'esports, valorant, nba2k'],    // ditto
  ["Men's Volleyball Awarding", 'volleyball'],
  ['UAAP Season 88 Collegiate Basketball Press Conference', 'basketball'],
].forEach(([name, expected]) => {
  const t = resolveTarget_(event(name), groupMap, 'ADMIN');
  check(`route: ${name}`, t.label, expected);
});

// Tournament-wide events with no sport in the name are meant to reach a human.
['UAAP: Opening ceremony', 'UAAP "Light of Hope" show'].forEach((name) => {
  const t = resolveTarget_(event(name), groupMap, 'ADMIN');
  check(`route to admin: ${name}`, [t.matched, t.chatId], [false, 'ADMIN']);
});

section('Collation');

const fencing = [
  event("Fencing Day 1: Men's Sabre Individual", { sheetRow: 5 }),
  event("Fencing Day 1: Women's -- Individual", { sheetRow: 6 }),
  event("Fencing Day 1: Men's Epee Individual", { sheetRow: 7, time: '1:00 pm' }),
];
check('fencing day → 1 message', groupEventsForSending_(fencing, groupMap, 'ADMIN').length, 1);

const chess = [
  event("R4 Men's Blitz Chess: DLSU v FEU", { sheetRow: 5 }),
  event("R5 Men's Blitz Chess: DLSU v UST", { sheetRow: 6 }),
  event("R4 Women's Blitz Chess: DLSU v ADMU", { sheetRow: 7 }),
];
check('blitz chess day → 1 message', groupEventsForSending_(chess, groupMap, 'ADMIN').length, 1);

const football = [
  event("R1 Men's Football: DLSU v UE", { sheetRow: 5 }),
  event("R1 Women's Football: DLSU v UP", { sheetRow: 6 }),
];
check('two football games → 2 messages', groupEventsForSending_(football, groupMap, 'ADMIN').length, 2);

// Same GC, same day, different competitions: must not merge.
const basketball = [
  event("R1 Men's Basketball: DLSU v AdU", { sheetRow: 5 }),
  event("R1 Women's Basketball: DLSU v AdU", { sheetRow: 6 }),
  event("R1 Men's 3x3 Basketball: DLSU vs UP", { sheetRow: 7 }),
  event("R1 Women's 3x3 Basketball: DLSU vs UP", { sheetRow: 8 }),
];
check('2 basketball games + 1 merged 3x3 → 3 messages',
  groupEventsForSending_(basketball, groupMap, 'ADMIN').length, 3);

// Esports titles share a GC and a rule, but are separate games.
const esports = [
  event('VALORANT: DLSU vs UP', { sheetRow: 5 }),
  event('NBA2k: DLSU vs ADMU', { sheetRow: 6 }),
];
check('two esports titles → 2 messages', groupEventsForSending_(esports, groupMap, 'ADMIN').length, 2);

section('Time collapsing');

check('all equal', collapseTimes_([{ time: '10:00 am' }, { time: '10:00 am' }]), '10 am');
check('differing → earliest', collapseTimes_([{ time: '9:00 am' }, { time: '1:00 pm' }]), 'Beginning at 9 am');
check('out of order → still earliest', collapseTimes_([{ time: '1:00 pm' }, { time: '9:00 am' }]), 'Beginning at 9 am');
check('half hour kept', collapseTimes_([{ time: '4:30 pm' }]), '4:30 pm');
check('all blank', collapseTimes_([{ time: '' }]), 'TBA');

section('Rendering');

const config = { SEASON_NUMBER: 88, SHOW_UNASSIGNED_WARNING: true };
const staffers = { jireh: '@jirehfs', migo: '@migoyaki' };

const fencingMsg = renderDigest_(groupEventsForSending_(fencing, groupMap, 'ADMIN')[0], staffers, config);
check('session lists each detail line', fencingMsg.indexOf("Men's Sabre Individual") !== -1, true);
check('session title', fencingMsg.indexOf('UAAP Season 88 Fencing Tournament') !== -1, true);
check('session collapses time', fencingMsg.indexOf('Time: Beginning at 9 am') !== -1, true);
check('no phantom opponent', fencingMsg.indexOf('vs DLSU') === -1, true);

const chessMsg = renderDigest_(groupEventsForSending_(chess, groupMap, 'ADMIN')[0], staffers, config);
check("men's opponents bracketed", chessMsg.indexOf("[FEU, UST] vs DLSU [Men's]") !== -1, true);
check("women's single opponent unbracketed", chessMsg.indexOf("ADMU vs DLSU [Women's]") !== -1, true);
check("men's line precedes women's",
  chessMsg.indexOf("[Men's]") < chessMsg.indexOf("[Women's]"), true);

const ceremony = groupEventsForSending_([event('UAAP: Opening ceremony')], groupMap, 'ADMIN')[0];
const ceremonyMsg = renderDigest_(ceremony, staffers, config);
check('UAAP-named events keep their own title',
  ceremonyMsg.indexOf('UAAP: Opening ceremony') !== -1, true);
check('and are not double-wrapped',
  ceremonyMsg.indexOf('UAAP Season 88 UAAP') === -1, true);

const unassigned = groupEventsForSending_(
  [event("R1 Men's Football: DLSU v UE", { recapNames: [], livetweetNames: [] })], groupMap, 'ADMIN'
)[0];
check('unassigned warning still fires',
  renderDigest_(unassigned, staffers, config).indexOf('⚠️ Recap: UNASSIGNED') !== -1, true);

section('Idempotency across a mid-season mode change');

// A session-mode sport that has already been announced must stay announced when
// the rule is switched to event mode — otherwise each row posts again.
const sessionGroup = groupEventsForSending_(fencing, groupMap, 'ADMIN')[0];
SENT[buildGroupKey_(sessionGroup)] = true;

const asEventMode = groupMap.map((g) =>
  (g.label === 'fencing' ? Object.assign({}, g, { mode: 'event' }) : g));
const afterSwitch = groupEventsForSending_(fencing, asEventMode, 'ADMIN');

check('session → event splits into 3', afterSwitch.length, 3);
check('but all 3 are recognised as already sent',
  afterSwitch.every((g) => findPriorSend_(g) !== null), true);
check('and are flagged as a mode change, not a plain duplicate',
  afterSwitch.every((g) => findPriorSend_(g).sameMode === false), true);

// And the reverse: rows announced individually, then merged into a session.
Object.keys(SENT).forEach((k) => delete SENT[k]);
afterSwitch.forEach((g) => { SENT[buildGroupKey_(g)] = true; });
check('event → session is also recognised',
  findPriorSend_(groupEventsForSending_(fencing, groupMap, 'ADMIN')[0]).sameMode, false);

// An untouched sport must still report a clean "not sent".
Object.keys(SENT).forEach((k) => delete SENT[k]);
check('nothing sent → null', findPriorSend_(sessionGroup), null);

// ---------------------------------------------------------------------

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
