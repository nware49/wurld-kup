import {
  GROUP_IDS, PAIR_ORDER, matchWinnerSide, scoreGroupMatch, scoreKnockoutMatch,
} from "./core.js";

const $ = (sel) => document.querySelector(sel);

const KO_ROUNDS = [
  ["R32", "Round of 32"],
  ["R16", "Round of 16"],
  ["QF", "Quarter-finals"],
  ["SF", "Semi-finals"],
  ["3P", "Third-place play-off"],
  ["F", "Final"],
];

init();

async function init() {
  const status = $("#status");
  status.innerHTML = `<div class="notice">Loading…</div>`;
  try {
    const [tournament, results, index, schedule] = await Promise.all([
      fetchJson("data/tournament.json"),
      fetchJson("data/results.json"),
      fetchJson("data/predictions/index.json"),
      fetchJson("data/schedule.json").catch(() => null),
    ]);

    const predictions = await Promise.all(
      index.map(async (meta) => ({ meta, pred: await fetchJson(`data/predictions/${meta.file}`) }))
    );

    const teamsByCode = {};
    for (const g of GROUP_IDS) for (const t of tournament.groups[g]) teamsByCode[t.code] = t;

    const ctx = { tournament, results, predictions, teamsByCode, scoring: tournament.scoring };

    const playedGroups = GROUP_IDS.reduce((n, g) => n + (results.groups?.[g]?.filter(Boolean).length ?? 0), 0);
    const playedKo = Object.values(results.knockout ?? {}).filter((m) => m?.score).length;
    status.innerHTML = `<div class="notice">${predictions.length} bracket${predictions.length === 1 ? "" : "s"} ·
      <strong>${playedGroups + playedKo} / 104</strong> matches played.</div>`;
    $("#intro").style.display = "";

    renderSchedule(ctx, buildSections(tournament, schedule));
  } catch (err) {
    status.innerHTML = `<div class="notice error">Couldn't load the schedule: ${esc(err.message)}</div>`;
  }
}

const MD_TITLES = { 1: "Group stage — Matchday 1", 2: "Group stage — Matchday 2", 3: "Group stage — Matchday 3" };

// With data/schedule.json (the official FIFA fixture list), matches are shown in
// real kickoff order: group stage by matchday, then each knockout round. FIFA
// numbers matches chronologically, so sorting by match number is the schedule.
// Without it, fall back to listing the group stage by group (no faked order).
function buildSections(tournament, schedule) {
  const koByNum = Object.fromEntries(tournament.knockout.map((d) => [d.m, d]));
  const sections = [];

  if (schedule?.length) {
    const byM = (a, b) => a.m - b.m;
    for (const md of [1, 2, 3]) {
      const matches = schedule.filter((e) => e.round === "GROUP" && e.md === md).sort(byM)
        .map((e) => ({ kind: "group", g: e.g, idx: e.slot, m: e.m, time: e.time }));
      if (matches.length) sections.push({ title: MD_TITLES[md], matches });
    }
    for (const [r, title] of KO_ROUNDS) {
      const matches = schedule.filter((e) => e.round === r).sort(byM)
        .map((e) => ({ kind: "ko", def: koByNum[e.m], m: e.m, time: e.time }));
      if (matches.length) sections.push({ title, matches });
    }
    return sections;
  }

  for (const g of GROUP_IDS) {
    sections.push({ title: `Group ${g}`, matches: PAIR_ORDER.map((_, idx) => ({ kind: "group", g, idx })) });
  }
  const byRound = {};
  for (const def of [...tournament.knockout].sort((a, b) => a.m - b.m)) (byRound[def.r] ??= []).push(def);
  for (const [r, title] of KO_ROUNDS) {
    if (byRound[r]?.length) sections.push({ title, matches: byRound[r].map((def) => ({ kind: "ko", def })) });
  }
  return sections;
}

function renderSchedule(ctx, sections) {
  const root = $("#schedule");
  root.innerHTML = "";
  for (const section of sections) {
    const sec = document.createElement("div");
    sec.className = "sched-section";
    sec.innerHTML = `<h3>${esc(section.title)}</h3>`;
    const list = document.createElement("div");
    list.className = "match-list";
    for (const m of section.matches) list.appendChild(renderMatch(ctx, m));
    sec.appendChild(list);
    root.appendChild(sec);
  }
}

function renderMatch(ctx, m) {
  const view = m.kind === "group" ? groupView(ctx, m) : koView(ctx, m);
  const wrap = document.createElement("div");

  const row = document.createElement("div");
  row.className = `match-row${view.played ? " played" : ""}`;
  row.innerHTML =
    `<span class="tag">${esc(view.tag)}</span>` +
    `<span class="side home">${view.home}</span>` +
    `<span class="score${view.played ? "" : " tbd"}">${view.score}</span>` +
    `<span class="side away">${view.away}</span>` +
    `<span class="chev">▸</span>`;

  const detail = document.createElement("div");
  detail.className = "match-detail";
  detail.style.display = "none";
  detail.innerHTML = view.detail;

  row.addEventListener("click", () => {
    const open = detail.style.display !== "none";
    detail.style.display = open ? "none" : "";
    row.querySelector(".chev").textContent = open ? "▸" : "▾";
  });

  wrap.appendChild(row);
  wrap.appendChild(detail);
  return wrap;
}

// ---------------------------------------------------------------------------
// Group matches

function groupView(ctx, { g, idx, m, time }) {
  const [i, j] = PAIR_ORDER[idx];
  const teams = ctx.tournament.groups[g];
  const home = teams[i], away = teams[j];
  const actual = ctx.results.groups?.[g]?.[idx] ?? null;
  const played = Array.isArray(actual);

  const rows = ctx.predictions
    .map((p) => {
      const pred = p.pred.groups?.[g]?.[idx] ?? null;
      const pts = played && pred ? scoreGroupMatch(ctx.scoring, pred, actual) : null;
      return { name: p.pred.name, pick: pred ? `${pred[0]}–${pred[1]}` : "—", pts };
    })
    .sort(byPtsThenName(played));

  return {
    tag: m ? `${g} · M${m}` : `Group ${g}`,
    home: `${esc(home.name)} ${home.flag}`,
    away: `${away.flag} ${esc(away.name)}`,
    score: played ? `${actual[0]}–${actual[1]}` : "vs",
    played,
    detail: detailHTML(played ? `Final score: <strong>${actual[0]}–${actual[1]}</strong>` : null, rows,
      null, kickoffMeta(m, time)),
  };
}

// ---------------------------------------------------------------------------
// Knockout matches

const SLOT = {
  W: (def) => `Winner Group ${def.g}`,
  RU: (def) => `Runner-up Group ${def.g}`,
  "3": (def) => `3rd place (${def.o.join("/")})`,
  WM: (def) => `Winner of M${def.m}`,
  LM: (def) => `Loser of M${def.m}`,
};
const slotLabel = (def) => SLOT[def.t]?.(def) ?? "?";

function koView(ctx, { def, m, time }) {
  const ROUND_TAGS = { R32: "R32", R16: "R16", QF: "QF", SF: "SF", "3P": "3rd", F: "Final" };
  const actual = ctx.results.knockout?.[String(def.m)] ?? null;
  const played = !!(actual && actual.score);

  let actualResolved = null;
  if (played) {
    const side = matchWinnerSide(actual.score, actual.pens);
    actualResolved = {
      home: actual.home, away: actual.away, score: actual.score,
      winner: side === 1 ? actual.home : side === 2 ? actual.away : null,
    };
  }

  const rows = ctx.predictions
    .map((p) => {
      const pk = p.pred.knockout?.[String(def.m)] ?? null;
      const pts = played && pk ? scoreKnockoutMatch(ctx.scoring, def.r, pk, actualResolved) : null;
      return { name: p.pred.name, pick: pk ? koPickLabel(ctx, pk) : "—", pts };
    })
    .sort(byPtsThenName(played));

  const header = played
    ? `Final: <strong>${koScoreLabel(ctx, actual)}</strong>`
    : null;
  const subhead = played ? null : `Matchup: ${esc(slotLabel(def.h))} vs ${esc(slotLabel(def.a))}`;

  return {
    tag: `${ROUND_TAGS[def.r]} · M${def.m}`,
    home: played ? teamLabel(ctx, actual.home) : esc(slotLabel(def.h)),
    away: played ? teamLabel(ctx, actual.away) : esc(slotLabel(def.a)),
    score: played ? `${actual.score[0]}–${actual.score[1]}` : "vs",
    played,
    detail: detailHTML(header, rows, subhead, kickoffMeta(m, time)),
  };
}

function kickoffMeta(m, time) {
  if (!m) return null;
  return time ? `Match ${m} · ${time} ET` : `Match ${m}`;
}

function koScoreLabel(ctx, e) {
  const side = matchWinnerSide(e.score, e.pens);
  const winner = side === 1 ? e.home : side === 2 ? e.away : null;
  const pens = e.pens ? ` (pens: ${esc(ctx.teamsByCode[winner]?.code ?? winner)})` : "";
  return `${teamLabel(ctx, e.home)} ${e.score[0]}–${e.score[1]} ${teamLabel(ctx, e.away)}${pens}`;
}

function koPickLabel(ctx, pk) {
  const pens = pk.pens ? ` (pens: ${esc(ctx.teamsByCode[pk.winner]?.code ?? pk.winner)})` : "";
  return `${teamLabel(ctx, pk.home)} ${pk.score[0]}–${pk.score[1]} ${teamLabel(ctx, pk.away)}${pens}`;
}

function teamLabel(ctx, code) {
  const t = ctx.teamsByCode[code];
  return t ? `${t.flag} ${esc(t.code)}` : esc(code ?? "?");
}

// ---------------------------------------------------------------------------

function byPtsThenName(played) {
  return (a, b) =>
    (played ? (b.pts ?? -1) - (a.pts ?? -1) : 0) || a.name.localeCompare(b.name);
}

function detailHTML(header, rows, subhead, meta) {
  const metaLine = meta ? `<p class="match-meta">${esc(meta)}</p>` : "";
  if (!rows.length) return metaLine + `<em>No brackets submitted yet.</em>`;
  const head = header
    ? `<p class="match-result">${header}</p>`
    : `<p class="match-result muted">Not played yet — predictions below.${subhead ? `<br>${esc(subhead)}` : ""}</p>`;
  const played = !!header;
  return metaLine + head +
    `<table class="detail">
      <tr><th>Name</th><th>Prediction</th>${played ? `<th style="text-align:right">Pts</th>` : ""}</tr>` +
    rows.map((r) =>
      `<tr class="${r.pts > 0 ? "scored" : ""}"><td>${esc(r.name)}</td><td>${r.pick}</td>` +
      (played ? `<td class="pts">${r.pts ?? "—"}</td>` : "") + `</tr>`
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
