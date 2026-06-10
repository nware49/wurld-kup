// Organizer fallback for friends without GitHub accounts:
//   node scripts/import-bracket.mjs path/to/bracket-uncle-rico.txt [id]
// Validates the downloaded payload file and stores it in data/predictions/
// under the given id (defaults to a slug of the display name). Commit and
// push the result.
import { readFileSync, writeFileSync } from "node:fs";
import { decodePayload, validateBracket, expandPrediction } from "../js/core.js";

const [file, idArg] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/import-bracket.mjs <bracket-file> [id]");
  process.exit(1);
}

const tournament = JSON.parse(readFileSync(new URL("../data/tournament.json", import.meta.url)));
const raw = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).find((l) => l.startsWith("WK1|"));
if (!raw) {
  console.error("No WK1 payload found in that file.");
  process.exit(1);
}

const decoded = decodePayload(raw);
const v = validateBracket(tournament, decoded);
if (!v.ok) {
  console.error("Bracket didn't validate:");
  for (const e of v.errors) console.error(`  - ${e}`);
  process.exit(1);
}

const id = (idArg ?? decoded.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
if (!id) { console.error("Couldn't derive an id; pass one explicitly."); process.exit(1); }

const expanded = expandPrediction(tournament, decoded, { user: id, submittedAt: new Date().toISOString() });
writeFileSync(new URL(`../data/predictions/${id}.json`, import.meta.url), JSON.stringify(expanded, null, 2) + "\n");

const indexUrl = new URL("../data/predictions/index.json", import.meta.url);
let index = [];
try { index = JSON.parse(readFileSync(indexUrl, "utf8")); } catch { /* rebuild */ }
index = index.filter((e) => e.user !== id);
index.push({ user: id, name: expanded.name, file: `${id}.json`, submittedAt: expanded.submittedAt });
index.sort((a, b) => a.user.localeCompare(b.user));
writeFileSync(indexUrl, JSON.stringify(index, null, 2) + "\n");

console.log(`Imported "${expanded.name}" as data/predictions/${id}.json (champion: ${expanded.champion}).`);
console.log("Now commit and push:");
console.log(`  git add data/predictions && git commit -m "Import bracket for ${expanded.name}" && git push`);
