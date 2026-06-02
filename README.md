# WordPress Test Contribution Tracker

> Per-milestone leaderboards of WordPress Trac patch-testing and
> bug-reproduction contributions, split between Test Contributor badge holders
> and promotion candidates.

A Node + TypeScript CLI that scrapes a WordPress core release milestone on
[core.trac.wordpress.org](https://core.trac.wordpress.org/), classifies every
ticket comment into **patch-testing reports** and **bug-reproduction reports**,
then attributes each one to the WordPress.org user who wrote it. The result is
a set of per-milestone leaderboards (JSON + CSV) that can be used to recognise
existing [Test Contributor badge](https://make.wordpress.org/test/handbook/)
holders and surface new contributors who do not yet hold the badge.

The toolchain is incremental and cache-friendly: scraping, classification,
profile enrichment and leaderboard rendering are separate steps and can be
re-run independently.

---

## Why

WordPress relies on community testers to verify patches and reproduce reported
bugs. Most of that work happens as free-form comments on Trac tickets, with no
structured field to point at. This tracker reads each fixed ticket for a
milestone, applies a rule-based classifier to every comment, and produces a
set of per-milestone CSV/JSON leaderboards covering patch-testing reports,
bug-reproduction reports, and badge-status splits (Test Contributor badge
holders vs. promotion candidates).

---

## How it works (data flow)

```
Trac tickets ──scrape/batch──▶ .cache/per-ticket/<id>/parsed.json
                                          │
                                          ▼
                                    classifier
                                          │
                                          ▼
                       output/<milestone>/milestone-data.json   ◀── source of truth (committed)
                                          │
                          ┌───────────────┴────────────────┐
                          │                                │
                       enrich                            build
                  (adds badge + country)     (writes leaderboards)
                          │                                │
                          ▼                                ▼
                merges back into                  output/<milestone>/
                milestone-data.json               *.json + *.csv  (gitignored)
```

`milestone-data.json` is the **single source of truth**. Every CSV and JSON
leaderboard in `output/<milestone>/` is regenerated from it by `npm run build`
— no network, no Trac access, no profile lookups. If a leaderboard ever looks
wrong, fix the classifier or re-run `enrich`, then rebuild.

**The five leaderboards `build` produces:**

| File | What it shows | How it's computed |
|------|---------------|-------------------|
| `patch-testing.{json,csv}` | Everyone who wrote a patch-testing report. | One row per user; `count` = number of tickets they tested on. |
| `reproduction.{json,csv}` | Everyone who reproduced a bug. | One row per user; `count` = number of tickets they reproduced on. |
| `all-combined.{json,csv}` | Testers + reproducers merged, with country and "Member Since". | One row per user; `count` = testing + reproduction tickets combined. |
| `test-contributors.{json,csv}` | Users who **already hold** the [Test Contributor badge](https://make.wordpress.org/test/handbook/). | Filter of `all-combined` by `newContributor === false`. Requires `npm run enrich` to have populated badge data. |
| `new-contributors.{json,csv}` | Users contributing **without** the badge yet — the promotion candidates list. | Filter of `all-combined` by `newContributor === true`. Same enrich prerequisite. |

To go from a clean checkout to all five files for milestone 7.0:

```bash
npm run batch    -- --milestone 7.0 --start 0 --count 50   # scrape + classify → milestone-data.json
npm run enrich   -- --milestone 7.0                        # tag each user with badge + country
npm run build    -- --milestone 7.0                        # write all 5 leaderboards
```

`batch` and `enrich` both also call `build` internally on completion, so the
explicit `build` step is only needed when you've edited `milestone-data.json`
directly or deleted some output files.

---

## Data collection methodology

This section explains *what* the pipeline collects at each stage and *why*,
beyond the command-level usage further down.

### 1. Which tickets we include

Every ticket on the milestone's [Trac report](https://core.trac.wordpress.org/)
that is **closed** with **resolution = `fixed`**. Closed tickets with
`duplicate`, `invalid`, `wontfix`, `worksforme`, `reported-upstream`, etc. are
excluded — those don't have a patch to test or a confirmed bug to reproduce.
`npm run list -- --milestone X.Y` prints the full breakdown.

### 2. What we extract from each ticket

For every comment on every included ticket, the scraper captures:

- **Comment body** — full HTML rendered by Trac, then reduced to plain text.
- **Structural labels** — headings (`<h1>`–`<h4>`), bolded paragraph labels
  (`<p><strong>X</strong></p>`), table headers, and first-column cells of
  2-column tables. These are the signal we look for to identify the official
  [Patch Testing Report](https://make.wordpress.org/test/handbook/) /
  Reproduction Report templates (`Environment`, `Steps taken`, `Expected
  behavior`, etc.).
- **Links** — `github.com/WordPress/wordpress-develop/pull/...`, attached
  `.diff` / `.patch` files, `playground.wordpress.net` URLs, screenshot hosts
  (Imgur, ibb.co, GitHub user-attachments, CleanShot, etc.), and screencast
  hosts (Loom, YouTube, Vimeo).
- **Image / video count** — embedded `<img>` tags + file mentions
  (`.png`, `.webm`, `.mp4`, etc., even when the upload didn't resolve into a
  link).
- **Comment author** — the wordpress.org username.

`batch` writes a rich per-ticket cache under `.cache/per-ticket/<id>/` so the
classifier can be re-run against the same data without re-hitting Trac.

### 3. How a comment gets a category

`src/extract/classify.ts` runs an ordered list of rules. Each comment ends up
in exactly one of:

- **`repro`** — the commenter reproduced a bug.
- **`test`** — the commenter tested a patch / PR / fix.
- **`none`** — the commenter did neither (general discussion, code review with
  no testing, off-topic).

Repro rules are evaluated first; if any fire, the comment is `repro`.
Otherwise test rules are evaluated; if any fire, the comment is `test`. The
matched rule names are stored in `reasons` so every decision is auditable.

### 4. False-positive guards

Bare narrative phrases like "I tested" or "looks good" are common in code
review and committer close-outs without representing real test work. The
classifier suppresses these patterns:

- **Committer close-outs** — "Merged in r62290.", "In 62290:", "[62290]" —
  guarded by `COMMITTER_MERGE_PHRASE`.
- **Test/repro requests directed at someone else** — "Can you test this?",
  "Could @fabiankaegy reproduce your setup?" — guarded by
  `TEST_REPRO_REQUEST_GUARD`.
- **Bare "looks good to me" / "LGTM"** — code-review approval without test
  execution — does not match any narrative rule unless paired with a
  screenshot / screencast (via `narrative_test_with_visual`).
- **Bare "thanks for the patch"** — fires on maintainer process advice
  and committer close-outs — removed as a standalone signal.
- **"I tested" without a patch noun** — "I tested by generating UUIDs",
  "I tested my plugin" — the `i\s+tested` patterns require a `patch` / `pr` /
  `diff` / `fix` / `it` / `this` object within ~6 tokens.
- **Hypothetical / question forms of "I can reproduce"** — "How can I
  reproduce?", "so I can reproduce your setup?" — guarded by
  `REPRO_HYPOTHETICAL_GUARD`.
- **Past-participle adjective uses** — "with a tested patch", "the tested
  patch" — negative lookbehind in `NARRATIVE_TEST_STRONG`.

### 5. Quality tiers

Each classified comment gets a tier alongside its category:

- **high** — full official template: `Patch Testing Report` /
  `Reproduction Report` heading, 3+ structural sections, or `Expected
  Behavior` / `Expected Result` paired with structural labels.
- **medium** — partial structural evidence: Before/After + image,
  `tested patch` phrase + PR/patch link, Playground link + image or test
  phrase, 2 structural labels + a patch signal, or any narrative test phrase
  paired with a screenshot/screencast.
- **low** — narrative-only claims that survived the false-positive guards
  ("I tested the patch", "I can reproduce") with no corroborating evidence.

The tier is stored per `UserContribution.quality` inside
`milestone-data.json` but is not surfaced as a leaderboard column.

### 6. How users are counted

A user's `count` on a leaderboard is the **number of tickets** they
contributed to in that category — not the number of comments. If
`@alice` left 5 testing comments on ticket #123, she's `count = 1` on
that ticket. A user's `quality` is the highest tier across all their
qualifying comments.

The combined leaderboards (`all-combined`, `test-contributors`,
`new-contributors`) sum a user's testing tickets + reproduction tickets.

### 7. Profile enrichment

After classification, `enrich` walks every unique user and fetches their
[wordpress.org profile](https://profiles.wordpress.org/) once to extract:

- **Has the [Test Contributor badge](https://make.wordpress.org/test/handbook/)** —
  by checking for the `badge-test-contributor` class.
- **Location** — from the `<span class="wp-p2-loc">` element in the redesigned
  profile header.
- **Member Since** — from `<li id="user-member-since">`.

Two on-disk caches make subsequent runs essentially free:
`data/test-contributors.json` (badge holders — once you have it, you have it;
re-checked only with `--refresh-badges`) and `data/new-contributors.json`
(known non-badge users — re-checked with `--refresh-new`). Locations are
resolved to countries via OpenStreetMap Nominatim, with a third on-disk cache
(`data/geocode-cache.json`).

---

## Requirements

- Node.js **>= 20** (see `engines` in `package.json`)
- npm
- Playwright Chromium (installed automatically by `npm install`)
- Network access to `core.trac.wordpress.org` and `profiles.wordpress.org`

---

## Install

```bash
npm install
npx playwright install chromium    # only if Playwright did not auto-install the browser
```

---

## Usage

All commands take `--milestone X.Y` (e.g. `--milestone 7.0`). Outputs are
written to `output/<milestone>/`.

### 1. List closed tickets in a milestone

Sanity check — print every closed ticket grouped by resolution, then dump the
`fixed` set.

```bash
npm run list -- --milestone 7.0
```

### 2. Scrape ticket comments

Two modes are available; pick one. Both write
`output/<milestone>/milestone-data.json` and the leaderboard files.

**Iterative batch mode (recommended while iterating on the classifier):**

```bash
npm run batch -- --milestone 7.0 --start 0 --count 20
```

For each ticket in the slice this caches:

- `.cache/per-ticket/<id>/page.html` — raw rendered ticket HTML
- `.cache/per-ticket/<id>/parsed.json` — parsed comments (labels, body, links, images)
- `.cache/per-ticket/<id>/classification.json` — detector output with reasons per comment

Re-run with the next `--start` to walk through the milestone in chunks, or use
`--only 64715,64761` to target specific tickets. For a per-batch human-readable
review file, run `npm run reclassify` after the batch (see step 3 below) — it
writes a single consolidated MD instead of one MD per batch.

**Full sweep mode (after the classifier is stable):**

```bash
npm run scrape -- --milestone 7.0                  # only new tickets
npm run scrape -- --milestone 7.0 --refresh-changed  # also re-scrape tickets whose changetime changed
npm run scrape -- --milestone 7.0 --refresh-all      # re-scrape everything
npm run scrape -- --milestone 7.0 --only 64715,64761 # force-scrape specific ticket IDs
npm run scrape -- --milestone 7.0 --delay 2000       # tweak base inter-request delay (ms)
```

This does **not** write the rich per-ticket cache (use `batch` for that).

### 3. Re-classify cached tickets

After editing `src/extract/classify.ts`, re-run the classifier against the
existing `.cache/per-ticket/` data without hitting Trac:

```bash
npm run reclassify -- --milestone 7.0
```

Rewrites `classification.json` per ticket, the milestone progress file, all
leaderboards, and a consolidated review MD at
`.cache/batches/<milestone>-reclassified.md` (per-ticket category + reasons
table for eyeballing).

### 4. Enrich users with badge + country

Annotate every user in the milestone with their Test Contributor badge status
and the country parsed from their wordpress.org profile.

```bash
npm run enrich -- --milestone 7.0
npm run enrich -- --milestone 7.0 --refresh-new      # also re-check users currently flagged "new"
npm run enrich -- --milestone 7.0 --refresh-badges   # also re-check existing badge holders
npm run enrich -- --milestone 7.0 --refresh-new --refresh-badges   # re-fetch everyone
```

Two on-disk caches (both committed to git) back this step:

- `data/test-contributors.json` — users who already hold the badge (skipped on
  subsequent runs by default; re-checked with `--refresh-badges`, e.g. when
  the wordpress.org profile UI changes the location/country markup)
- `data/new-contributors.json` — users seen contributing without the badge at
  last check (skipped by default, re-checked with `--refresh-new`; successful
  upgrades move automatically to `test-contributors.json`, and demotions move
  the other way)
- `data/geocode-cache.json` — location string → country lookups

### 5. Rebuild leaderboards

Regenerate every CSV/JSON output from `milestone-data.json` without touching
the network. Useful after a `reclassify`, or if leaderboard files were deleted.

```bash
npm run build -- --milestone 7.0
```

### Type-check

```bash
npm run typecheck
```

### A typical run

```bash
# Initial pass on a fresh milestone:
npm run list      -- --milestone 7.0
npm run batch     -- --milestone 7.0 --start 0  --count 50
npm run batch     -- --milestone 7.0 --start 50 --count 50
# …continue until done…
npm run enrich    -- --milestone 7.0
npm run build     -- --milestone 7.0

# Subsequent incremental refresh:
npm run scrape    -- --milestone 7.0 --refresh-changed
npm run enrich    -- --milestone 7.0 --refresh-new
```

---

## Output file shapes

See the **How it works** section above for the list of files and how each is
computed. This section documents the shape of those files.

Only `milestone-data.json` is committed to git; the five leaderboard files
are listed in `.gitignore` and regenerated by any of `build`, `batch`,
`scrape`, `enrich`, or `reclassify`.

The quality tier (high/medium/low) is tracked per user inside
`milestone-data.json` (`UserContribution.quality`) but is not surfaced as a
column in the leaderboard files. See **How the classifier works** below for
tier definitions.

Each leaderboard JSON file is shaped as:

```json
{
  "meta": {
    "milestone": "7.0",
    "ticketsScanned": 49,
    "generated": "2026-05-27T13:50:00.000Z",
    "finished": true
  },
  "counts": [
    { "username": "huzaifaalmesbah", "count": 6, "country": "Bangladesh", "memberSince": "May 6th, 2023" }
  ]
}
```

The corresponding CSV has one header row + one row per user, with the same
columns as `counts[]`. `patch-testing.csv`, `reproduction.csv`,
`test-contributors.csv` and `new-contributors.csv` only carry `username,count`;
`all-combined.csv` additionally carries `country,memberSince`.

`milestone-data.json` itself is shaped as:

```jsonc
{
  "schemaVersion": 1,
  "milestone": "7.0",
  "tickets": {
    "17133": {
      "url": "https://core.trac.wordpress.org/ticket/17133",
      "changetime": "...",
      "testers": [
        {
          "user": "huzaifaalmesbah",
          "quality": "high",                      // max tier across this user's comments on the ticket
          "reasons": [
            "expected_result_with_struct",
            "narrative_test_strong",
            "narrative_test_with_visual",
            "patch_test_heading",
            "struct_2_with_patch_signal",
            "struct_3plus",
            "tested_patch_with_link"
          ],
          "comments": ["https://core.trac.wordpress.org/ticket/17133#comment:42"],
          "newContributor": false,                // added by `enrich`
          "country": "Bangladesh",                // added by `enrich`
          "memberSince": "May 6th, 2023"          // added by `enrich`
        }
      ],
      "reproducers": [ /* same shape */ ]
    }
  }
}
```

---

## How the classifier works

Source: `src/extract/classify.ts`. Each comment is fed three groups of
features and matched against an ordered list of rules:

- **Structural signals** — section labels like `Patch Testing Report`,
  `Reproduction Report`, `Steps to Reproduce`, `Expected Behaviour`,
  `Before` / `After`, etc., extracted from headings, paragraph labels and
  table headers (see `src/extract/labels.ts`).
- **Link/image signals** — links to `github.com/WordPress/wordpress-develop/pull/...`,
  attached `.diff`/`.patch` files, Playground URLs, image-host URLs, and embedded
  screenshots.
- **Narrative signals** — first-person phrases ("I tested the patch", "I can
  reproduce", "Patch works as expected") with guard rails against question
  forms ("How can I reproduce this?") and past-participle adjective uses
  ("the tested patch").

Repro rules are evaluated first; if any fire, the comment is `repro`. Otherwise
test rules are evaluated; if any fire, the comment is `test`. The matched rule
names are stored in `reasons` and surface in the per-ticket review MDs so the
classifier's decisions stay auditable.

Each comment also gets a **quality** tier alongside its category:

- **high** — official template: `Patch Testing Report` / `Reproduction
  Report` heading, 3+ structural sections, or `Expected Behavior`/`Expected
  Result` paired with structural labels.
- **medium** — partial structural evidence: Before/After + image,
  `tested patch` phrase + PR/patch link, Playground link + image or test
  phrase, or 2 structural labels + a patch signal.
- **low** — narrative-only claims ("I tested the patch", "I can reproduce",
  "looks good"). Image/link verification is deliberately not required for
  this tier — users post arbitrary URLs and host-based checks are
  unreliable, so the tier itself is the filter.

User-level quality on a leaderboard is the highest tier across all the
user's qualifying comments on that ticket.

---

## Repository layout

```
src/
  index.ts          # `scrape` — full-milestone sweep
  batch.ts          # `batch`  — slice scrape with rich .cache outputs
  list.ts           # `list`   — print closed tickets grouped by resolution
  reclassify.ts     # `reclassify` — re-run classifier from cache
  enrich.ts         # `enrich` — add badge + country info from profiles.wordpress.org
  build.ts          # `build`  — regenerate leaderboards from milestone-data.json
  trac/             # Playwright wrappers for trac browser + ticket/listing parsers
  extract/          # Comment labels + classifier rules
  profile/          # WordPress.org profile fetcher, geocoder, registries
  progress/         # Progress file schema, aggregation, output writers

data/
  test-contributors.json     # Cached badge-holder registry (committed)
  new-contributors.json      # Cached non-badge users (committed)
  geocode-cache.json         # Location → country cache (committed)

output/
  <milestone>/
    milestone-data.json      # Source of truth (committed)
    *.json, *.csv            # Derived leaderboards (gitignored)

.cache/
  per-ticket/<id>/...        # Raw + parsed + classification per ticket
  batches/...                # Consolidated reclassify review MD
  query-debug.html           # `list --debug` artefact
```

---

## Notes on politeness

The scraper drives a real Chromium via Playwright and intentionally throttles
itself: a base delay of ~1.5s + up to 1.5s jitter between tickets, a 20s pause
every 50 tickets, and a single retry with 5s backoff on transient failures.
Profile enrichment uses a plain `fetch` with a 0.5s gap between requests. Be a
good citizen — don't crank `--delay` to zero.
