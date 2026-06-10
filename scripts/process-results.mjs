// Processes a results-update issue (organizer only — the workflow gates on
// author_association). Validates the JSON shape and writes data/results.json.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { GROUP_IDS } from "../js/core.js";

const tournament = JSON.parse(readFileSync(new URL("../data/tournament.json", import.meta.url)));

const body = process.env.ISSUE_BODY ?? "";

function output(status, message) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `status=${status}\nmessage<<WK_EOF\n${message}\nWK_EOF\n`);
  console.log(`[${status}] ${message}`);
}

function extractJson(text) {
  const section = /### Results JSON\s+```[a-z]*\n([\s\S]*?)```/i.exec(text);
  if (section) return section[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : null;
}

const validScore = (s) =>
  s == null ||
  (Array.isArray(s) && s.length === 2 && s.every((x) => Number.isInteger(x) && x >= 0 && x <= 15));

try {
  const raw = extractJson(body);
  if (!raw) { output("error", "No results JSON found in this issue."); process.exit(0); }

  const data = JSON.parse(raw);
  const errors = [];
  const codes = new Set(GROUP_IDS.flatMap((g) => tournament.groups[g].map((t) => t.code)));
  const matchNos = new Set(tournament.knockout.map((d) => String(d.m)));

  for (const [g, scores] of Object.entries(data.groups ?? {})) {
    if (!GROUP_IDS.includes(g)) { errors.push(`Unknown group "${g}".`); continue; }
    if (!Array.isArray(scores) || scores.length !== 6) { errors.push(`Group ${g}: expected 6 entries.`); continue; }
    scores.forEach((s, i) => { if (!validScore(s)) errors.push(`Group ${g} match ${i + 1}: bad score.`); });
  }
  for (const [m, e] of Object.entries(data.knockout ?? {})) {
    if (!matchNos.has(m)) { errors.push(`Unknown knockout match "${m}".`); continue; }
    if (e.home != null && !codes.has(e.home)) errors.push(`Match ${m}: unknown team "${e.home}".`);
    if (e.away != null && !codes.has(e.away)) errors.push(`Match ${m}: unknown team "${e.away}".`);
    if (!validScore(e.score)) errors.push(`Match ${m}: bad score.`);
    if (e.pens != null && e.pens !== 1 && e.pens !== 2) errors.push(`Match ${m}: pens must be 1, 2, or null.`);
    if (e.score && e.score[0] === e.score[1] && e.pens == null && tournament.knockout.some((d) => String(d.m) === m)) {
      errors.push(`Match ${m}: drawn knockout score needs a pens winner.`);
    }
  }

  if (errors.length) {
    output("error", "Results didn't validate:\n\n" + errors.slice(0, 15).map((e) => `- ${e}`).join("\n"));
    process.exit(0);
  }

  const clean = { groups: data.groups ?? {}, knockout: data.knockout ?? {} };
  writeFileSync(new URL("../data/results.json", import.meta.url), JSON.stringify(clean, null, 2) + "\n");

  const groupCount = Object.values(clean.groups).flat().filter(Boolean).length;
  const koCount = Object.values(clean.knockout).filter((e) => e?.score).length;
  output("ok", `✅ Results updated: ${groupCount} group matches + ${koCount} knockout matches recorded. The leaderboard will refresh when the site redeploys.`);
} catch (err) {
  output("error", `Couldn't process results: ${err.message}`);
}
