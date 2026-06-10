import { scoreUser, GROUP_IDS } from "./core.js";

const $ = (sel) => document.querySelector(sel);

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
    status.innerHTML = `<div class="notice error">Couldn't load the leaderboard: ${esc(err.message)}</div>`;
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
