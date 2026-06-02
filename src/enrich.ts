/**
 * Annotate every user in output/<milestone>/milestone-data.json with their
 * `newContributor` flag and `country`, drawing from two caches:
 *
 *   data/test-contributors.json   — has badge (permanent skip)
 *   data/new-contributors.json    — no badge at last check (cached too)
 *
 *   npm run enrich -- --milestone 7.0                       # default behaviour
 *   npm run enrich -- --milestone 7.0 --refresh-new         # re-check non-badge users
 *   npm run enrich -- --milestone 7.0 --refresh-badges      # re-check badge holders
 *   npm run enrich -- --milestone 7.0 --refresh-new --refresh-badges   # everyone
 *
 * Workflow:
 *   1. Load both caches.
 *   2. For each unique user in the milestone:
 *      - If in test-contributors AND not --refresh-badges → skip fetch, mark not-new, use cached country.
 *      - If in new-contributors AND not --refresh-new → skip fetch, mark new.
 *      - Else: fetch profile.
 *           Has badge → add to test-contributors, remove from new-contributors.
 *           No badge  → add/update new-contributors, remove from test-contributors.
 *   3. Save both caches.
 *   4. Annotate every test/repro contribution with `newContributor` + `country`.
 *
 * Also exported as `enrichMilestone()` so other commands (e.g. `npm run scrape`)
 * can run the same flow at the end of their work.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchUserProfile } from "./profile/badges.js";
import {
  loadNewContributors,
  loadTestContributors,
  saveNewContributors,
  saveTestContributors,
  type RegistryUser,
} from "./profile/registry.js";
import { readProgress } from "./progress/store.js";
import { writeOutputs } from "./progress/output.js";
import { allLeaderboardFiles } from "./build.js";

const OUTPUT_DIR = join(process.cwd(), "output");
const FETCH_DELAY_MS = 500;

function parseArgs(): { milestone: string; refreshNew: boolean; refreshBadges: boolean } {
  const args = process.argv.slice(2);
  let milestone = "";
  let refreshNew = false;
  let refreshBadges = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--milestone" && args[i + 1]) milestone = args[++i]!;
    else if (a === "--refresh-new") refreshNew = true;
    else if (a === "--refresh-badges") refreshBadges = true;
  }
  if (!milestone) {
    console.error("Usage: npm run enrich -- --milestone 7.0 [--refresh-new] [--refresh-badges]");
    process.exit(1);
  }
  return { milestone, refreshNew, refreshBadges };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Contribution = {
  user: string;
  badges?: string[]; // legacy — stripped if present
  newContributor?: boolean;
  country?: string | null;
  memberSince?: string;
  [k: string]: unknown;
};

type Progress = {
  schemaVersion: number;
  milestone: string;
  tickets: Record<string, { testers: Contribution[]; reproducers: Contribution[]; [k: string]: unknown }>;
};

export type EnrichOptions = { refreshNew?: boolean; refreshBadges?: boolean };

/** Enrich every contribution in output/<milestone>/milestone-data.json with
 *  newContributor / country / memberSince, using the two on-disk caches. Only
 *  users absent from both caches (or with refreshNew/refreshBadges=true)
 *  trigger a profile fetch. Safe to call from other commands after they
 *  finish writing tickets. */
export async function enrichMilestone(milestone: string, opts: EnrichOptions = {}): Promise<void> {
  const refreshNew = opts.refreshNew ?? false;
  const refreshBadges = opts.refreshBadges ?? false;
  const path = join(OUTPUT_DIR, milestone, "milestone-data.json");
  const data = JSON.parse(await readFile(path, "utf8")) as Progress;

  const testReg = await loadTestContributors();
  const newReg = await loadNewContributors();
  const testBefore = Object.keys(testReg.users).length;
  const newBefore = Object.keys(newReg.users).length;

  const users = new Set<string>();
  for (const t of Object.values(data.tickets)) {
    for (const c of t.testers) users.add(c.user);
    for (const c of t.reproducers) users.add(c.user);
  }
  const ordered = [...users].sort();
  const refreshNotes: string[] = [];
  if (refreshNew) refreshNotes.push("re-checking new-contributors");
  if (refreshBadges) refreshNotes.push("re-checking test-contributors");
  console.log(
    `Checking ${ordered.length} unique user(s)` +
      ` — test-contributors cache=${testBefore}, new-contributors cache=${newBefore}` +
      (refreshNotes.length ? ` (${refreshNotes.join(", ")})` : ""),
  );

  const info = new Map<string, { newContributor: boolean; country: string | null; memberSince: string }>();
  let fetched = 0;
  let promoted = 0;

  for (let i = 0; i < ordered.length; i++) {
    const user = ordered[i]!;

    // 1) Has badge cache.
    const t = testReg.users[user];
    if (t && !refreshBadges) {
      info.set(user, { newContributor: false, country: t.country, memberSince: t.memberSince });
      console.log(`  [${i + 1}/${ordered.length}] @${user}: ✅ cached test contributor (${t.country ?? "?"})`);
      continue;
    }
    // 2) No-badge cache.
    const n = newReg.users[user];
    if (n && !refreshNew) {
      info.set(user, { newContributor: true, country: n.country, memberSince: n.memberSince });
      console.log(`  [${i + 1}/${ordered.length}] @${user}: ⏭️ cached new contributor (${n.country ?? "?"})`);
      continue;
    }
    // 3) Fetch.
    if (fetched > 0) await sleep(FETCH_DELAY_MS);
    fetched++;
    try {
      const profile = await fetchUserProfile(user);
      const userRecord: RegistryUser = {
        location: profile.location,
        country: profile.country,
        memberSince: profile.memberSince,
      };
      if (profile.hasTestContributorBadge) {
        testReg.users[user] = userRecord;
        if (newReg.users[user]) {
          delete newReg.users[user];
          promoted++;
        }
        info.set(user, { newContributor: false, country: profile.country, memberSince: profile.memberSince });
        const refreshTag = t ? "🔁 refreshed" : "🆕 has badge →";
        console.log(
          `  [${i + 1}/${ordered.length}] @${user}: ${refreshTag} test-contributors (${profile.country ?? "?"})`,
        );
      } else {
        newReg.users[user] = userRecord;
        if (testReg.users[user]) delete testReg.users[user];
        info.set(user, { newContributor: true, country: profile.country, memberSince: profile.memberSince });
        console.log(
          `  [${i + 1}/${ordered.length}] @${user}: 🌱 no badge → new-contributors (${profile.country ?? "?"})`,
        );
      }
    } catch (err) {
      info.set(user, { newContributor: true, country: null, memberSince: "" });
      console.log(`  [${i + 1}/${ordered.length}] @${user}: ERROR ${(err as Error).message}`);
    }
  }

  // Annotate every contribution and strip legacy badges array if any.
  for (const ticket of Object.values(data.tickets)) {
    for (const c of [...ticket.testers, ...ticket.reproducers]) {
      const u = info.get(c.user);
      if (u) {
        c.newContributor = u.newContributor;
        c.country = u.country;
        c.memberSince = u.memberSince;
      }
      if ("badges" in c) delete c.badges;
    }
  }

  // Auto-prune registries to the union of users present in any
  // output/<milestone>/milestone-data.json. Keeps the registries as a derived
  // view of all milestones we've scanned, so stale entries from old classifier
  // runs don't accumulate. Case-insensitive match — wp.org usernames are
  // unique modulo case but Trac may render the same user with different
  // capitalisation across comments.
  const known = await collectAllMilestoneUsers();
  const pruneStats = pruneRegistry(testReg.users, known);
  const pruneStats2 = pruneRegistry(newReg.users, known);

  await saveTestContributors(testReg);
  await saveNewContributors(newReg);
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");

  // Regenerate every leaderboard from the freshly-enriched milestone-data.json
  // so the CSV/JSON outputs (incl. test-contributors.csv, new-contributors.csv)
  // pick up the new newContributor / country / memberSince fields.
  const milestoneDir = join(OUTPUT_DIR, milestone);
  const progress = await readProgress(path, milestone);
  const files = allLeaderboardFiles(progress);
  await writeOutputs(milestoneDir, milestone, files, Object.keys(progress.tickets).length, true);
  console.log(`Regenerated ${files.length} leaderboards from ${Object.keys(progress.tickets).length} ticket(s) in ${milestone}.`);

  const testAfter = Object.keys(testReg.users).length;
  const newAfter = Object.keys(newReg.users).length;
  const newCount = [...info.values()].filter((u) => u.newContributor).length;
  const totalPruned = pruneStats.dropped + pruneStats2.dropped;
  console.log(
    `\nCaches: test-contributors=${testAfter} (was ${testBefore}, +${promoted} promoted)` +
      ` · new-contributors=${newAfter} (was ${newBefore})` +
      (totalPruned ? ` · pruned ${totalPruned} stale entries` : "") +
      `\nMilestone ${milestone}: ${newCount} new contributor(s) of ${ordered.length}` +
      `\nFetched ${fetched} profile(s) this run`,
  );
}

/** Collect every user appearing in any output/<milestone>/milestone-data.json,
 *  keyed by lowercased username for case-insensitive lookup. */
async function collectAllMilestoneUsers(): Promise<Set<string>> {
  const users = new Set<string>();
  let milestones: string[];
  try {
    milestones = await readdir(OUTPUT_DIR);
  } catch {
    return users;
  }
  for (const m of milestones) {
    const path = join(OUTPUT_DIR, m, "milestone-data.json");
    let data: Progress;
    try {
      data = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    for (const t of Object.values(data.tickets)) {
      for (const c of [...t.testers, ...t.reproducers]) users.add(c.user.toLowerCase());
    }
  }
  return users;
}

/** Remove entries from a registry's users map whose lowercased key isn't in
 *  the keep-set. Also case-dedupes (if both "sergeybiryukov" and
 *  "SergeyBiryukov" exist, keep one). Mutates the map. */
function pruneRegistry(
  users: Record<string, RegistryUser>,
  keep: Set<string>,
): { dropped: number; deduped: number } {
  const byLower = new Map<string, string[]>();
  for (const k of Object.keys(users)) {
    const l = k.toLowerCase();
    const arr = byLower.get(l) ?? [];
    arr.push(k);
    byLower.set(l, arr);
  }
  let dropped = 0;
  let deduped = 0;
  for (const [l, keys] of byLower) {
    if (!keep.has(l)) {
      for (const k of keys) {
        delete users[k];
        dropped++;
      }
      continue;
    }
    if (keys.length > 1) {
      // Keep the first key; drop the rest.
      for (const k of keys.slice(1)) {
        delete users[k];
        deduped++;
      }
    }
  }
  return { dropped, deduped };
}

async function main() {
  const { milestone, refreshNew, refreshBadges } = parseArgs();
  await enrichMilestone(milestone, { refreshNew, refreshBadges });
}

// Only run main() when this file is executed directly (not when imported).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith("enrich.ts") || process.argv[1].endsWith("enrich.js"));

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
