import { join } from "node:path";
import { openBrowser } from "./trac/browser.js";
import { listFixedTickets, type TicketSummary } from "./trac/listTickets.js";
import { parseTicket } from "./trac/ticket.js";
import { classifyComment } from "./extract/classify.js";
import {
  aggregateContributions,
  readProgress,
  ticketUrl,
  writeProgress,
  type ProgressFile,
  type UserContribution,
} from "./progress/store.js";
import { writeOutputs } from "./progress/output.js";
import { allLeaderboardFiles } from "./build.js";
import { enrichMilestone } from "./enrich.js";

const ROOT = process.cwd();
const OUTPUT_DIR = join(ROOT, "output");
const DEFAULT_DELAY_MS = 1500;
const JITTER_MS = 1500;
const LONG_PAUSE_EVERY = 50;
const LONG_PAUSE_MS = 20_000;
const RETRY_BACKOFF_MS = 5000;

type Args = {
  milestone: string;
  only?: number[];
  refreshChanged: boolean;
  refreshAll: boolean;
  baseDelayMs: number;
  enrich: boolean;
  refreshNew: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let milestone = "";
  let only: number[] | undefined;
  let refreshChanged = false;
  let refreshAll = false;
  let baseDelayMs = DEFAULT_DELAY_MS;
  let enrich = true;
  let refreshNew = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--milestone" && args[i + 1]) milestone = args[++i]!;
    else if (a === "--only" && args[i + 1]) only = args[++i]!.split(",").map((x) => parseInt(x, 10));
    else if (a === "--refresh-changed") refreshChanged = true;
    else if (a === "--refresh-all") refreshAll = true;
    else if (a === "--delay" && args[i + 1]) baseDelayMs = parseInt(args[++i]!, 10);
    else if (a === "--no-enrich") enrich = false;
    else if (a === "--refresh-new") refreshNew = true;
  }
  if (!milestone) {
    console.error(
      "Usage: npm run scrape -- --milestone 7.0 [--refresh-changed] [--refresh-all] [--delay 1500] [--only 64715,64761] [--no-enrich] [--refresh-new]",
    );
    process.exit(1);
  }
  return { milestone, only, refreshChanged, refreshAll, baseDelayMs, enrich, refreshNew };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (base: number) => base + Math.floor(Math.random() * JITTER_MS);

async function persist(milestoneDir: string, progress: ProgressFile, finished: boolean) {
  await writeProgress(join(milestoneDir, "milestone-data.json"), progress);
  await writeOutputs(
    milestoneDir,
    progress.milestone,
    allLeaderboardFiles(progress),
    Object.keys(progress.tickets).length,
    finished,
  );
}

type WorkItem = { id: number; changetime: string; reason: "new" | "changed" | "forced" };

function planWork(args: Args, list: TicketSummary[], progress: ProgressFile): WorkItem[] {
  if (args.only && args.only.length) {
    return args.only.map((id) => {
      const found = list.find((t) => t.id === id);
      return { id, changetime: found?.changetime || "", reason: "forced" as const };
    });
  }
  const items: WorkItem[] = [];
  for (const t of list) {
    const key = String(t.id);
    const stored = progress.tickets[key];
    if (!stored) {
      items.push({ id: t.id, changetime: t.changetime, reason: "new" });
    } else if (args.refreshAll) {
      items.push({ id: t.id, changetime: t.changetime, reason: "forced" });
    } else if (args.refreshChanged && t.changetime && t.changetime !== stored.changetime) {
      items.push({ id: t.id, changetime: t.changetime, reason: "changed" });
    }
  }
  return items;
}

async function scrapeOne(
  ctx: import("playwright").BrowserContext,
  id: number,
): Promise<{ testers: UserContribution[]; reproducers: UserContribution[] }> {
  const ticket = await parseTicket(ctx, id);
  const classifications = ticket.comments.map((c) => {
    const r = classifyComment({
      labels: c.labels,
      bodyText: c.bodyText,
      links: c.links,
      imageCount: c.imageCount,
    });
    return { num: c.num, author: c.author, category: r.category, reasons: r.reasons };
  });
  return {
    testers: aggregateContributions(classifications, "test", ticket.url),
    reproducers: aggregateContributions(classifications, "repro", ticket.url),
  };
}

async function main() {
  const args = parseArgs();
  const milestoneDir = join(OUTPUT_DIR, args.milestone);
  const progressPath = join(milestoneDir, "milestone-data.json");

  console.log(`Milestone: ${args.milestone}`);
  if (args.refreshAll) console.log("Mode: refresh-all (re-scrape everything)");
  else if (args.refreshChanged) console.log("Mode: refresh-changed (re-scrape changed tickets)");

  const progress = await readProgress(progressPath, args.milestone);
  const { browser, ctx } = await openBrowser();

  try {
    let list: TicketSummary[];
    if (args.only && args.only.length) {
      console.log(`Using --only override: ${args.only.length} ticket(s)`);
      list = args.only.map((id) => ({ id, changetime: "" }));
    } else {
      console.log("Listing fixed tickets…");
      list = await listFixedTickets(ctx, args.milestone);
      console.log(`Found ${list.length} fixed ticket(s) in milestone ${args.milestone}`);
    }

    const todo = planWork(args, list, progress);
    const breakdown = todo.reduce(
      (acc, w) => ((acc[w.reason] = (acc[w.reason] || 0) + 1), acc),
      {} as Record<string, number>,
    );
    console.log(
      `Already in progress: ${Object.keys(progress.tickets).length}. To process: ${todo.length}` +
        (todo.length ? ` (${Object.entries(breakdown).map(([k, v]) => `${k}=${v}`).join(", ")})` : ""),
    );

    for (let i = 0; i < todo.length; i++) {
      const w = todo[i]!;
      const tag = w.reason === "new" ? "" : ` [${w.reason}]`;
      process.stdout.write(`[${i + 1}/${todo.length}] #${w.id}${tag} … `);

      let result: Awaited<ReturnType<typeof scrapeOne>> | null = null;
      let attempt = 0;
      while (attempt < 2 && !result) {
        try {
          result = await scrapeOne(ctx, w.id);
        } catch (err) {
          attempt++;
          const msg = (err as Error).message;
          if (attempt < 2) {
            process.stdout.write(`error (retrying in ${RETRY_BACKOFF_MS / 1000}s: ${msg}) … `);
            await sleep(RETRY_BACKOFF_MS);
          } else {
            console.log(`ERROR after retry: ${msg}`);
          }
        }
      }

      if (result) {
        progress.tickets[String(w.id)] = {
          url: ticketUrl(w.id),
          testers: result.testers,
          reproducers: result.reproducers,
          changetime: w.changetime,
        };
        await persist(milestoneDir, progress, false);
        const parts: string[] = [];
        if (result.testers.length) parts.push(`testers: ${result.testers.map((u) => u.user).join(", ")}`);
        if (result.reproducers.length) parts.push(`reproducers: ${result.reproducers.map((u) => u.user).join(", ")}`);
        console.log(parts.length ? parts.join(" | ") : "—");
      }

      const isLast = i === todo.length - 1;
      if (!isLast) {
        if ((i + 1) % LONG_PAUSE_EVERY === 0) {
          process.stdout.write(`-- long pause ${LONG_PAUSE_MS / 1000}s --\n`);
          await sleep(LONG_PAUSE_MS);
        } else {
          await sleep(jitter(args.baseDelayMs));
        }
      }
    }

    // Persist ticket data once before enrichment so the file on disk is
    // consistent even if enrich is skipped or fails.
    await persist(milestoneDir, progress, !args.enrich);

    if (args.enrich) {
      console.log("\nEnriching contributors (cached users skipped, new users fetched)…");
      try {
        await enrichMilestone(args.milestone, { refreshNew: args.refreshNew });
      } catch (err) {
        console.error(`Enrich step failed: ${(err as Error).message}`);
      }
    }
    console.log("Done.");
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
