// api/_name-aliases.js
// Canonical rep-name aliases applied at sync ingest so one person shows under a
// single name across knocking, deals, Bria, Pronto and onboarding. The source
// systems don't always agree (a Pronto display name, a Sequifi record), and the
// dashboard's fuzzy matcher can't bridge every gap on its own — e.g. "Samantha"
// and "Sammi" aren't nickname-linked, so her Pronto/Sequifi name would split
// away from the "Sammi Boyd" she carries everywhere else. Add an entry here when
// a person's source name differs from the name they already use across the board.
//
// CommonJS to match the other shared helper (_notify.js); Vercel's bundler lets
// the ESM syncs `import` it and the CommonJS ones `require` it all the same.
//
// Key = lowercased "first last" from the source. Value = the canonical
// { first, last } used everywhere on the dashboard.
const ALIASES = {
  'samantha boyd': { first: 'Sammi', last: 'Boyd' },
  // TDS's Amplify shortens Kaimana to "Mana"; Bria and comp use her full name,
  // so her knocking would otherwise split from her deals.
  'mana mcguire': { first: 'Kaimana', last: 'McGuire' },
  // Bria stores him as a bare first name, comp has him as Christopher Lagrange,
  // and he also appears as Cristiano Mariano. All one person, so his Bria deals
  // would otherwise never join up with his own sales.
  'chris': { first: 'Christopher', last: 'Lagrange' },
  'chris lagrange': { first: 'Christopher', last: 'Lagrange' },
  'cristiano mariano': { first: 'Christopher', last: 'Lagrange' },
  // The weekly roster spells him Legrange (E), Sequifi spells him Lagrange (A).
  // Without this his crew's deals land under no leader at all.
  'chris legrange': { first: 'Christopher', last: 'Lagrange' },
  'christopher legrange': { first: 'Christopher', last: 'Lagrange' },
  // Alli and Allison are one person, and Alli is the canonical half: the install
  // report, the upfront roster, the payroll ledger and the Pay History sheet all
  // say Alli, and only Sequifi says Allison. This used to map the other way, which
  // renamed her onto a spelling nothing else used — it split her knocking (52 days
  // as Alli, 37 as Allison) and duplicated 25 of those days under both names.
  'allison lauriano': { first: 'Alli', last: 'Lauriano' },
  // Opendoor's Time Track report spells him Kierfer (extra R); the roster and
  // comp have Kiefer. Four other Neals knock on the same crew, so without this
  // his doors sit under a fifth name that never joins his deals.
  'kierfer neal': { first: 'Kiefer', last: 'Neal' },
  // Sequifi's /v1/teams is the weekly roster of record, and payroll holds legal
  // names while the rest of the app runs on what people go by. Without these,
  // eight of the forty-odd reps on a given week read as absent from their own
  // team — and "not on a team" is what marks somebody a subcontractor.
  // Each one is confirmed against the address on their Sequifi record.
  'benjamin ogara': { first: 'Ben', last: 'Ogara' },          // benogara42@
  'thomas becker': { first: 'TJ', last: 'Becker' },           // tjbeckero68@
  'angel rebollar': { first: 'Krispy', last: 'Rebollar' },    // krispywitak@
  'nathan boyd': { first: 'Nate', last: 'Boyd' },
  // Richard A. Neal goes by Trey. Four Neals knock together, so the wrong one
  // absorbing his numbers is a live risk — this is positional as well as by
  // name: Sequifi's Kiefer crew lists Richard where ours lists Trey.
  'richard neal': { first: 'Trey', last: 'Neal' },
  // Spelling, not nickname: Sequifi has these two right and the hand-typed
  // roster had them wrong, so the CORRECT spelling is the canonical one here
  // and the roster's version is what gets mapped.
  'camillo ramierz': { first: 'Camilo', last: 'Ramirez' },
  'tabitha uberti': { first: 'Tabeitha', last: 'Uberti' },
  // Typos on the Sequifi side this time, caught by the same roster comparison:
  // each of these had the person knocking under one spelling and sitting on
  // their team under another, so they read as a subcontractor on their own crew.
  'juilan chavez': { first: 'Julian', last: 'Chavez' },
  // Bria has its own transposition of the same name (i for l, not l for i), and
  // it is the only place his deals exist — with no install report rows to fall
  // back on he was invisible to upfront payroll and has never been paid.
  'juiian chavez': { first: 'Julian', last: 'Chavez' },
  'beck faggerstorm': { first: 'Beck', last: 'Fagerstrom' },
  'nikolas casas': { first: 'Nick', last: 'Casas' },
  // The new Bria (Sep 2026) was loaded with legal names. Each pair below has the
  // identical deal count since May 1 in the old and new Bria, so it is the same
  // person; without these their sales split away from the name the install
  // report and the old Bria history carry.
  'james duffy': { first: 'Drex', last: 'Duffy' },
  'nicklas anderson': { first: 'Nick', last: 'Anderson' },
  'benjamin lamoreaux': { first: 'Ben', last: 'Lamoreaux' },
  'kaitlyn clark': { first: 'Kait', last: 'Clark' },
  'mikevic hall': { first: 'Kevic', last: 'Hall' },
  'damitrus burns': { first: 'Monte', last: 'Burns' },
  // Bria user created Sep 6 2026 with "Glo" find/replaced to "Pennsylvania" in the name.
  'pennsylvaniary ellison': { first: 'Glory', last: 'Ellison' },
  // Knocking-feed spellings found in the 2026-09-14 audit. Each one split a
  // rep's doors away from the name their deals carry, and two of them (Chris
  // Lagrange, Allison Lauriano) sat next to the canonical row on the same days
  // and doubled it. Canonical = the spelling on the install report.
  'dalton hymus': { first: 'Dalton', last: 'Hymas' },        // Bluepeak Time Track
  'slone pots': { first: 'Slone', last: 'Potts' },           // Ezee Time Track
  'damion anderson': { first: 'Damien', last: 'Anderson' },  // SalesRabbit + Ezee
  'nate boyd': { first: 'Nate', last: 'Boyd' },              // casing only ("Nate boyd")
  'quaid rasmussenin': { first: 'Quaid', last: 'Rasmussen' },
};

// Map a { first, last } record to its canonical form; unchanged if no alias.
function canonicalFirstLast(first, last) {
  const key = `${String(first || '').trim()} ${String(last || '').trim()}`.trim().toLowerCase();
  const a = ALIASES[key];
  return a ? { first: a.first, last: a.last } : { first: String(first || ''), last: String(last || '') };
}

// Map a display name ("First Last", "First Last - Manager", "First Last | Team")
// to its canonical form, preserving any trailing " - …" / " | …" suffix. Returns
// the input unchanged when there's no alias for the base name. The suffix split
// mirrors the dashboard's own Pronto name cleaner (/\s*[-–|].*$/).
function canonicalDisplayName(name) {
  const raw = String(name || '');
  // Time Track appends a SalesRabbit user id to a second account for the same
  // person ("Connor Tyson*83895"); it is the same rep, so drop it.
  const trimmed = raw.trim().replace(/\*\d+$/, '').trim();
  if (!trimmed) return raw;
  const m = trimmed.match(/^(.*?)(\s*[-–|].*)$/s);
  const base = (m ? m[1] : trimmed).trim();
  const suffix = m ? m[2] : '';
  const a = ALIASES[base.toLowerCase()];
  if (a) return `${a.first} ${a.last}`.trim() + suffix;
  return trimmed === raw.trim() ? raw : base + suffix;
}

module.exports = { canonicalFirstLast, canonicalDisplayName, ALIASES };
