import {
  GROUP_IDS, PAIR_ORDER, ROUND_LABELS, buildBracket, computeGroupTable, groupComplete,
  matchWinnerSide,
} from "./core.js";
import { REPO_OWNER, REPO_NAME, REPO_URL } from "./config.js";

const $ = (sel) => document.querySelector(sel);

const results = {
  groups: Object.fromEntries(GROUP_IDS.map((g) => [g, PAIR_ORDER.map(() => null)])),
  knockout: {},
};

let tournament = null;
let allTeams = [];

init();

async function init() {
  tournament = await (await fetch("data/tournament.json")).json();
  allTeams = GROUP_IDS.flatMap((g) => tournament.groups[g]);
  $("#edit-link").href = `${REPO_URL}/edit/main/data/results.json`;

  try {
    const existing = await (await fetch("data/results.json", { cache: "no-cache" })).json();
    for (const g of GROUP_IDS) {
      if (Array.isArray(existing.groups?.[g])) results.groups[g] = existing.groups[g];
    }
    Object.assign(results.knockout, existing.knockout ?? {});
  } catch { /* no results yet */ }

  renderGroups();
  renderKnockout();
  refresh();

  $("#btn-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText($("#json-out").value);
    $("#copy-status").textContent = "Copied ✓";
    setTimeout(() => ($("#copy-status").textContent = ""), 2000);
  });
  $("#btn-issue").addEventListener("click", () => {
    const url = `${REPO_URL}/issues/new?` + new URLSearchParams({
      template: "results-update.yml",
      title: `Results update ${new Date().toISOString().slice(0, 10)}`,
      payload: $("#json-out").value,
    }).toString();
    window.open(url, "_blank", "noopener");
  });
}

function parseGoals(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : null;
}

function renderGroups() {
  const grid = $("#groups-grid");
  for (const g of GROUP_IDS) {
    const teams = tournament.groups[g];
    const card = document.createElement("div");
    card.className = "group-card";
    card.innerHTML = `<h3>Group ${g}</h3>`;
    PAIR_ORDER.forEach(([i, j], idx) => {
      const row = document.createElement("div");
      row.className = "gmatch";
      row.innerHTML =
        `<span class="t-home">${teams[i].name} ${teams[i].flag}</span>` +
        `<input type="number" min="0" max="15" data-g="${g}" data-idx="${idx}" data-side="0">` +
        `<span class="dash">–</span>` +
        `<input type="number" min="0" max="15" data-g="${g}" data-idx="${idx}" data-side="1">` +
        `<span class="t-away">${teams[j].flag} ${teams[j].name}</span>`;
      card.appendChild(row);
    });
    const table = document.createElement("table");
    table.className = "mini-table";
    table.dataset.g = g;
    card.appendChild(table);
    grid.appendChild(card);
  }

  grid.querySelectorAll("input").forEach((inp) => {
    const { g, idx, side } = inp.dataset;
    const cur = results.groups[g][idx];
    if (cur) inp.value = cur[Number(side)];
    inp.addEventListener("input", () => {
      const other = grid.querySelector(`input[data-g="${g}"][data-idx="${idx}"][data-side="${1 - side}"]`);
      const a = parseGoals(inp.value);
      const b = parseGoals(other.value);
      results.groups[g][idx] = a != null && b != null ? (side === "0" ? [a, b] : [b, a]) : null;
      refresh();
    });
  });
}

function renderKnockout() {
  const list = $("#ko-list");
  for (const def of tournament.knockout) {
    const card = document.createElement("div");
    card.className = "ko-match";
    card.style.marginBottom = "0.5rem";
    card.dataset.m = def.m;
    const cur = results.knockout[def.m] ?? {};
    const teamSel = (side, val) =>
      `<select data-m="${def.m}" data-team="${side}">` +
      `<option value="">— team —</option>` +
      allTeams.map((t) => `<option value="${t.code}" ${val === t.code ? "selected" : ""}>${t.flag} ${t.name}</option>`).join("") +
      `</select>`;
    card.innerHTML =
      `<div class="mnum">M${def.m} · ${ROUND_LABELS[def.r]} <span class="hint" data-hint="${def.m}" style="color:var(--muted)"></span></div>` +
      `<div class="ko-row">${teamSel("h", cur.home)} <input type="number" min="0" max="15" data-m="${def.m}" data-side="0" value="${cur.score?.[0] ?? ""}"></div>` +
      `<div class="ko-row">${teamSel("a", cur.away)} <input type="number" min="0" max="15" data-m="${def.m}" data-side="1" value="${cur.score?.[1] ?? ""}"></div>` +
      `<div class="pens-row" style="display:flex">Pens winner:
        <button type="button" data-pens="1" class="${cur.pens === 1 ? "sel" : ""}">Top</button>
        <button type="button" data-pens="2" class="${cur.pens === 2 ? "sel" : ""}">Bottom</button>
        <button type="button" data-pens="0">none</button>
      </div>`;
    list.appendChild(card);

    card.querySelectorAll("select, input").forEach((el) => el.addEventListener("input", () => readKoCard(def.m)));
    card.querySelectorAll("[data-pens]").forEach((btn) => btn.addEventListener("click", () => {
      const v = Number(btn.dataset.pens) || null;
      const e = entryFor(def.m);
      e.pens = v;
      card.querySelectorAll("[data-pens]").forEach((b) => b.classList.toggle("sel", Number(b.dataset.pens) === v));
      refresh();
    }));
  }
}

function entryFor(m) {
  if (!results.knockout[m]) results.knockout[m] = { home: null, away: null, score: null, pens: null };
  return results.knockout[m];
}

function readKoCard(m) {
  const card = document.querySelector(`.ko-match[data-m="${m}"]`);
  const e = entryFor(m);
  e.home = card.querySelector(`select[data-team="h"]`).value || null;
  e.away = card.querySelector(`select[data-team="a"]`).value || null;
  const h = parseGoals(card.querySelector(`input[data-side="0"]`).value);
  const a = parseGoals(card.querySelector(`input[data-side="1"]`).value);
  e.score = h != null && a != null ? [h, a] : null;
  if (!e.score || e.score[0] !== e.score[1]) e.pens = null;
  refresh();
}

function refresh() {
  for (const g of GROUP_IDS) {
    const el = document.querySelector(`table.mini-table[data-g="${g}"]`);
    const ranked = computeGroupTable(tournament.groups[g], results.groups[g]);
    const done = groupComplete(results.groups[g]);
    el.innerHTML = `<tr><th>Team</th><th>P</th><th>GD</th><th>Pts</th></tr>` +
      ranked.map((t, i) =>
        `<tr class="${done ? "q" + (i + 1) : ""}"><td>${t.flag} ${t.code}</td><td>${t.p}</td><td>${t.gd}</td><td><strong>${t.pts}</strong></td></tr>`
      ).join("");
  }

  // Suggest knockout teams: R32 slots derive from the real group results;
  // later rounds propagate from the entered knockout results themselves
  // (those carry the authoritative real teams, even if FIFA's third-place
  // allocation differed from ours).
  const bracket = buildBracket(tournament, results.groups, {});
  const actualSide = (m) => {
    const e = results.knockout[m];
    if (!e?.score || !e.home || !e.away) return { winner: null, loser: null };
    const side = matchWinnerSide(e.score, e.pens);
    return {
      winner: side === 1 ? e.home : side === 2 ? e.away : null,
      loser: side === 1 ? e.away : side === 2 ? e.home : null,
    };
  };
  for (const def of tournament.knockout) {
    const hint = document.querySelector(`[data-hint="${def.m}"]`);
    const suggest = (slot, matchNo) => {
      if (slot.t === "WM") return actualSide(slot.m).winner;
      if (slot.t === "LM") return actualSide(slot.m).loser;
      return slot === def.h ? bracket.matches[matchNo].home : bracket.matches[matchNo].away;
    };
    const sh = suggest(def.h, def.m);
    const sa = suggest(def.a, def.m);
    if (sh || sa) {
      hint.textContent = `(derived: ${sh ?? "?"} v ${sa ?? "?"})`;
      const card = document.querySelector(`.ko-match[data-m="${def.m}"]`);
      const e = entryFor(def.m);
      if (!e.home && sh) { card.querySelector(`select[data-team="h"]`).value = sh; e.home = sh; }
      if (!e.away && sa) { card.querySelector(`select[data-team="a"]`).value = sa; e.away = sa; }
    }
  }

  // Serialize, dropping empty knockout entries
  const out = {
    groups: results.groups,
    knockout: Object.fromEntries(
      Object.entries(results.knockout)
        .filter(([, e]) => e.home || e.away || e.score)
        .map(([m, e]) => [m, { home: e.home, away: e.away, score: e.score, pens: e.pens ?? null }])
    ),
  };
  $("#json-out").value = JSON.stringify(out, null, 2) + "\n";
}
