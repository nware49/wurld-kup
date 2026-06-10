// Processes a bracket-submission issue: validates the payload and writes the
// prediction into data/predictions/. Never throws — reports status via
// GITHUB_OUTPUT so the workflow can comment on the issue either way.
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { decodePayload, validateBracket, expandPrediction } from "../js/core.js";

const tournament = JSON.parse(readFileSync(new URL("../data/tournament.json", import.meta.url)));

const body = process.env.ISSUE_BODY ?? "";
const author = process.env.ISSUE_AUTHOR ?? "";
// The deadline applies to when the bracket was submitted/edited — not to
// when the organizer gets around to approving it (a "labeled" event).
const eventTime = (process.env.EVENT_ACTION === "edited" && process.env.ISSUE_UPDATED_AT)
  || process.env.ISSUE_CREATED_AT
  || new Date().toISOString();
const labels = (process.env.ISSUE_LABELS ?? "").split(",");

function output(status, message) {
  const out = process.env.GITHUB_OUTPUT;
  const payload = `status=${status}\nmessage<<WK_EOF\n${message}\nWK_EOF\n`;
  if (out) appendFileSync(out, payload);
  console.log(`[${status}] ${message}`);
}

function extractPayload(text) {
  // Issue forms render the textarea as "### Bracket payload" followed by a
  // fenced code block. Fall back to any line that looks like a payload.
  const section = /### Bracket payload\s+```[a-z]*\n([\s\S]*?)```/i.exec(text);
  if (section) return section[1].trim();
  const line = text.split("\n").map((l) => l.trim()).find((l) => l.startsWith("WK1|"));
  return line ?? null;
}

try {
  if (!author || !/^[A-Za-z0-9-]+$/.test(author)) {
    output("error", "Could not determine a safe GitHub username for this submission.");
    process.exit(0);
  }

  const lockAt = new Date(tournament.lockTime);
  if (new Date(eventTime) > lockAt && !labels.includes("late-accept")) {
    output("error",
      `Submissions locked at **${lockAt.toUTCString()}** — the tournament has started, so this bracket can't be accepted. ` +
      `(The organizer can add the \`late-accept\` label and edit the issue to override.)`);
    process.exit(0);
  }

  const raw = extractPayload(body);
  if (!raw) {
    output("error",
      "No bracket payload found in this issue. Please submit from the predictions site using the **Submit bracket** button — it pre-fills everything for you.");
    process.exit(0);
  }

  const decoded = decodePayload(raw);
  const v = validateBracket(tournament, decoded);
  if (!v.ok) {
    output("error",
      "Your bracket didn't validate:\n\n" + v.errors.slice(0, 15).map((e) => `- ${e}`).join("\n") +
      "\n\nGo back to the site, finish your picks, and submit again.");
    process.exit(0);
  }

  // Valid but not yet approved: hold it in the queue. The organizer adds the
  // "approved" label to accept (their own submissions are pre-approved).
  if (process.env.APPROVED !== "true") {
    output("pending",
      `✅ Your bracket is valid — **${decoded.name}**, nice picks!\n\n` +
      `⏳ It's now waiting for the pool organizer to approve it (this pool is invite-only). ` +
      `You'll get a confirmation comment here once it's saved. ` +
      `You can still edit your submission before kickoff — just resubmit from the site.`);
    process.exit(0);
  }

  const expanded = expandPrediction(tournament, decoded, {
    user: author,
    submittedAt: new Date(eventTime).toISOString(),
  });

  mkdirSync(new URL("../data/predictions/", import.meta.url), { recursive: true });
  const file = `${author}.json`;
  writeFileSync(new URL(`../data/predictions/${file}`, import.meta.url), JSON.stringify(expanded, null, 2) + "\n");

  const indexUrl = new URL("../data/predictions/index.json", import.meta.url);
  let index = [];
  try { index = JSON.parse(readFileSync(indexUrl, "utf8")); } catch { /* rebuild */ }
  index = index.filter((e) => e.user !== author);
  index.push({ user: author, name: expanded.name, file, submittedAt: expanded.submittedAt });
  index.sort((a, b) => a.user.localeCompare(b.user));
  writeFileSync(indexUrl, JSON.stringify(index, null, 2) + "\n");

  output("ok",
    `✅ Bracket for **${expanded.name}** (@${author}) saved! Champion pick: **${expanded.champion}**.\n\n` +
    `It will appear on the leaderboard once the site redeploys (a minute or two). ` +
    `You can resubmit any time before kickoff — your latest bracket replaces this one.`);
} catch (err) {
  output("error", `Something went wrong processing this bracket: ${err.message}`);
}
