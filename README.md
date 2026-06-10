# ⚽ Wurld Kup '26 — Bracket Prediction Pool

A fully self-contained World Cup 2026 prediction pool for friends and family.
Everything — the site, the submissions, the results, and the leaderboard —
lives in this one GitHub repo. No database, no server, no third-party
services.

- **Predict**: score predictions for all 104 matches. Group scores decide your
  group standings and which third-place teams advance; the knockout bracket
  builds itself exactly like the real one (Round of 32 → Final).
- **Submit**: one click opens a pre-filled GitHub issue; a GitHub Action
  validates the bracket and commits it to `data/predictions/`.
- **Score**: the organizer enters real results as matches finish; the
  leaderboard recomputes everyone's points in the browser.

## One-time setup (organizer)

1. Merge this branch into `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Actions → General → Workflow permissions: Read and write
   permissions** (so the bots can commit submissions and results).
4. Make sure Issues are enabled (Settings → General → Features).
5. Push anything to `main` (or run the *Deploy site to GitHub Pages* workflow
   manually) — the site appears at `https://<owner>.github.io/<repo>/`.
6. Sanity-check `data/tournament.json`: team list and the `lockTime`
   (currently set to the opening kickoff, `2026-06-11T19:00:00-04:00` —
   adjust if the real kickoff time differs).

## How friends submit

1. Fill in every score on the site (it autosaves in the browser).
2. Click **Submit bracket** → opens a pre-filled GitHub issue (needs a free
   GitHub account) → press **Create**.
3. The `Process bracket submission` workflow validates it immediately and
   comments. The bracket is held until **the organizer adds the `approved`
   label** to the issue (the pool is invite-only; your own submissions are
   pre-approved). On approval the bot commits
   `data/predictions/<github-username>.json`, comments, and closes the issue.
   Resubmitting before the lock simply replaces the previous bracket.

The deadline applies to when the bracket was submitted or last edited, so
approving after kickoff is safe. The site is also marked `noindex` (plus
`robots.txt`) so it won't show up in search engines — but it is still
technically public, so tell people to use first names or nicknames.

**No GitHub account?** They click **Download file** instead and send you the
file. You import it with:

```sh
node scripts/import-bracket.mjs bracket-uncle-rico.txt
git add data/predictions && git commit -m "Import bracket" && git push
```

Submissions are rejected automatically after `lockTime`. To accept a
straggler anyway, add the `late-accept` label to their issue and ask them to
edit it (any edit re-triggers processing).

## Entering real results

Open `admin.html` on the site. Enter scores as matches finish (knockout
scores are after extra time, with a penalties winner for draws — knockout
team dropdowns pre-fill from the real group standings as they complete).
Then either:

- **Publish via GitHub issue** — only works for the repo owner/collaborators;
  a workflow validates and commits `data/results.json`; or
- copy the generated JSON into `data/results.json` by hand and push.

The leaderboard updates as soon as Pages redeploys (automatic on every push
to `main`).

## Scoring

Each match has a base value **P = 4** in the group stage, doubling every
knockout round (R32 = 8, R16 = 16, QF = 32, SF & third-place = 64,
Final = 128):

| What you got right | Points |
|---|---|
| Correct outcome (winner / draw; in knockouts: your advancing team advanced) | P |
| + Exact score both sides | +P (perfect pick = 2×P) |
| + Exact one side, or within ±1 on both | +P/2 |
| + Within ±1 on one side | +P/4 |

Outcome points and the (best applicable) score bonus stack. Knockout matches
are scored slot-by-slot against the real bracket: you get the outcome point
if the team you advanced from that slot really advanced, and score-side
comparisons only count for teams you correctly placed in the slot. Full
details: [rules.html](rules.html) on the site.

A perfect bracket scores **1,984 points**.

## Repo layout

```
index.html / rules.html / leaderboard.html / admin.html   the site
js/core.js          shared bracket + scoring logic (browser AND Node)
js/app.js           prediction builder UI
data/tournament.json  teams, groups, knockout template, scoring config
data/results.json     real results (organizer-maintained)
data/predictions/     one JSON per submitted bracket + index.json
scripts/process-submission.mjs   issue → prediction file (GitHub Action)
scripts/process-results.mjs      issue → results.json (GitHub Action)
scripts/import-bracket.mjs       manual import for emailed brackets
scripts/selftest.mjs             logic self-tests (run in CI before deploy)
.github/workflows/    submission, results, and Pages deploy automation
```

## Notes

- Group standings use FIFA tiebreakers (points, GD, goals, head-to-head),
  with team code as the deterministic last resort.
- Third-place teams are slotted into the bracket honoring FIFA's
  allowed-group constraints via a deterministic assignment. FIFA's official
  allocation table may differ in rare scenarios; since predictions are scored
  per real bracket slot, the same rule applies to everyone.
- Local development: `python3 -m http.server` (or any static server) from the
  repo root, then open `http://localhost:8000`. Run `node scripts/selftest.mjs`
  to check the logic.
