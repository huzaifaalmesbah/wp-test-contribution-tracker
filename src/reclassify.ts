/**
 * Re-run classifier on the cached per-ticket data without hitting Trac.
 * Use after editing src/extract/classify.ts to see the updated results.
 *
 *   npm run reclassify -- --milestone 7.0
 *
 * Re-reads .cache/per-ticket/<id>/parsed.json for every cached ticket,
 * re-runs the classifier, and rewrites:
 *   .cache/per-ticket/<id>/classification.json
 *   output/<milestone>/milestone-data.json + leaderboards
 *   .cache/batches/<milestone>-reclassified.md
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyComment } from "./extract/classify.js";
import {
  aggregateContributions,
  readProgress,
  ticketUrl,
  writeProgress,
  type UserContribution,
} from "./progress/store.js";
import { writeOutputs } from "./progress/output.js";
import { allLeaderboardFiles } from "./build.js";
import type { ParsedTicket } from "./trac/ticket.js";

const ROOT = process.cwd();
const CACHE_DIR = join(ROOT, ".cache", "per-ticket");
const BATCH_DIR = join(ROOT, ".cache", "batches");
const OUTPUT_DIR = join(ROOT, "output");

function parseArgs(): { milestone: string } {
  const args = process.argv.slice(2);
  let milestone = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--milestone" && args[i + 1]) milestone = args[++i]!;
  }
  if (!milestone) {
    console.error("Usage: npm run reclassify -- --milestone 7.0");
    process.exit(1);
  }
  return { milestone };
}

async function main() {
  const { milestone } = parseArgs();
  const milestoneDir = join(OUTPUT_DIR, milestone);
  const progressPath = join(milestoneDir, "milestone-data.json");
  const progress = await readProgress(progressPath, milestone);
  await mkdir(BATCH_DIR, { recursive: true });

  let dirs: string[];
  try {
    dirs = await readdir(CACHE_DIR);
  } catch {
    console.error("No cache directory. Run `npm run batch` first.");
    process.exit(1);
  }
  const ticketDirs = dirs.filter((d) => /^\d+$/.test(d)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  console.log(`Re-classifying ${ticketDirs.length} cached ticket(s)…`);

  type Result = {
    id: number;
    url: string;
    testers: UserContribution[];
    reproducers: UserContribution[];
    comments: Array<{ num: string; author: string; category: string; reasons: string[] }>;
  };
  const all: Result[] = [];

  for (const id of ticketDirs) {
    const dir = join(CACHE_DIR, id);
    let parsed: ParsedTicket;
    try {
      parsed = JSON.parse(await readFile(join(dir, "parsed.json"), "utf8"));
    } catch {
      console.log(`  #${id}: missing parsed.json, skipping`);
      continue;
    }

    const classifications: Array<{ num: string; author: string; category: string; reasons: string[] }> = [];
    for (const c of parsed.comments) {
      const r = classifyComment({ labels: c.labels, bodyText: c.bodyText, links: c.links, imageCount: c.imageCount });
      classifications.push({ num: c.num, author: c.author, category: r.category, reasons: r.reasons });
    }

    const testers = aggregateContributions(classifications, "test", parsed.url);
    const reproducers = aggregateContributions(classifications, "repro", parsed.url);

    await writeFile(
      join(dir, "classification.json"),
      JSON.stringify(
        {
          id: parsed.id,
          url: parsed.url,
          commentCount: parsed.comments.length,
          testers,
          reproducers,
          comments: classifications,
        },
        null,
        2,
      ),
      "utf8",
    );

    const key = String(parsed.id);
    const prev = progress.tickets[key];
    progress.tickets[key] = {
      url: ticketUrl(parsed.id),
      testers,
      reproducers,
      changetime: prev?.changetime || "",
    };

    all.push({ id: parsed.id, url: parsed.url, testers, reproducers, comments: classifications });

    const summaryLine =
      (testers.length ? `testers: ${testers.map((u) => u.user).join(", ")}` : "") +
      (testers.length && reproducers.length ? " | " : "") +
      (reproducers.length ? `reproducers: ${reproducers.map((u) => u.user).join(", ")}` : "");
    console.log(`  #${id} → ${summaryLine || "—"}`);
  }

  await writeProgress(progressPath, progress);
  await writeOutputs(
    milestoneDir,
    milestone,
    allLeaderboardFiles(progress),
    Object.keys(progress.tickets).length,
    false,
  );

  const lines: string[] = [];
  lines.push(`# Milestone ${milestone} — Re-classified (${all.length} cached tickets)`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push("");
  const wT = all.filter((r) => r.testers.length).length;
  const wR = all.filter((r) => r.reproducers.length).length;
  lines.push(`- Cached tickets: ${all.length}`);
  lines.push(`- Tickets with testers: ${wT}`);
  lines.push(`- Tickets with reproducers: ${wR}`);
  lines.push("");
  for (const r of all) {
    lines.push(`## #${r.id} — ${r.url}`);
    lines.push("");
    lines.push(`Cache: \`.cache/per-ticket/${r.id}/\``);
    lines.push("");
    lines.push(`- Testers: ${r.testers.length ? r.testers.map((u) => u.user).join(", ") : "—"}`);
    lines.push(`- Reproducers: ${r.reproducers.length ? r.reproducers.map((u) => u.user).join(", ") : "—"}`);
    lines.push("");
    if (r.comments.length === 0) {
      lines.push("_No comments._");
      lines.push("");
      continue;
    }
    lines.push(`| # | Author | Class | Reasons |`);
    lines.push(`|---|--------|-------|---------|`);
    for (const c of r.comments) {
      lines.push(`| ${c.num} | @${c.author} | ${c.category} | ${c.reasons.join(", ") || "—"} |`);
    }
    lines.push("");
  }
  const mdPath = join(BATCH_DIR, `${milestone}-reclassified.md`);
  await writeFile(mdPath, lines.join("\n"), "utf8");
  console.log(`\nReview file: ${mdPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
