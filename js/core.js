// Shared bracket + scoring logic. Pure ESM, no DOM — used by the browser
// pages and by the GitHub Actions submission processor (Node).

// Canonical order of the 6 fixtures in every group, as index pairs into the
// group's team array. Match identity is the unordered team pair, so this
// order only fixes how scores are serialized — it doesn't need to match the
// real-world kickoff order.
export const PAIR_ORDER = [[0, 1], [2, 3], [0, 2], [1, 3], [0, 3], [1, 2]];

export const GROUP_IDS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"];

export const ROUND_LABELS = {
  GROUP: "Group stage",
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-final",
  SF: "Semi-final",
  "3P": "Third place",
  F: "Final",
};

// ---------------------------------------------------------------------------
// Group tables

function newStats(team) {
  return { code: team.code, name: team.name, flag: team.flag, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 };
}

function applyResult(home, away, hg, ag) {
  home.p++; away.p++;
  home.gf += hg; home.ga += ag;
  away.gf += ag; away.ga += hg;
  home.gd = home.gf - home.ga;
  away.gd = away.gf - away.ga;
  if (hg > ag) { home.w++; away.l++; home.pts += 3; }
  else if (hg < ag) { away.w++; home.l++; away.pts += 3; }
  else { home.d++; away.d++; home.pts++; away.pts++; }
}

function statsFromScores(teams, scores) {
  const stats = teams.map(newStats);
  PAIR_ORDER.forEach(([i, j], idx) => {
    const s = scores ? scores[idx] : null;
    if (s == null) return;
    applyResult(stats[i], stats[j], s[0], s[1]);
  });
  return stats;
}

function baseCompare(a, b) {
  return b.pts - a.pts || b.gd - a.gd || b.gf - a.gf;
}

// Rank a group's 4 teams from its 6 scores (entries may be null while the
// group is in progress). Tiebreakers: points, goal difference, goals scored,
// then the same three over head-to-head results among the tied teams, then
// team code (deterministic last resort, standing in for FIFA's fair play /
// drawing of lots).
export function computeGroupTable(teams, scores) {
  const stats = statsFromScores(teams, scores);
  const ranked = [...stats].sort((a, b) => baseCompare(a, b) || a.code.localeCompare(b.code));

  // Re-break exact (pts, gd, gf) ties using head-to-head among the tied set.
  for (let i = 0; i < ranked.length;) {
    let j = i + 1;
    while (j < ranked.length && baseCompare(ranked[i], ranked[j]) === 0) j++;
    if (j - i > 1) {
      const tiedCodes = new Set(ranked.slice(i, j).map((t) => t.code));
      const idxOf = Object.fromEntries(teams.map((t, k) => [t.code, k]));
      const mini = Object.fromEntries([...tiedCodes].map((c) => [c, { code: c, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }]));
      PAIR_ORDER.forEach(([x, y], idx) => {
        const s = scores ? scores[idx] : null;
        if (s == null) return;
        const cx = teams[x].code, cy = teams[y].code;
        if (tiedCodes.has(cx) && tiedCodes.has(cy)) applyResult(mini[cx], mini[cy], s[0], s[1]);
      });
      const block = ranked.slice(i, j).sort((a, b) =>
        baseCompare(mini[a.code], mini[b.code]) || a.code.localeCompare(b.code));
      ranked.splice(i, j - i, ...block);
    }
    i = j;
  }
  return ranked;
}

export function groupComplete(scores) {
  return Array.isArray(scores) && scores.length === 6 && scores.every((s) => Array.isArray(s));
}

// groupScores: { A: [[h,a] x6], ... }
export function computeAllTables(tournament, groupScores) {
  const tables = {};
  for (const g of GROUP_IDS) {
    tables[g] = computeGroupTable(tournament.groups[g], groupScores?.[g]);
  }
  return tables;
}

// Rank the 12 third-placed teams; returns [{group, stats}] best-first.
export function rankThirds(tables) {
  return GROUP_IDS
    .map((g) => ({ group: g, stats: tables[g][2] }))
    .sort((a, b) => baseCompare(a.stats, b.stats) || a.stats.code.localeCompare(b.stats.code));
}

// Assign the 8 qualified third-place groups to the third-place bracket slots.
// slots: [{ m, opts }] in match order; thirdGroups: qualified group letters in
// ranking order. Deterministic backtracking: earliest slot gets the
// best-ranked compatible third that still allows a full assignment. FIFA's
// official allocation table may differ in edge cases, but this is fully
// deterministic, honors the allowed-group constraints, and the same algorithm
// is applied to every submitted bracket, so it's fair.
export function allocateThirds(slots, thirdGroups) {
  const assignment = {};
  const used = new Set();
  function backtrack(i) {
    if (i === slots.length) return true;
    for (const g of thirdGroups) {
      if (used.has(g) || !slots[i].opts.includes(g)) continue;
      used.add(g);
      assignment[slots[i].m] = g;
      if (backtrack(i + 1)) return true;
      used.delete(g);
      delete assignment[slots[i].m];
    }
    return false;
  }
  if (backtrack(0)) return assignment;
  // Shouldn't happen (FIFA designed the slot lists so every combination of 8
  // thirds is assignable), but never crash: relax the group constraints.
  const relaxed = {};
  const left = [...thirdGroups];
  for (const s of slots) {
    const pick = left.find((g) => s.opts.includes(g)) ?? left[0];
    left.splice(left.indexOf(pick), 1);
    relaxed[s.m] = pick;
  }
  return relaxed;
}

export function matchWinnerSide(score, pens) {
  if (!score || score[0] == null || score[1] == null) return null;
  if (score[0] > score[1]) return 1;
  if (score[1] > score[0]) return 2;
  return pens === 1 || pens === 2 ? pens : null;
}

// Build the knockout bracket from group scores + knockout entries.
// koEntries: { [matchNo]: { score: [h,a], pens: 1|2|null } }
// Tolerates incomplete input: unresolved teams stay null. Third-place
// allocation only happens once all 12 groups are complete.
export function buildBracket(tournament, groupScores, koEntries) {
  const tables = computeAllTables(tournament, groupScores);
  const complete = GROUP_IDS.every((g) => groupComplete(groupScores?.[g]));
  const teamsByCode = {};
  for (const g of GROUP_IDS) for (const t of tournament.groups[g]) teamsByCode[t.code] = t;

  let thirdsRanked = null;
  let alloc = {};
  if (complete) {
    thirdsRanked = rankThirds(tables);
    const qualified = thirdsRanked.slice(0, 8).map((x) => x.group);
    const slots = tournament.knockout
      .filter((d) => d.a.t === "3")
      .map((d) => ({ m: d.m, opts: d.a.o }));
    alloc = allocateThirds(slots, qualified);
  }

  const matches = {};
  const resolveSlot = (def, matchNo) => {
    switch (def.t) {
      case "W": return groupComplete(groupScores?.[def.g]) ? tables[def.g][0].code : null;
      case "RU": return groupComplete(groupScores?.[def.g]) ? tables[def.g][1].code : null;
      case "3": return alloc[matchNo] ? tables[alloc[matchNo]][2].code : null;
      case "WM": return matches[def.m]?.winner ?? null;
      case "LM": return matches[def.m]?.loser ?? null;
      default: return null;
    }
  };

  for (const def of tournament.knockout) {
    const home = resolveSlot(def.h, def.m);
    const away = resolveSlot(def.a, def.m);
    const entry = koEntries?.[def.m] ?? {};
    const score = Array.isArray(entry.score) && entry.score[0] != null && entry.score[1] != null ? entry.score : null;
    const pens = entry.pens ?? null;
    const side = matchWinnerSide(score, pens);
    matches[def.m] = {
      m: def.m,
      round: def.r,
      def,
      home,
      away,
      score,
      pens,
      winner: side === 1 ? home : side === 2 ? away : null,
      loser: side === 1 ? away : side === 2 ? home : null,
    };
  }
  return { matches, tables, thirdsRanked, alloc, complete, teamsByCode };
}

// ---------------------------------------------------------------------------
// Payload encoding (what travels through the GitHub issue)

const PAYLOAD_VERSION = "WK1";

export function sanitizeName(name) {
  return String(name ?? "").replace(/[|;=\n\r\t]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function encodePayload(name, groupScores, koEntries) {
  const groupPart = GROUP_IDS.map((g) => {
    const six = (groupScores[g] ?? []).map((s) => `${s[0]}-${s[1]}`).join(",");
    return `${g}=${six}`;
  }).join(";");
  const koPart = Object.keys(koEntries)
    .map(Number)
    .sort((a, b) => a - b)
    .map((m) => {
      const e = koEntries[m];
      const pens = e.pens ? `:${e.pens}` : "";
      return `${m}=${e.score[0]}-${e.score[1]}${pens}`;
    })
    .join(";");
  return [PAYLOAD_VERSION, sanitizeName(name), groupPart, koPart].join("|");
}

export function decodePayload(payload) {
  const parts = String(payload).trim().split("|");
  if (parts.length !== 4 || parts[0] !== PAYLOAD_VERSION) {
    throw new Error(`Unrecognized payload format (expected ${PAYLOAD_VERSION}|name|groups|knockout)`);
  }
  const [, name, groupPart, koPart] = parts;
  const groups = {};
  for (const chunk of groupPart.split(";")) {
    const [g, list] = chunk.split("=");
    if (!GROUP_IDS.includes(g)) throw new Error(`Unknown group "${g}" in payload`);
    groups[g] = list.split(",").map((pair) => {
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(pair);
      if (!m) throw new Error(`Bad score "${pair}" in group ${g}`);
      return [Number(m[1]), Number(m[2])];
    });
  }
  const ko = {};
  if (koPart) {
    for (const chunk of koPart.split(";")) {
      const m = /^(\d{2,3})=(\d{1,2})-(\d{1,2})(?::([12]))?$/.exec(chunk);
      if (!m) throw new Error(`Bad knockout entry "${chunk}"`);
      ko[Number(m[1])] = {
        score: [Number(m[2]), Number(m[3])],
        pens: m[4] ? Number(m[4]) : null,
      };
    }
  }
  return { name: sanitizeName(name), groups, ko };
}

const MAX_GOALS = 15;

export function validateBracket(tournament, decoded) {
  const errors = [];
  if (!decoded.name) errors.push("Missing display name.");
  for (const g of GROUP_IDS) {
    const scores = decoded.groups[g];
    if (!groupComplete(scores)) {
      errors.push(`Group ${g}: all 6 match scores are required.`);
      continue;
    }
    scores.forEach((s, i) => {
      if (!Number.isInteger(s[0]) || !Number.isInteger(s[1]) || s[0] < 0 || s[1] < 0 || s[0] > MAX_GOALS || s[1] > MAX_GOALS) {
        errors.push(`Group ${g}, match ${i + 1}: scores must be whole numbers between 0 and ${MAX_GOALS}.`);
      }
    });
  }
  if (errors.length) return { ok: false, errors };

  const bracket = buildBracket(tournament, decoded.groups, decoded.ko);
  for (const def of tournament.knockout) {
    const m = bracket.matches[def.m];
    const label = `${ROUND_LABELS[def.r]} (match ${def.m})`;
    if (!m.score) { errors.push(`${label}: score is required.`); continue; }
    if (m.score.some((x) => !Number.isInteger(x) || x < 0 || x > MAX_GOALS)) {
      errors.push(`${label}: scores must be whole numbers between 0 and ${MAX_GOALS}.`);
    }
    if (!m.winner) errors.push(`${label}: tied score needs a penalty-shootout winner.`);
  }
  return { ok: errors.length === 0, errors, bracket: errors.length === 0 ? bracket : null };
}

// Expand a validated decoded payload into the JSON stored in the repo.
export function expandPrediction(tournament, decoded, meta) {
  const bracket = buildBracket(tournament, decoded.groups, decoded.ko);
  const knockout = {};
  for (const def of tournament.knockout) {
    const m = bracket.matches[def.m];
    knockout[def.m] = { round: m.round, home: m.home, away: m.away, score: m.score, pens: m.pens, winner: m.winner };
  }
  return {
    version: 1,
    user: meta.user,
    name: decoded.name,
    submittedAt: meta.submittedAt,
    payload: encodePayload(decoded.name, decoded.groups, decoded.ko),
    groups: decoded.groups,
    knockout,
    champion: knockout[104].winner,
  };
}

// ---------------------------------------------------------------------------
// Scoring
//
// Base points P per match (group stage), doubled each knockout round. You must
// call the result correctly to score anything; a single tier then applies:
//   - Correct result only (win/loss/draw):            P
//   - Correct result + correct goal difference (W/L):  P x 1.5
//       (no goal-difference bonus when the result is a draw)
//   - Correct result + exact score (W/L/D):            P x 2
// The goal-difference bonus is only ever available when you picked the right
// winning team, so a draw can only be upgraded by nailing the exact score.
//
// In knockouts, "result" means the team you advanced actually advanced, even if
// your predicted opponent was wrong. The exact-score and goal-difference
// upgrades only apply when you placed both of the slot's real teams, so their
// predicted and real goals can be compared.

export function scoreGroupMatch(scoring, pred, actual) {
  const P = scoring.base * scoring.multipliers.GROUP;
  const po = Math.sign(pred[0] - pred[1]);
  const ao = Math.sign(actual[0] - actual[1]);
  if (po !== ao) return 0; // wrong result — no points
  if (pred[0] === actual[0] && pred[1] === actual[1]) return P * 2; // exact score
  if (po !== 0 && pred[0] - pred[1] === actual[0] - actual[1]) return P * 1.5; // GD bonus (W/L only)
  return P; // correct result only
}

// pred/actual: { home, away, score, winner } with team codes.
export function scoreKnockoutMatch(scoring, round, pred, actual) {
  const P = scoring.base * scoring.multipliers[round];
  if (!pred.winner || !actual.winner || pred.winner !== actual.winner) return 0; // wrong advancer
  // Compare goals only for teams you actually placed in this slot.
  const predGoals = {};
  if (pred.home) predGoals[pred.home] = pred.score[0];
  if (pred.away) predGoals[pred.away] = pred.score[1];
  const gh = predGoals[actual.home];
  const ga = predGoals[actual.away];
  if (gh != null && ga != null) {
    if (gh === actual.score[0] && ga === actual.score[1]) return P * 2; // exact score
    const margin = actual.score[0] - actual.score[1];
    if (margin !== 0 && gh - ga === margin) return P * 1.5; // GD bonus (decisive in play)
  }
  return P; // correct advancer only
}

// prediction: expanded prediction JSON. results: data/results.json contents.
export function scoreUser(tournament, prediction, results) {
  const scoring = tournament.scoring;
  const stages = { GROUP: 0, R32: 0, R16: 0, QF: 0, SF: 0, "3P": 0, F: 0 };
  const details = [];

  for (const g of GROUP_IDS) {
    const teams = tournament.groups[g];
    PAIR_ORDER.forEach(([i, j], idx) => {
      const actual = results?.groups?.[g]?.[idx];
      const pred = prediction.groups?.[g]?.[idx];
      if (actual == null || pred == null) return;
      const pts = scoreGroupMatch(scoring, pred, actual);
      stages.GROUP += pts;
      details.push({
        stage: "GROUP",
        label: `${teams[i].code} v ${teams[j].code}`,
        pred: `${pred[0]}-${pred[1]}`,
        actual: `${actual[0]}-${actual[1]}`,
        pts,
      });
    });
  }

  for (const def of tournament.knockout) {
    const actual = results?.knockout?.[def.m];
    const pred = prediction.knockout?.[def.m];
    if (!actual || !actual.score || !pred) continue;
    const side = matchWinnerSide(actual.score, actual.pens);
    const actualResolved = {
      home: actual.home,
      away: actual.away,
      score: actual.score,
      winner: side === 1 ? actual.home : side === 2 ? actual.away : null,
    };
    const pts = scoreKnockoutMatch(scoring, def.r, pred, actualResolved);
    stages[def.r] += pts;
    details.push({
      stage: def.r,
      label: `M${def.m} ${ROUND_LABELS[def.r]}`,
      pred: `${pred.home ?? "?"} ${pred.score[0]}-${pred.score[1]} ${pred.away ?? "?"}${pred.pens ? " (p)" : ""}`,
      actual: `${actual.home ?? "?"} ${actual.score[0]}-${actual.score[1]} ${actual.away ?? "?"}${actual.pens ? " (p)" : ""}`,
      pts,
    });
  }

  const total = Object.values(stages).reduce((a, b) => a + b, 0);
  return { total, stages, details };
}
