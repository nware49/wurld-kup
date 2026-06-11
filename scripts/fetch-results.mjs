// Fetches finished World Cup matches from football-data.org (free tier) and
// merges them into data/results.json. Run by the scheduled "Fetch live
// results" workflow; needs the FOOTBALL_DATA_TOKEN env var (repo secret).
//
// Manual overrides: data/results-auto.json holds the snapshot of what the API
// said on the last run. Any entry in results.json that differs from that
// snapshot was changed by a human (admin.html → issue, or a direct edit) and
// is never overwritten. To hand a match back to the auto-updater, delete the
// entry (or set it to the API's value) and let the next run refill it.
//
// The mapping/merging logic is pure and exported for scripts/selftest.mjs;
// main() only runs when this file is invoked directly.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  GROUP_IDS, PAIR_ORDER, computeAllTables, groupComplete, matchWinnerSide,
} from "../js/core.js";

const API_URL = "https://api.football-data.org/v4/competitions/WC/matches";

const STAGE_TO_ROUND = {
  GROUP_STAGE: "GROUP",
  LAST_32: "R32",
  ROUND_OF_32: "R32",
  LAST_16: "R16",
  ROUND_OF_16: "R16",
  QUARTER_FINALS: "QF",
  SEMI_FINALS: "SF",
  THIRD_PLACE: "3P",
  PLAY_OFF_FOR_THIRD_PLACE: "3P",
  FINAL: "F",
};

// Knockout assignment for a round depends on recorded winners of the previous
// round, so rounds must be processed in order even within one fetch batch.
const ROUND_SEQ = ["GROUP", "R32", "R16", "QF", "SF", "3P", "F"];
const FINISHED = new Set(["FINISHED", "AWARDED"]);
const MAX_GOALS = 15;

// API names that don't normalize to the tournament.json name or FIFA code.
const NAME_ALIASES = {
  czechrepublic: "CZE",
  turkey: "TUR",
  korearepublic: "KOR",
  cotedivoire: "CIV",
  caboverde: "CPV",
  capeverdeislands: "CPV",
  bosniaandherzegovina: "BIH",
  congodr: "COD",
  drcongo: "COD",
  democraticrepublicofthecongo: "COD",
  unitedstatesofamerica: "USA",
  iriran: "IRN",
  holland: "NED",
};

const norm = (s) =>
  String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");

export function buildTeamLookup(tournament) {
  const map = new Map(Object.entries(NAME_ALIASES));
  for (const g of GROUP_IDS) {
    for (const t of tournament.groups[g]) {
      map.set(norm(t.code), t.code);
      map.set(norm(t.name), t.code);
    }
  }
  return map;
}

export function teamCode(lookup, team) {
  if (!team) return null;
  for (const key of [team.tla, team.name, team.shortName]) {
    const code = key ? lookup.get(norm(key)) : null;
    if (code) return code;
  }
  return null;
}

const pair = (s) => (s && Number.isInteger(s.home) && Number.isInteger(s.away) ? [s.home, s.away] : null);
const isDraw = (p) => p != null && p[0] === p[1] && p[0] >= 0;
const validGoals = (p) => p != null && p.every((x) => Number.isInteger(x) && x >= 0 && x <= MAX_GOALS);

// The repo stores knockout scores after extra time, with the shootout winner
// in `pens`. football-data's score decomposition has varied across API
// versions, so for shootout matches try every consistent reading and keep the
// first one that yields the after-extra-time draw a shootout implies.
export function extractScore(score) {
  const ft = pair(score?.fullTime);
  const duration = score?.duration ?? "REGULAR";
  if (duration === "REGULAR" || duration === "EXTRA_TIME") {
    return ft ? { score: ft, pens: null } : null;
  }
  if (duration !== "PENALTY_SHOOTOUT") return null;
  const rt = pair(score.regularTime);
  const et = pair(score.extraTime);
  const pen = pair(score.penalties);
  const candidates = [
    ft,                                                  // fullTime is already the AET score
    rt && et ? [rt[0] + et[0], rt[1] + et[1]] : null,    // extraTime = goals during ET only
    et,                                                  // extraTime = cumulative AET score
    ft && pen ? [ft[0] - pen[0], ft[1] - pen[1]] : null, // fullTime includes shootout goals
  ];
  const aet = candidates.find(isDraw);
  const pens =
    score.winner === "HOME_TEAM" ? 1 :
    score.winner === "AWAY_TEAM" ? 2 :
    pen && pen[0] !== pen[1] ? (pen[0] > pen[1] ? 1 : 2) : null;
  return aet && pens ? { score: aet, pens } : null;
}

function mapGroupFixture(tournament, lookup, fx, warnings) {
  const label = `${fx.homeTeam?.name ?? "?"} v ${fx.awayTeam?.name ?? "?"}`;
  const h = teamCode(lookup, fx.homeTeam);
  const a = teamCode(lookup, fx.awayTeam);
  if (!h || !a) { warnings.push(`Group match ${label}: unknown team — enter manually.`); return null; }
  const g = GROUP_IDS.find((id) => {
    const codes = tournament.groups[id].map((t) => t.code);
    return codes.includes(h) && codes.includes(a);
  });
  if (!g) { warnings.push(`Group match ${label}: ${h} and ${a} are not in one group.`); return null; }
  const dec = extractScore(fx.score);
  if (!dec || !validGoals(dec.score)) { warnings.push(`Group match ${label}: couldn't read score — enter manually.`); return null; }
  const codes = tournament.groups[g].map((t) => t.code);
  const i = codes.indexOf(h), j = codes.indexOf(a);
  const idx = PAIR_ORDER.findIndex(([x, y]) => (x === i && y === j) || (x === j && y === i));
  const score = PAIR_ORDER[idx][0] === i ? dec.score : [dec.score[1], dec.score[0]];
  return { g, idx, score };
}

// Per knockout match, the team codes we can resolve from real data so far:
// group winners/runners-up from completed group tables, later rounds from the
// recorded winners/losers. Third-place slots stay unresolved — FIFA's
// allocation may differ from ours, so fixtures are matched on the other slot.
function resolveExpectedSlots(tournament, state) {
  const tables = computeAllTables(tournament, state.groups);
  const winnerOf = {}, loserOf = {};
  for (const [m, e] of Object.entries(state.knockout ?? {})) {
    if (!e?.score || !e.home || !e.away) continue;
    const side = matchWinnerSide(e.score, e.pens);
    if (side) {
      winnerOf[m] = side === 1 ? e.home : e.away;
      loserOf[m] = side === 1 ? e.away : e.home;
    }
  }
  const resolve = (slot) => {
    switch (slot.t) {
      case "W": return groupComplete(state.groups?.[slot.g]) ? tables[slot.g][0].code : null;
      case "RU": return groupComplete(state.groups?.[slot.g]) ? tables[slot.g][1].code : null;
      case "WM": return winnerOf[slot.m] ?? null;
      case "LM": return loserOf[slot.m] ?? null;
      default: return null;
    }
  };
  return Object.fromEntries(
    tournament.knockout.map((d) => [d.m, [resolve(d.h), resolve(d.a)].filter(Boolean)]));
}

const normKo = (e) => ({ home: e?.home ?? null, away: e?.away ?? null, score: e?.score ?? null, pens: e?.pens ?? null });
const eq = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// current: data/results.json, prevAuto: data/results-auto.json,
// fixtures: matches array from the API. Returns the merged results, the new
// auto snapshot, and human-readable warnings for anything skipped.
export function applyFixtures(tournament, current, prevAuto, fixtures) {
  const warnings = [];
  const lookup = buildTeamLookup(tournament);
  const cur = { groups: current?.groups ?? {}, knockout: current?.knockout ?? {} };
  const prev = { groups: prevAuto?.groups ?? {}, knockout: prevAuto?.knockout ?? {} };

  const groupOverride = (g, idx) =>
    cur.groups[g]?.[idx] != null && !eq(cur.groups[g][idx], prev.groups[g]?.[idx]);
  const koOverride = (m) =>
    cur.knockout[m]?.score != null &&
    !eq(normKo(cur.knockout[m]), prev.knockout[m] ? normKo(prev.knockout[m]) : null);

  // Working state for slot resolution: current data with auto results layered
  // in as they map (overridden entries keep the organizer's version).
  const working = {
    groups: Object.fromEntries(GROUP_IDS.map((g) => [g, (cur.groups[g] ?? PAIR_ORDER.map(() => null)).slice()])),
    knockout: { ...cur.knockout },
  };
  const auto = { groups: {}, knockout: {} };

  const buckets = Object.fromEntries(ROUND_SEQ.map((r) => [r, []]));
  for (const fx of fixtures) {
    if (!FINISHED.has(fx.status)) continue;
    const round = STAGE_TO_ROUND[fx.stage];
    if (!round) { warnings.push(`Unknown stage "${fx.stage}" (${fx.homeTeam?.name} v ${fx.awayTeam?.name}).`); continue; }
    buckets[round].push(fx);
  }

  for (const round of ROUND_SEQ) {
    if (!buckets[round].length) continue;
    if (round === "GROUP") {
      for (const fx of buckets.GROUP) {
        const mapped = mapGroupFixture(tournament, lookup, fx, warnings);
        if (!mapped) continue;
        (auto.groups[mapped.g] ??= PAIR_ORDER.map(() => null))[mapped.idx] = mapped.score;
        if (!groupOverride(mapped.g, mapped.idx)) working.groups[mapped.g][mapped.idx] = mapped.score;
      }
      continue;
    }
    const expected = resolveExpectedSlots(tournament, working);
    const defs = tournament.knockout.filter((d) => d.r === round);
    for (const fx of buckets[round]) {
      const h = teamCode(lookup, fx.homeTeam);
      const a = teamCode(lookup, fx.awayTeam);
      if (!h || !a) {
        warnings.push(`${round} ${fx.homeTeam?.name ?? "?"} v ${fx.awayTeam?.name ?? "?"}: unknown team — enter manually.`);
        continue;
      }
      const cands = defs.length === 1 ? defs :
        defs.filter((d) => expected[d.m].length && expected[d.m].every((c) => c === h || c === a));
      if (cands.length !== 1) {
        warnings.push(`${round} ${h} v ${a}: ${cands.length ? "ambiguous" : "no"} bracket slot — enter manually.`);
        continue;
      }
      const dec = extractScore(fx.score);
      if (!dec || !validGoals(dec.score)) { warnings.push(`${round} ${h} v ${a}: couldn't read score — enter manually.`); continue; }
      const m = cands[0].m;
      auto.knockout[m] = { home: h, away: a, score: dec.score, pens: dec.pens };
      if (!koOverride(m)) working.knockout[m] = auto.knockout[m];
    }
  }

  const results = { groups: {}, knockout: {} };
  for (const g of GROUP_IDS) {
    const merged = PAIR_ORDER.map((_, idx) =>
      groupOverride(g, idx) ? cur.groups[g][idx] : auto.groups[g]?.[idx] ?? cur.groups[g]?.[idx] ?? null);
    if (merged.some((s) => s != null) || cur.groups[g]) results.groups[g] = merged;
  }
  const koKeys = [...new Set([...Object.keys(cur.knockout), ...Object.keys(auto.knockout)])]
    .sort((x, y) => Number(x) - Number(y));
  for (const m of koKeys) {
    const e = koOverride(m) ? normKo(cur.knockout[m]) : auto.knockout[m] ?? normKo(cur.knockout[m]);
    if (e.home || e.away || e.score) results.knockout[m] = e;
  }
  return { results, auto, warnings };
}

function setOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${key}=${value}\n`);
}

async function main() {
  const root = new URL("../", import.meta.url);
  const resultsPath = new URL("data/results.json", root);
  const autoPath = new URL("data/results-auto.json", root);
  const tournament = JSON.parse(readFileSync(new URL("data/tournament.json", root)));
  const currentJson = readFileSync(resultsPath, "utf8");
  const prevAuto = existsSync(autoPath)
    ? JSON.parse(readFileSync(autoPath, "utf8"))
    : { groups: {}, knockout: {} };

  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    console.log("FOOTBALL_DATA_TOKEN is not set — skipping. Add the repo secret to enable automatic results (see README).");
    setOutput("changed", "false");
    return;
  }

  const res = await fetch(API_URL, { headers: { "X-Auth-Token": token } });
  if (!res.ok) throw new Error(`football-data.org returned ${res.status} ${res.statusText}`);
  const fixtures = (await res.json()).matches ?? [];
  const finished = fixtures.filter((fx) => FINISHED.has(fx.status)).length;

  const { results, auto, warnings } = applyFixtures(tournament, JSON.parse(currentJson), prevAuto, fixtures);
  for (const w of warnings) console.warn(`WARN: ${w}`);

  const resultsJson = JSON.stringify(results, null, 2) + "\n";
  const autoJson = JSON.stringify(auto, null, 2) + "\n";
  const changed =
    resultsJson !== currentJson ||
    !existsSync(autoPath) || autoJson !== readFileSync(autoPath, "utf8");
  if (changed) {
    writeFileSync(resultsPath, resultsJson);
    writeFileSync(autoPath, autoJson);
  }
  console.log(`${finished} finished match(es) from the API; results.json ${changed ? "updated" : "unchanged"}.`);
  setOutput("changed", String(changed));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
