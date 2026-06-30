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

// Schedule (data/schedule.json) must cover all 104 matches: every group's 6
// PAIR_ORDER slots exactly once (matchdays 1-3), and every knockout match.
{
  const schedule = JSON.parse(readFileSync(new URL("../data/schedule.json", import.meta.url)));
  check(schedule.length === 104, "schedule has 104 matches");
  check(new Set(schedule.map((e) => e.m)).size === 104, "schedule match numbers unique");
  const groupEntries = schedule.filter((e) => e.round === "GROUP");
  check(groupEntries.length === 72, "schedule has 72 group matches");
  check(groupEntries.every((e) => e.md === Math.floor((e.m - 1) / 24) + 1), "schedule matchdays follow match number");
  for (const g of GROUP_IDS) {
    const slots = groupEntries.filter((e) => e.g === g).map((e) => e.slot).sort();
    check(JSON.stringify(slots) === "[0,1,2,3,4,5]", `schedule group ${g} covers all 6 slots`);
  }
  const koNums = tournament.knockout.map((d) => d.m).sort((a, b) => a - b);
  const schedKo = schedule.filter((e) => e.round !== "GROUP").map((e) => e.m).sort((a, b) => a - b);
  check(JSON.stringify(koNums) === JSON.stringify(schedKo), "schedule knockout matches match tournament.json");
}

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

// Spot-check scoring tiers on a single group match (base P = 4)
import { scoreGroupMatch, scoreKnockoutMatch } from "../js/core.js";
const sc = tournament.scoring;
// Tiers: correct result = P(4), + goal difference (W/L) = P*1.5(6), exact = P*2(8)
check(scoreGroupMatch(sc, [2, 1], [2, 1]) === 8, "exact score = 2P");
check(scoreGroupMatch(sc, [2, 1], [3, 2]) === 6, "correct winner + same goal diff = 1.5P");
check(scoreGroupMatch(sc, [1, 0], [2, 1]) === 6, "correct winner + same goal diff = 1.5P");
check(scoreGroupMatch(sc, [2, 1], [3, 1]) === 4, "correct winner, wrong goal diff = P");
check(scoreGroupMatch(sc, [2, 1], [5, 3]) === 4, "correct winner, wrong goal diff = P");
check(scoreGroupMatch(sc, [2, 1], [1, 2]) === 0, "wrong winner = 0 (no score-only points)");
check(scoreGroupMatch(sc, [3, 0], [0, 3]) === 0, "everything wrong = 0");
// Draws: only the exact score upgrades; no goal-difference bonus for ties.
check(scoreGroupMatch(sc, [2, 2], [3, 3]) === 4, "correct draw, not exact = P (no GD bonus)");
check(scoreGroupMatch(sc, [2, 2], [2, 2]) === 8, "exact draw = 2P");
check(scoreGroupMatch(sc, [0, 0], [1, 1]) === 4, "correct draw, not exact = P");
check(scoreGroupMatch(sc, [1, 1], [2, 0]) === 0, "predicted draw, actual win = 0");

// Knockout: P doubles to 8 in R32; "result" = the team you advanced advancing.
const A = (home, away, score, pens) => {
  const side = score[0] > score[1] ? 1 : score[1] > score[0] ? 2 : pens;
  return { home, away, score, winner: side === 1 ? home : away };
};
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "BRA", score: [2, 1], winner: "GER" },
  A("GER", "BRA", [2, 1])) === 16, "KO exact score = 2P");
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "BRA", score: [3, 2], winner: "GER" },
  A("GER", "BRA", [2, 1])) === 12, "KO correct winner + goal diff = 1.5P");
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "BRA", score: [4, 1], winner: "GER" },
  A("GER", "BRA", [2, 1])) === 8, "KO correct winner, wrong goal diff = P");
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "BRA", score: [2, 1], winner: "GER" },
  A("BRA", "GER", [2, 1])) === 0, "KO wrong advancer = 0");
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "ARG", score: [3, 2], winner: "GER" },
  A("GER", "BRA", [2, 1])) === 8, "KO right advancer, opponent wrong = P (no score compare)");
// Penalty shootouts: predicting the shootout winner (a draw + the right side) = 2P.
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "BRA", score: [1, 1], winner: "GER" },
  A("GER", "BRA", [1, 1], 1)) === 16, "KO exact draw + right pens winner = 2P");
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "BRA", score: [2, 2], winner: "GER" },
  A("GER", "BRA", [1, 1], 1)) === 12, "KO right pens winner, inexact draw = 1.5P");
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "BRA", score: [1, 1], winner: "BRA" },
  A("GER", "BRA", [1, 1], 1)) === 0, "KO wrong pens winner = 0");
check(scoreKnockoutMatch(sc, "R32", { home: "GER", away: "BRA", score: [2, 1], winner: "GER" },
  A("GER", "BRA", [1, 1], 1)) === 8, "KO advanced via pens but predicted a regulation win = P");

// ---------------------------------------------------------------------------
// Auto-fetch mapping/merging (scripts/fetch-results.mjs)
import { buildTeamLookup, teamCode, extractScore, applyFixtures } from "./fetch-results.mjs";

const eqJ = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const lookup = buildTeamLookup(tournament);
const T = (tla, name) => ({ tla, name });
check(teamCode(lookup, T("GER", "Germany")) === "GER", "team lookup by TLA");
check(teamCode(lookup, T("XXX", "Côte d'Ivoire")) === "CIV", "team lookup: accented alias");
check(teamCode(lookup, T(null, "Czech Republic")) === "CZE", "team lookup: Czech Republic");
check(teamCode(lookup, T(null, "Korea Republic")) === "KOR", "team lookup: Korea Republic");
check(teamCode(lookup, T(null, "Cabo Verde")) === "CPV", "team lookup: Cabo Verde");
check(teamCode(lookup, T(null, "Türkiye")) === "TUR", "team lookup: Türkiye");
check(teamCode(lookup, T(null, "Atlantis")) === null, "team lookup: unknown -> null");

check(eqJ(extractScore({ duration: "REGULAR", fullTime: { home: 2, away: 1 } }),
  { score: [2, 1], pens: null }), "extract: regular time");
check(eqJ(extractScore({ duration: "EXTRA_TIME", fullTime: { home: 3, away: 2 } }),
  { score: [3, 2], pens: null }), "extract: extra time");
check(eqJ(extractScore({ duration: "PENALTY_SHOOTOUT", winner: "AWAY_TEAM",
  fullTime: { home: 1, away: 1 }, penalties: { home: 3, away: 4 } }),
  { score: [1, 1], pens: 2 }), "extract: shootout, fullTime = AET");
check(eqJ(extractScore({ duration: "PENALTY_SHOOTOUT", winner: "HOME_TEAM",
  fullTime: { home: 5, away: 4 }, regularTime: { home: 1, away: 1 },
  extraTime: { home: 0, away: 0 }, penalties: { home: 4, away: 3 } }),
  { score: [1, 1], pens: 1 }), "extract: shootout, fullTime includes pens");
check(eqJ(extractScore({ duration: "PENALTY_SHOOTOUT", winner: "HOME_TEAM",
  fullTime: { home: 4, away: 2 }, penalties: { home: 3, away: 1 } }),
  { score: [1, 1], pens: 1 }), "extract: shootout, AET reconstructed from pens");

const fxG = (h, a, hg, ag) => ({ status: "FINISHED", stage: "GROUP_STAGE",
  homeTeam: { tla: h }, awayTeam: { tla: a },
  score: { duration: "REGULAR", fullTime: { home: hg, away: ag } } });
const emptyResults = { groups: {}, knockout: {} };
{
  // Group A is MEX, RSA, KOR, CZE: KOR v MEX is PAIR_ORDER slot 2 ([0, 2]),
  // stored MEX-first, so the API's 1-2 lands as [2, 1].
  const r1 = applyFixtures(tournament, emptyResults, emptyResults, [fxG("KOR", "MEX", 1, 2)]);
  check(eqJ(r1.results.groups.A?.[2], [2, 1]), "group fixture oriented into PAIR_ORDER slot");
  check(eqJ(r1.auto.groups.A?.[2], [2, 1]), "auto snapshot records the API value");
  check(r1.warnings.length === 0, "clean group fixture maps without warnings");

  // Entry differing from the last auto snapshot = manual override, preserved.
  const curOv = { groups: { A: [null, null, [5, 5], null, null, null] }, knockout: {} };
  const r2 = applyFixtures(tournament, curOv, r1.auto, [fxG("KOR", "MEX", 1, 2)]);
  check(eqJ(r2.results.groups.A[2], [5, 5]), "manual group override preserved");

  // Entry equal to the last auto snapshot = auto-owned, corrections flow through.
  const curAuto = { groups: { A: [null, null, [2, 1], null, null, null] }, knockout: {} };
  const r3 = applyFixtures(tournament, curAuto, r1.auto, [fxG("KOR", "MEX", 1, 3)]);
  check(eqJ(r3.results.groups.A[2], [3, 1]), "auto-owned entry updated by API correction");
}

{
  // Knockout assignment from real standings, including an R16 fixture that
  // depends on R32 winners recorded in the same batch.
  const { groups } = randomBracket(mulberry32(7));
  const tables = computeAllTables(tournament, groups);
  const cur = { groups, knockout: {} };
  const prevAuto = { groups, knockout: {} };
  const ruA = tables.A[1].code, ruB = tables.B[1].code;
  const wF = tables.F[0].code, ruC = tables.C[1].code;
  const fxKO = (stage, h, a, hg, ag, pens) => ({ status: "FINISHED", stage,
    homeTeam: { tla: h }, awayTeam: { tla: a },
    score: pens
      ? { duration: "PENALTY_SHOOTOUT", winner: pens === 1 ? "HOME_TEAM" : "AWAY_TEAM",
          fullTime: { home: hg, away: ag },
          penalties: pens === 1 ? { home: 4, away: 3 } : { home: 3, away: 4 } }
      : { duration: "REGULAR", fullTime: { home: hg, away: ag } } });
  const batch = [
    fxKO("LAST_32", ruA, ruB, 1, 1, 2),   // m73 (RU A v RU B), ruB on pens
    fxKO("LAST_32", ruC, wF, 0, 2, null), // m75 (W F v RU C), API order swapped
    fxKO("LAST_16", ruB, wF, 1, 0, null), // m90 = WM73 v WM75, same batch
  ];
  const r = applyFixtures(tournament, cur, prevAuto, batch);
  check(eqJ(r.results.knockout["73"], { home: ruA, away: ruB, score: [1, 1], pens: 2 }),
    "R32 fixture assigned via group anchors (m73)");
  check(eqJ(r.results.knockout["75"], { home: ruC, away: wF, score: [0, 2], pens: null }),
    "R32 assignment ignores home/away order (m75)");
  check(eqJ(r.results.knockout["90"], { home: ruB, away: wF, score: [1, 0], pens: null }),
    "R16 resolves from same-batch R32 winners (m90)");
  check(r.warnings.length === 0, "knockout batch maps without warnings");

  // Propagation: with the groups final, every still-unplayed R32 slot carries
  // its teams (score-less) — e.g. m84 = Winner H v Runner-up J, never in the
  // batch. Later rounds whose feeders haven't been played stay absent (m95).
  check(eqJ(r.results.knockout["84"],
    { home: tables.H[0].code, away: tables.J[1].code, score: null, pens: null }),
    "unplayed R32 slot propagated from final group tables (m84)");
  check(r.results.knockout["95"] == null, "R16 absent until its R32 feeders are played (m95)");

  // Organizer-corrected knockout entry survives the next fetch.
  const curKoOv = { groups, knockout: { 73: { home: ruA, away: ruB, score: [2, 1], pens: null } } };
  const r2 = applyFixtures(tournament, curKoOv, { groups, knockout: r.auto.knockout }, batch.slice(0, 2));
  check(eqJ(r2.results.knockout["73"], { home: ruA, away: ruB, score: [2, 1], pens: null }),
    "manual knockout override preserved");
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("All self-tests passed.");
