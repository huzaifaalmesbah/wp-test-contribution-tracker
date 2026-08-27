/**
 * Cross-milestone non-badge contributor aggregator.
 *
 * Scans all available milestone releases in output/<milestone>/milestone-data.json
 * and generates a combined multi-release leaderboard (JSON + CSV) for contributors
 * who do not currently hold the Test Contributor badge.
 *
 * Usage:
 *   npm run combine -- --milestone 7.1
 *   npm run combine -- --all
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadNewContributors, loadTestContributors } from "./profile/registry.js";
import { readProgress, type ProgressFile } from "./progress/store.js";

const OUTPUT_DIR = join(process.cwd(), "output");

export type CombinedNonBadgeRow = {
  username: string;
  total: number;
  milestoneCounts: Record<string, number>;
  country: string | null;
  memberSince: string;
};

export type CombinedNonBadgeOutput = {
  meta: {
    targetMilestone?: string;
    milestones: string[];
    totalUsers: number;
    generated: string;
  };
  counts: Array<Record<string, unknown>>;
};

function escapeCsv(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Parse milestone version string for sorting (e.g. "7.1" > "7.0" > "6.7"). */
function compareMilestones(a: string, b: string): number {
  const partsA = a.split(".").map((x) => parseInt(x, 10) || 0);
  const partsB = b.split(".").map((x) => parseInt(x, 10) || 0);
  const maxLen = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA !== numB) return numB - numA; // Descending
  }
  return b.localeCompare(a);
}

/** Discover all milestone directories in output/ with milestone-data.json. */
export async function getScannedMilestones(): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(OUTPUT_DIR);
  } catch {
    return [];
  }
  const milestones: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    try {
      const p = join(OUTPUT_DIR, entry, "milestone-data.json");
      await readFile(p, "utf8");
      milestones.push(entry);
    } catch {
      // not a milestone directory
    }
  }
  return milestones.sort(compareMilestones);
}

/** Compute ticket count per user for a milestone data progress object. */
function getMilestoneTicketCounts(progress: ProgressFile): Map<string, { count: number; country?: string | null; memberSince?: string }> {
  const byUser = new Map<string, { count: number; country?: string | null; memberSince?: string }>();
  for (const ticket of Object.values(progress.tickets)) {
    const seenOnTicket = new Set<string>();
    for (const c of [...ticket.testers, ...ticket.reproducers]) {
      if (!seenOnTicket.has(c.user)) {
        seenOnTicket.add(c.user);
        const existing = byUser.get(c.user);
        if (existing) {
          existing.count++;
          if (!existing.country && c.country) existing.country = c.country;
          if (!existing.memberSince && c.memberSince) existing.memberSince = c.memberSince;
        } else {
          byUser.set(c.user, {
            count: 1,
            country: c.country,
            memberSince: c.memberSince,
          });
        }
      }
    }
  }
  return byUser;
}

export type BuildCombinedOptions = {
  targetMilestone?: string;
  allHistorical?: boolean;
};

export async function buildCombinedNonBadge(opts: BuildCombinedOptions = {}): Promise<{
  meta: CombinedNonBadgeOutput["meta"];
  rows: CombinedNonBadgeRow[];
  milestones: string[];
}> {
  const milestones = await getScannedMilestones();
  if (milestones.length === 0) {
    throw new Error("No milestone data found in output/.");
  }

  const targetMilestone = opts.targetMilestone || milestones[0]!;
  const testReg = await loadTestContributors();
  const newReg = await loadNewContributors();

  // Load milestone progress files
  const milestoneProgressMap = new Map<string, Map<string, { count: number; country?: string | null; memberSince?: string }>>();
  for (const m of milestones) {
    const path = join(OUTPUT_DIR, m, "milestone-data.json");
    const progress = await readProgress(path, m);
    milestoneProgressMap.set(m, getMilestoneTicketCounts(progress));
  }

  // Determine candidate users
  const candidateUsers = new Set<string>();
  if (opts.allHistorical) {
    // All users in new-contributors registry or marked new in any milestone
    for (const [m, counts] of milestoneProgressMap.entries()) {
      for (const u of counts.keys()) {
        if (!testReg.users[u]) candidateUsers.add(u);
      }
    }
    for (const u of Object.keys(newReg.users)) {
      if (!testReg.users[u]) candidateUsers.add(u);
    }
  } else {
    // Users active in targetMilestone who do not have the badge
    const targetCounts = milestoneProgressMap.get(targetMilestone);
    if (targetCounts) {
      for (const u of targetCounts.keys()) {
        if (!testReg.users[u]) candidateUsers.add(u);
      }
    }
  }

  const rows: CombinedNonBadgeRow[] = [];
  for (const username of candidateUsers) {
    let total = 0;
    const milestoneCounts: Record<string, number> = {};
    let country: string | null = newReg.users[username]?.country ?? null;
    let memberSince: string = newReg.users[username]?.memberSince ?? "";

    for (const m of milestones) {
      const data = milestoneProgressMap.get(m);
      const userStat = data?.get(username);
      const count = userStat?.count ?? 0;
      milestoneCounts[m] = count;
      total += count;
      if (!country && userStat?.country) country = userStat.country;
      if (!memberSince && userStat?.memberSince) memberSince = userStat.memberSince;
    }

    rows.push({
      username,
      total,
      milestoneCounts,
      country,
      memberSince,
    });
  }

  // Sort by total DESC, then targetMilestone count DESC, then username ASC
  rows.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    const targetA = a.milestoneCounts[targetMilestone] ?? 0;
    const targetB = b.milestoneCounts[targetMilestone] ?? 0;
    if (targetB !== targetA) return targetB - targetA;
    return a.username.localeCompare(b.username);
  });

  return {
    meta: {
      targetMilestone: opts.allHistorical ? undefined : targetMilestone,
      milestones,
      totalUsers: rows.length,
      generated: new Date().toISOString(),
    },
    rows,
    milestones,
  };
}

export async function writeCombinedNonBadgeFiles(
  outputDir: string,
  data: {
    meta: CombinedNonBadgeOutput["meta"];
    rows: CombinedNonBadgeRow[];
    milestones: string[];
  },
): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const jsonCounts = data.rows.map((r) => {
    const obj: Record<string, unknown> = {
      username: r.username,
      total: r.total,
    };
    for (const m of data.milestones) {
      obj[m] = r.milestoneCounts[m] ?? 0;
    }
    return obj;
  });

  const jsonOutput: CombinedNonBadgeOutput = {
    meta: data.meta,
    counts: jsonCounts,
  };

  const jsonPath = join(outputDir, "combined-non-badge.json");
  await writeFile(jsonPath, JSON.stringify(jsonOutput, null, 2), "utf8");

  // CSV: username,total,7.1,7.0,...
  const columns = ["username", "total", ...data.milestones];
  const csvRows = data.rows.map((r) => {
    const cols = [
      r.username,
      String(r.total),
      ...data.milestones.map((m) => String(r.milestoneCounts[m] ?? 0)),
    ];
    return cols.join(",");
  });
  const csvOutput = [columns.join(","), ...csvRows].join("\n") + "\n";
  const csvPath = join(outputDir, "combined-non-badge.csv");
  await writeFile(csvPath, csvOutput, "utf8");
}

function parseArgs(): { milestone?: string; all: boolean } {
  const args = process.argv.slice(2);
  let milestone: string | undefined;
  let all = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--milestone" && args[i + 1]) milestone = args[++i]!;
    else if (a === "--all") all = true;
  }
  return { milestone, all };
}

async function main() {
  const { milestone, all } = parseArgs();
  const result = await buildCombinedNonBadge({
    targetMilestone: milestone,
    allHistorical: all,
  });

  const target = result.meta.targetMilestone || result.milestones[0]!;
  const targetDir = join(OUTPUT_DIR, target);

  // Write inside output/<targetMilestone>/
  await writeCombinedNonBadgeFiles(targetDir, result);
  // Also write to output/
  await writeCombinedNonBadgeFiles(OUTPUT_DIR, result);

  console.log(
    `Generated combined-non-badge.json and combined-non-badge.csv (${result.rows.length} users across milestones [${result.milestones.join(", ")}])` +
      ` in output/${target}/ and output/`,
  );
}

const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith("combine.ts") || process.argv[1].endsWith("combine.js"));

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
