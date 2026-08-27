/**
 * Regenerate every leaderboard from output/<milestone>/milestone-data.json
 * without hitting Trac or profiles.wordpress.org. Use after deleting any of
 * the CSV/JSON files, or after editing the classifier and re-running
 * reclassify.
 *
 *   npm run build -- --milestone 7.0
 *
 * Produces 5 leaderboards: patch-testing, reproduction, all-combined, plus
 * badge-status splits (test-contributors = badge holders, new-contributors =
 * promotion candidates). Quality tier is tracked internally on each
 * UserContribution but not shown in the leaderboard columns.
 */
import { join } from "node:path";
import {
  computeCombinedCounts,
  computeCounts,
  computeNewContributorCounts,
  computeTestContributorCounts,
  readProgress,
  type ProgressFile,
} from "./progress/store.js";
import { writeOutputs, type LeaderboardColumn } from "./progress/output.js";

import { buildCombinedNonBadge, writeCombinedNonBadgeFiles } from "./combine.js";

const OUTPUT_DIR = join(process.cwd(), "output");

const BASIC_COLUMNS: LeaderboardColumn[] = ["username", "count"];
const DETAILED_COLUMNS: LeaderboardColumn[] = ["username", "count", "country", "memberSince"];

/** Build the full list of leaderboard files for a milestone. Shared with
 *  batch/index/reclassify so every writer produces the same set. */
export function allLeaderboardFiles(progress: ProgressFile) {
  return [
    { jsonName: "patch-testing.json", csvName: "patch-testing.csv", rows: computeCounts(progress, "testers"), columns: BASIC_COLUMNS },
    { jsonName: "reproduction.json", csvName: "reproduction.csv", rows: computeCounts(progress, "reproducers"), columns: BASIC_COLUMNS },
    { jsonName: "all-combined.json", csvName: "all-combined.csv", rows: computeCombinedCounts(progress), columns: DETAILED_COLUMNS },
    // Badge-status leaderboards (require `npm run enrich`)
    { jsonName: "test-contributors.json", csvName: "test-contributors.csv", rows: computeTestContributorCounts(progress), columns: BASIC_COLUMNS },
    { jsonName: "new-contributors.json", csvName: "new-contributors.csv", rows: computeNewContributorCounts(progress), columns: BASIC_COLUMNS },
  ];
}

function parseArgs(): { milestone: string } {
  const args = process.argv.slice(2);
  let milestone = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--milestone" && args[i + 1]) milestone = args[++i]!;
  }
  if (!milestone) {
    console.error("Usage: npm run build -- --milestone 7.0");
    process.exit(1);
  }
  return { milestone };
}

async function main() {
  const { milestone } = parseArgs();
  const milestoneDir = join(OUTPUT_DIR, milestone);
  const progressPath = join(milestoneDir, "milestone-data.json");
  const progress = await readProgress(progressPath, milestone);
  const ticketCount = Object.keys(progress.tickets).length;
  if (ticketCount === 0) {
    console.error(`No tickets found in ${progressPath}. Run \`npm run batch\` first.`);
    process.exit(1);
  }

  const files = allLeaderboardFiles(progress);
  await writeOutputs(milestoneDir, milestone, files, ticketCount, true);

  try {
    const combinedResult = await buildCombinedNonBadge({ targetMilestone: milestone });
    await writeCombinedNonBadgeFiles(milestoneDir, combinedResult);
    await writeCombinedNonBadgeFiles(OUTPUT_DIR, combinedResult);
  } catch (err) {
    console.warn(`Could not generate combined non-badge leaderboard: ${(err as Error).message}`);
  }

  console.log(`Regenerated ${files.length} leaderboards + combined non-badge leaderboard from ${ticketCount} ticket(s) in ${milestone}.`);
}

// Only run main() when invoked directly (not when imported by scrape/enrich/etc.).
const invokedDirectly =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] &&
  (process.argv[1].endsWith("build.ts") || process.argv[1].endsWith("build.js"));

if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
