// Sanity checks for the shared bracket/scoring logic.
// Run: node scripts/selftest.mjs
import { readFileSync } from "node:fs";
import {
  GROUP_IDS, PAIR_ORDER, buildBracket, encodePayload, decodePayload,
  validateBracket, expandPrediction, scoreUser, rankThirds, computeAllTables,
} from "../js/core.js";

const tournament = JSON.parse(readFileSync(new URL("../data/tournament.json", import.meta.url)));

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error(`FAIL: ${msg}`); }
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomBracket(rand) {
  const groups = {};
  for (const g of GROUP_IDS) {
    groups[g] = PAIR_ORDER.map(() => [Math.floor(rand() * 5), Math.floor(rand() * 5)]);
  }
  const ko = {};
  for (const def of tournament.knockout) {
    const h = Math.floor(rand() * 4), a = Math.floor(rand() * 4);
    ko[def.m] = { score: [h, a], pens: h === a ? (rand() < 0.5 ? 1 : 2) : null };
  }
  return { groups, ko };
}

// Static structure checks
check(tournament.knockout.length === 32, "32 knockout matches defined");
check(tournament.knockout.filter((d) => d.a.t === "3").length === 8, "8 third-place slots");
check(GROUP_IDS.every((g) => tournament.groups[g]?.length === 4), "12 groups of 4 teams");
const allCodes = GROUP_IDS.flatMap((g) => tournament.groups[g].map((t) => t.code));
check(new Set(allCodes).size === 48, "48 unique team codes");

const rand = mulberry32(2026);
for (let trial = 0; trial < 500; trial++) {
  const { groups, ko } = randomBracket(rand);
  const name = "Test User";

  // Encode/decode round trip
  const payload = encodePayload(name, groups, ko);
  const decoded = decodePayload(payload);
  check(JSON.stringify(decoded.groups) === JSON.stringify(groups), `t${trial}: group round-trip`);
  check(JSON.stringify(decoded.ko) === JSON.stringify(ko), `t${trial}: ko round-trip`);
  check(payload.length < 1200, `t${trial}: payload compact (${payload.length})`);

  // Validation + bracket integrity
  const v = validateBracket(tournament, decoded);
  check(v.ok, `t${trial}: random complete bracket validates (${v.errors?.[0]})`);
  if (!v.ok) continue;

  const bracket = buildBracket(tournament, groups, ko);
  const tables = computeAllTables(tournament, groups);
  // Third allocation: 8 distinct groups, each in its slot's allowed list
  const qualified = rankThirds(tables).slice(0, 8).map((x) => x.group);
  const assigned = Object.values(bracket.alloc);
  check(new Set(assigned).size === 8, `t${trial}: 8 distinct thirds assigned`);
  check(assigned.every((g) => qualified.includes(g)), `t${trial}: assigned thirds are qualified`);
  for (const def of tournament.knockout.filter((d) => d.a.t === "3")) {
    check(def.a.o.includes(bracket.alloc[def.m]), `t${trial}: match ${def.m} third from allowed group`);
  }
  // Every knockout match resolved, no team plays twice in one round
  for (const r of ["R32", "R16", "QF", "SF"]) {
    const teams = tournament.knockout.filter((d) => d.r === r).flatMap((d) => {
      const m = bracket.matches[d.m];
      return [m.home, m.away];
    });
    check(teams.every(Boolean), `t${trial}: all ${r} slots resolved`);
    check(new Set(teams).size === teams.length, `t${trial}: no duplicate team in ${r}`);
  }
  check(bracket.matches[104].winner, `t${trial}: champion resolved`);

  // A prediction scored against itself = perfect score everywhere
  const expanded = expandPrediction(tournament, decoded, { user: "tester", submittedAt: "now" });
  const results = { groups, knockout: expanded.knockout };
  const { total, stages } = scoreUser(tournament, expanded, results);
  const m = tournament.scoring.multipliers, base = tournament.scoring.base;
  const expected =
    72 * 2 * base * m.GROUP + 16 * 2 * base * m.R32 + 8 * 2 * base * m.R16 +
    4 * 2 * base * m.QF + 2 * 2 * base * m.SF + 2 * base * m["3P"] + 2 * base * m.F;
  check(total === expected, `t${trial}: perfect self-score ${total} === ${expected}`);
  check(Object.values(stages).every((x) => Number.isInteger(x)), `t${trial}: integer stage points`);
}

// Spot-check scoring tiers on a single group match
import { scoreGroupMatch } from "../js/core.js";
const sc = tournament.scoring;
check(scoreGroupMatch(sc, [2, 1], [2, 1]) === 8, "exact pick = 2x base");
check(scoreGroupMatch(sc, [2, 1], [3, 1]) === 6, "winner + exact one side = base + base/2");
check(scoreGroupMatch(sc, [2, 1], [3, 2]) === 6, "winner + close both = base + base/2");
check(scoreGroupMatch(sc, [2, 1], [5, 2]) === 5, "winner + close one = base + base/4");
check(scoreGroupMatch(sc, [2, 1], [5, 3]) === 4, "winner only = base");
check(scoreGroupMatch(sc, [2, 1], [1, 2]) === 2, "wrong winner, close both = base/2");
check(scoreGroupMatch(sc, [0, 0], [1, 1]) === 6, "draw pick + close both = base + base/2");
check(scoreGroupMatch(sc, [3, 0], [0, 3]) === 0, "everything wrong = 0");

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("All self-tests passed.");
