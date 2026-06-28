// Nate's Score leaderboard. A snapshot of the original scoring rules, kept on
// its own tab so it stays fixed even if the main scoring is changed later.
//
// The structural helpers (group tables, bracket building, payload handling)
// still come from core.js — only the scoring is frozen here.
import { GROUP_IDS, PAIR_ORDER, ROUND_LABELS, matchWinnerSide } from "./core.js";

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
// Original scoring (snapshot)
//
// Base points P per match (group stage), doubled each knockout round. You must
// call the result correctly to score anything; a single tier then applies:
//   - Correct result only (win/loss/draw):            P
//   - Correct result + correct goal difference (W/L):  P x 1.5
//   - Correct result + exact score (W/L/D):            P x 2

function scoreGroupMatch(scoring, pred, actual) {
  const P = scoring.base * scoring.multipliers.GROUP;
  const po = Math.sign(pred[0] - pred[1]);
  const ao = Math.sign(actual[0] - actual[1]);
  if (po !== ao) return 0; // wrong result — no points
  if (pred[0] === actual[0] && pred[1] === actual[1]) return P * 2; // exact score
  if (po !== 0 && pred[0] - pred[1] === actual[0] - actual[1]) return P * 1.5; // GD bonus (W/L only)
  return P; // correct result only
}

function scoreKnockoutMatch(scoring, round, pred, actual) {
  const P = scoring.base * scoring.multipliers[round];
  if (!pred.winner || !actual.winner || pred.winner !== actual.winner) return 0; // wrong advancer
  const predGoals = {};
  if (pred.home) predGoals[pred.home] = pred.score[0];
  if (pred.away) predGoals[pred.away] = pred.score[1];
  const gh = predGoals[actual.home];
  const ga = predGoals[actual.away];
  if (gh != null && ga != null) {
    if (gh === actual.score[0] && ga === actual.score[1]) return P * 2; // exact score
    const margin = actual.score[0] - actual.score[1];
    if (margin !== 0 && gh - ga === margin) return P * 1.5; // GD bonus
  }
  if (actual.score[0] === actual.score[1] && pred.score[0] === pred.score[1]) return P * 1.5;
  return P; // correct advancer only
}

function scoreUser(tournament, prediction, results) {
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

// ---------------------------------------------------------------------------
// Rendering (mirrors the main leaderboard)

init();

async function init() {
  const status = $("#status");
  status.innerHTML = `<div class="notice">Loading…</div>`;
  try {
    const [tournament, results, index] = await Promise.all([
      fetchJson("data/tournament.json"),
      fetchJson("data/results.json"),
      fetchJson("data/predictions/index.json"),
    ]);

    if (!index.length) {
      status.innerHTML = `<div class="notice">No brackets submitted yet. <a href="index.html">Be the first →</a></div>`;
      return;
    }

    const entries = await Promise.all(index.map(async (meta) => {
      const pred = await fetchJson(`data/predictions/${meta.file}`);
      return { meta, pred, score: scoreUser(tournament, pred, results) };
    }));

    entries.sort((a, b) => b.score.total - a.score.total || a.pred.name.localeCompare(b.pred.name));

    const playedGroups = GROUP_IDS.reduce((n, g) => n + (results.groups?.[g]?.filter(Boolean).length ?? 0), 0);
    const playedKo = Object.values(results.knockout ?? {}).filter((m) => m?.score).length;
    status.innerHTML = `<div class="notice">${entries.length} bracket${entries.length === 1 ? "" : "s"} ·
      results in for <strong>${playedGroups + playedKo} / 104</strong> matches.</div>`;

    const champFor = (pred, tournament) => {
      const code = pred.champion ?? pred.knockout?.["104"]?.winner;
      if (!code) return "—";
      for (const g of GROUP_IDS) {
        const t = tournament.groups[g].find((t) => t.code === code);
        if (t) return `${t.flag} ${t.code}`;
      }
      return code;
    };

    const body = $("#board-body");
    let rank = 0, prevTotal = null, shown = 0;
    for (const e of entries) {
      shown++;
      if (e.score.total !== prevTotal) { rank = shown; prevTotal = e.score.total; }
      const tr = document.createElement("tr");
      tr.className = `expandable rank-${rank}`;
      const s = e.score.stages;
      tr.innerHTML =
        `<td>${rank}</td>` +
        `<td><a href="index.html?user=${encodeURIComponent(e.pred.user)}" title="View bracket">${esc(e.pred.name)}</a></td>` +
        `<td>${champFor(e.pred, tournament)}</td>` +
        `<td>${s.GROUP}</td><td>${s.R32}</td><td>${s.R16}</td><td>${s.QF}</td><td>${s.SF}</td><td>${s["3P"]}</td><td>${s.F}</td>` +
        `<td class="total">${e.score.total}</td>`;
      body.appendChild(tr);

      const detail = document.createElement("tr");
      detail.className = "detail-row";
      detail.style.display = "none";
      detail.innerHTML = `<td colspan="11">${detailHTML(e.score)}</td>`;
      body.appendChild(detail);

      tr.addEventListener("click", (ev) => {
        if (ev.target.closest("a")) return;
        detail.style.display = detail.style.display === "none" ? "" : "none";
      });
    }
    $("#board").style.display = "";
  } catch (err) {
    status.innerHTML = `<div class="notice error">Couldn't load Nate's Score: ${esc(err.message)}</div>`;
  }
}

function detailHTML(score) {
  const scored = score.details.filter((d) => d.pts > 0).length;
  if (!score.details.length) return `<em>No results yet — points appear once matches are played.</em>`;
  return `<em>${scored} of ${score.details.length} played matches earned points.</em>
    <table class="detail">
      <tr><th>Match</th><th>Your pick</th><th>Result</th><th style="text-align:right">Pts</th></tr>` +
    score.details.map((d) =>
      `<tr class="${d.pts > 0 ? "scored" : ""}"><td>${esc(d.label)}</td><td>${esc(d.pred)}</td><td>${esc(d.actual)}</td><td class="pts">${d.pts}</td></tr>`
    ).join("") +
    `</table>`;
}

async function fetchJson(url) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
