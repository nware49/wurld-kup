import {
  GROUP_IDS, PAIR_ORDER, ROUND_LABELS,
  buildBracket, computeGroupTable, groupComplete, rankThirds, computeAllTables,
  encodePayload, decodePayload, validateBracket, matchWinnerSide,
} from "./core.js";
import { REPO_OWNER, REPO_NAME, REPO_URL } from "./config.js";

const DRAFT_KEY = "wk26-draft-v1";

const state = {
  name: "",
  groups: Object.fromEntries(GROUP_IDS.map((g) => [g, PAIR_ORDER.map(() => null)])),
  ko: {},
};

let tournament = null;
let readOnly = false;

// Visual order of bracket columns (top half of the draw first, matching how
// the round-of-16 pairings feed the quarters/semis).
const BRACKET_COLS = [
  ["R32", [74, 77, 73, 75, 83, 84, 81, 82, 76, 78, 79, 80, 86, 88, 85, 87]],
  ["R16", [89, 90, 93, 94, 91, 92, 95, 96]],
  ["QF", [97, 98, 99, 100]],
  ["SF", [101, 102]],
  ["F", [104, 103]],
];

const $ = (sel) => document.querySelector(sel);

init();

async function init() {
  $("#repo-link").href = REPO_URL;
  tournament = await (await fetch("data/tournament.json")).json();

  const params = new URLSearchParams(location.search);
  const viewUser = params.get("user");
  if (viewUser) {
    await loadSubmission(viewUser);
  } else {
    loadDraft();
  }

  renderLockBanner();
  renderGroups();
  renderBracketSkeleton();
  refreshAll();
  wireSubmitBar();
}

async function loadSubmission(user) {
  try {
    const file = user.replace(/[^A-Za-z0-9_-]/g, "");
    const pred = await (await fetch(`data/predictions/${file}.json`)).json();
    state.name = pred.name;
    state.groups = pred.groups;
    for (const [m, e] of Object.entries(pred.knockout)) {
      state.ko[m] = { score: e.score, pens: e.pens };
    }
    readOnly = true;
    $("#view-banner").innerHTML =
      `<div class="notice">Viewing <strong>${esc(pred.name)}</strong>'s submitted bracket (@${esc(pred.user)}). ` +
      `<a href="index.html">Make your own →</a></div>`;
    $("#submit-bar").style.display = "none";
  } catch {
    $("#view-banner").innerHTML = `<div class="notice error">Couldn't load that bracket. Starting fresh.</div>`;
  }
}

// ---------------------------------------------------------------------------
// Draft persistence

function saveDraft() {
  if (readOnly) return;
  localStorage.setItem(DRAFT_KEY, JSON.stringify(state));
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    state.name = saved.name ?? "";
    for (const g of GROUP_IDS) {
      if (Array.isArray(saved.groups?.[g]) && saved.groups[g].length === 6) state.groups[g] = saved.groups[g];
    }
    state.ko = saved.ko ?? {};
  } catch { /* corrupt draft — start fresh */ }
}

// ---------------------------------------------------------------------------
// Lock banner

function locked() {
  return Date.now() > new Date(tournament.lockTime).getTime();
}

function renderLockBanner() {
  const el = $("#lock-banner");
  const lockAt = new Date(tournament.lockTime);
  if (locked()) {
    el.textContent = "🔒 Submissions are locked — the tournament has started";
    el.classList.add("locked");
    return;
  }
  const tick = () => {
    const ms = lockAt.getTime() - Date.now();
    if (ms <= 0) { renderLockBanner(); return; }
    const d = Math.floor(ms / 86400000);
    const h = Math.floor(ms / 3600000) % 24;
    const m = Math.floor(ms / 60000) % 60;
    el.textContent = `⏳ Submissions lock in ${d > 0 ? d + "d " : ""}${h}h ${m}m`;
  };
  tick();
  setInterval(tick, 30000);
}

// ---------------------------------------------------------------------------
// Group stage UI

function renderGroups() {
  const grid = $("#groups-grid");
  grid.innerHTML = "";
  $("#display-name").value = state.name;
  $("#display-name").disabled = readOnly;
  $("#display-name").addEventListener("input", (e) => {
    state.name = e.target.value;
    saveDraft();
  });

  for (const g of GROUP_IDS) {
    const teams = tournament.groups[g];
    const card = document.createElement("div");
    card.className = "group-card";
    card.innerHTML = `<h3>Group ${g}</h3>`;

    PAIR_ORDER.forEach(([i, j], idx) => {
      const row = document.createElement("div");
      row.className = "gmatch";
      row.innerHTML =
        `<span class="t-home">${esc(teams[i].name)} ${teams[i].flag}</span>` +
        `<input type="number" min="0" max="15" data-g="${g}" data-idx="${idx}" data-side="0" aria-label="${teams[i].name} goals">` +
        `<span class="dash">–</span>` +
        `<input type="number" min="0" max="15" data-g="${g}" data-idx="${idx}" data-side="1" aria-label="${teams[j].name} goals">` +
        `<span class="t-away">${teams[j].flag} ${esc(teams[j].name)}</span>`;
      card.appendChild(row);
    });

    const table = document.createElement("table");
    table.className = "mini-table";
    table.dataset.g = g;
    card.appendChild(table);
    grid.appendChild(card);
  }

  grid.querySelectorAll("input[type=number]").forEach((inp) => {
    const { g, idx, side } = inp.dataset;
    const cur = state.groups[g][idx];
    if (cur) inp.value = cur[Number(side)];
    inp.disabled = readOnly;
    inp.addEventListener("input", () => {
      const other = grid.querySelector(`input[data-g="${g}"][data-idx="${idx}"][data-side="${1 - side}"]`);
      const a = parseGoals(inp.value);
      const b = parseGoals(other.value);
      state.groups[g][idx] = a != null && b != null
        ? (side === "0" ? [a, b] : [b, a])
        : null;
      saveDraft();
      refreshAll();
    });
  });
}

function parseGoals(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 15 ? n : null;
}

function renderGroupTable(g) {
  const el = document.querySelector(`table.mini-table[data-g="${g}"]`);
  const ranked = computeGroupTable(tournament.groups[g], state.groups[g]);
  const done = groupComplete(state.groups[g]);
  el.innerHTML =
    `<tr><th>Team</th><th>P</th><th>W</th><th>D</th><th>L</th><th>GD</th><th>Pts</th></tr>` +
    ranked.map((t, i) =>
      `<tr class="${done ? "q" + (i + 1) : ""}">` +
      `<td>${t.flag} ${esc(t.code)}</td><td>${t.p}</td><td>${t.w}</td><td>${t.d}</td><td>${t.l}</td><td>${fmtGd(t.gd)}</td><td><strong>${t.pts}</strong></td></tr>`
    ).join("");
}

function fmtGd(n) { return n > 0 ? `+${n}` : String(n); }

// ---------------------------------------------------------------------------
// Thirds panel

function renderThirds() {
  const el = $("#thirds-panel");
  const allDone = GROUP_IDS.every((g) => groupComplete(state.groups[g]));
  if (!allDone) {
    const remaining = GROUP_IDS.filter((g) => !groupComplete(state.groups[g]));
    el.innerHTML = `Fill in all group-stage scores to rank the third-placed teams. Remaining: <strong>${remaining.join(", ")}</strong>`;
    return;
  }
  const tables = computeAllTables(tournament, state.groups);
  const ranked = rankThirds(tables);
  el.innerHTML =
    `<strong>Third-place ranking</strong> — the best 8 advance (points, goal difference, goals scored):<br>` +
    ranked.map((x, i) =>
      `<span class="third-chip ${i < 8 ? "in" : "out"}">${i + 1}. ${x.stats.flag} ${esc(x.stats.code)} ` +
      `(${x.stats.pts}pts, ${fmtGd(x.stats.gd)})</span>`
    ).join("");
}

// ---------------------------------------------------------------------------
// Knockout bracket UI

function slotLabel(def, matchNo, bracket) {
  switch (def.t) {
    case "W": return `Winner Group ${def.g}`;
    case "RU": return `Runner-up Group ${def.g}`;
    case "3": return bracket?.alloc?.[matchNo]
      ? `3rd Group ${bracket.alloc[matchNo]}`
      : `3rd place (${def.o.join("/")})`;
    case "WM": return `Winner M${def.m}`;
    case "LM": return `Loser M${def.m}`;
  }
}

function renderBracketSkeleton() {
  const root = $("#bracket");
  root.innerHTML = "";
  const colTitles = { R32: "Round of 32", R16: "Round of 16", QF: "Quarter-finals", SF: "Semi-finals", F: "Final & Third place" };
  for (const [round, matchNos] of BRACKET_COLS) {
    const col = document.createElement("div");
    col.className = "round-col";
    col.innerHTML = `<h4>${colTitles[round]}</h4>`;
    const wrap = document.createElement("div");
    wrap.className = "matches";
    for (const m of matchNos) {
      const def = tournament.knockout.find((d) => d.m === m);
      const card = document.createElement("div");
      card.className = "ko-match";
      card.dataset.m = m;
      card.innerHTML =
        `<div class="mnum">M${m} · ${ROUND_LABELS[def.r]}</div>` +
        koRowHTML(m, 0) + koRowHTML(m, 1) +
        `<div class="pens-row" data-pens="${m}" style="display:none"></div>`;
      wrap.appendChild(card);
    }
    col.appendChild(wrap);
    root.appendChild(col);
  }

  root.querySelectorAll("input[type=number]").forEach((inp) => {
    inp.disabled = readOnly;
    inp.addEventListener("input", () => {
      const m = inp.dataset.m;
      const card = root.querySelector(`.ko-match[data-m="${m}"]`);
      const h = parseGoals(card.querySelector(`input[data-side="0"]`).value);
      const a = parseGoals(card.querySelector(`input[data-side="1"]`).value);
      const prev = state.ko[m] ?? {};
      state.ko[m] = { score: h != null && a != null ? [h, a] : null, pens: prev.pens ?? null };
      if (!state.ko[m].score || state.ko[m].score[0] !== state.ko[m].score[1]) state.ko[m].pens = null;
      saveDraft();
      refreshAll();
    });
  });
}

function koRowHTML(m, side) {
  return `<div class="ko-row">` +
    `<span class="team tbd" data-team="${m}-${side}">…</span>` +
    `<input type="number" min="0" max="15" data-m="${m}" data-side="${side}" aria-label="goals">` +
    `</div>`;
}

function updateBracket() {
  const bracket = buildBracket(tournament, state.groups, state.ko);
  const root = $("#bracket");

  for (const def of tournament.knockout) {
    const m = bracket.matches[def.m];
    const card = root.querySelector(`.ko-match[data-m="${def.m}"]`);
    const entry = state.ko[def.m] ?? {};

    [["h", 0, m.home], ["a", 1, m.away]].forEach(([, side, code]) => {
      const span = card.querySelector(`[data-team="${def.m}-${side}"]`);
      const teamDef = side === 0 ? def.h : def.a;
      if (code) {
        const t = bracket.teamsByCode[code];
        span.textContent = `${t.flag} ${t.name}`;
        span.classList.remove("tbd");
        span.classList.toggle("adv", m.winner === code);
      } else {
        span.textContent = slotLabel(teamDef, def.m, bracket);
        span.className = "team tbd";
      }
      const inp = card.querySelector(`input[data-side="${side}"]`);
      const v = entry.score ? entry.score[side] : null;
      if (document.activeElement !== inp) inp.value = v ?? "";
    });

    // Penalty selector when scores are level
    const pensRow = card.querySelector(`[data-pens="${def.m}"]`);
    const tied = entry.score && entry.score[0] === entry.score[1];
    if (tied) {
      pensRow.style.display = "";
      const nameFor = (code, fallback) => code ? bracket.teamsByCode[code].code : fallback;
      pensRow.innerHTML = `Pens:` +
        [[1, m.home, "Home"], [2, m.away, "Away"]].map(([sideNo, code, fb]) =>
          `<button type="button" data-p="${sideNo}" class="${entry.pens === sideNo ? "sel" : ""}" ${readOnly ? "disabled" : ""}>` +
          `${esc(nameFor(code, fb))}</button>`
        ).join("");
      pensRow.querySelectorAll("button").forEach((btn) => {
        btn.addEventListener("click", () => {
          state.ko[def.m].pens = Number(btn.dataset.p);
          saveDraft();
          refreshAll();
        });
      });
    } else {
      pensRow.style.display = "none";
      pensRow.innerHTML = "";
    }
  }

  // Champion banner
  const champ = bracket.matches[104].winner;
  $("#champ-banner").innerHTML = champ
    ? `Your champion: <strong>${bracket.teamsByCode[champ].flag} ${esc(bracket.teamsByCode[champ].name)}</strong> 🏆`
    : "";

  return bracket;
}

// ---------------------------------------------------------------------------
// Submit / progress

function progressCounts(bracket) {
  let groupFilled = 0;
  for (const g of GROUP_IDS) groupFilled += state.groups[g].filter(Boolean).length;
  let koFilled = 0;
  for (const def of tournament.knockout) {
    const m = bracket.matches[def.m];
    if (m.score && m.winner) koFilled++;
  }
  return { groupFilled, koFilled, total: groupFilled + koFilled };
}

function refreshAll() {
  for (const g of GROUP_IDS) renderGroupTable(g);
  renderThirds();
  const bracket = updateBracket();
  const { total } = progressCounts(bracket);
  $("#progress").textContent = `${total} / 104 matches predicted`;
  $("#btn-submit").disabled = total < 104 || locked();
  if (locked()) $("#btn-submit").textContent = "Locked";
}

function wireSubmitBar() {
  $("#btn-submit").addEventListener("click", onSubmit);
  $("#btn-download").addEventListener("click", onDownload);
  $("#btn-random").addEventListener("click", onRandomFill);
  $("#btn-clear").addEventListener("click", () => {
    if (!confirm("Clear your entire bracket?")) return;
    localStorage.removeItem(DRAFT_KEY);
    location.reload();
  });
}

function currentDecoded() {
  const ko = {};
  for (const [m, e] of Object.entries(state.ko)) {
    if (e?.score) ko[m] = { score: e.score, pens: e.pens ?? null };
  }
  return { name: state.name, groups: state.groups, ko };
}

function onSubmit() {
  const decoded = currentDecoded();
  if (!state.name.trim()) {
    showModal(`<h3>Almost there</h3><p class="errors">Add your name at the top first so we know whose bracket this is.</p>`);
    return;
  }
  const v = validateBracket(tournament, { ...decoded, name: state.name });
  if (!v.ok) {
    showModal(`<h3>Not quite complete</h3><ul class="errors">${v.errors.slice(0, 12).map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`);
    return;
  }
  const payload = encodePayload(state.name, decoded.groups, decoded.ko);
  const issueUrl = `${REPO_URL}/issues/new?` + new URLSearchParams({
    template: "bracket-submission.yml",
    title: `Bracket: ${state.name}`,
    payload,
  }).toString();

  showModal(
    `<h3>Submit your bracket</h3>
     <ol>
       <li>Click the button below — it opens a pre-filled GitHub issue (you'll need a free GitHub account).</li>
       <li>Don't edit anything — just press <strong>Create</strong> on GitHub.</li>
       <li>A robot will check your bracket, save it to the repo, and close the issue within a minute or two.</li>
     </ol>
     <p><a class="button-primary" href="${issueUrl}" target="_blank" rel="noopener">Open GitHub submission →</a></p>
     <p>No GitHub account? <button class="ghost" id="modal-download">Download your bracket file</button>
     and send it to the pool organizer instead.</p>
     <details><summary>Raw payload (for the curious)</summary><textarea readonly>${esc(payload)}</textarea></details>
     <p>You can resubmit any time before kickoff — your latest bracket wins.</p>`
  );
  const dl = document.querySelector("#modal-download");
  if (dl) dl.addEventListener("click", onDownload);
}

function onDownload() {
  const decoded = currentDecoded();
  const payload = encodePayload(state.name || "anonymous", decoded.groups, decoded.ko);
  const blob = new Blob([payload + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `bracket-${(state.name || "anonymous").replace(/\W+/g, "-").toLowerCase()}.txt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function onRandomFill() {
  if (readOnly) return;
  const r = (n) => Math.floor(Math.random() * n);
  const score = () => {
    // Weighted toward realistic football scores
    const goals = [0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 4];
    return [goals[r(goals.length)], goals[r(goals.length)]];
  };
  for (const g of GROUP_IDS) {
    state.groups[g] = state.groups[g].map((s) => s ?? score());
  }
  for (const def of tournament.knockout) {
    if (state.ko[def.m]?.score) continue;
    const s = score();
    state.ko[def.m] = { score: s, pens: s[0] === s[1] ? 1 + r(2) : null };
  }
  saveDraft();
  renderGroups();
  renderBracketSkeleton();
  refreshAll();
}

// ---------------------------------------------------------------------------

function showModal(html) {
  const root = $("#modal-root");
  root.innerHTML = `<div class="modal-backdrop"><div class="modal">${html}<p><button class="ghost" id="modal-close">Close</button></p></div></div>`;
  root.querySelector("#modal-close").addEventListener("click", () => (root.innerHTML = ""));
  root.querySelector(".modal-backdrop").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) root.innerHTML = "";
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
