/**
 * Iterative-validation batch scraper.
 *
 *   npm run batch -- --milestone 7.0 --start 0 --count 20
 *
 * - Scrapes a slice of fixed tickets through Playwright.
 * - For each ticket, caches under .cache/per-ticket/<id>/:
 *     page.html      — full rendered ticket HTML
 *     parsed.json    — parsed comments (labels, body, links, images)
 *     classification.json — detector output (with reasons per comment)
 * - Updates output/<milestone>/milestone-data.json + leaderboard outputs.
 *
 * Use `npm run reclassify` for an audit MD; per-batch summaries used to live
 * at .cache/batches/<milestone>-batch-N-M.md but were dropped (rewriteable
 * from parsed.json + classification.json with jq).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserContext } from "playwright";
import { gotoTrac, openBrowser } from "./trac/browser.js";
import { listFixedTickets, type TicketSummary } from "./trac/listTickets.js";
import { parseTicket, type ParsedTicket } from "./trac/ticket.js";
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

const ROOT = process.cwd();
const CACHE_DIR = join(ROOT, ".cache", "per-ticket");
const OUTPUT_DIR = join(ROOT, "output");
const REQUEST_DELAY_MS = 1500;

type Args = { milestone: string; start: number; count: number; only?: number[] };

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let milestone = "";
  let start = 0;
  let count = 20;
  let only: number[] | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--milestone" && args[i + 1]) milestone = args[++i]!;
    else if (a === "--start" && args[i + 1]) start = parseInt(args[++i]!, 10);
    else if (a === "--count" && args[i + 1]) count = parseInt(args[++i]!, 10);
    else if (a === "--only" && args[i + 1]) only = args[++i]!.split(",").map((x) => parseInt(x, 10));
  }
  if (!milestone) {
    console.error("Usage: npm run batch -- --milestone 7.0 --start 0 --count 20 [--only 61302,61393]");
    process.exit(1);
  }
  return { milestone, start, count, only };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function savePageHtml(ctx: BrowserContext, id: number, dir: string): Promise<void> {
  const page = await ctx.newPage();
  try {
    await gotoTrac(page, `https://core.trac.wordpress.org/ticket/${id}`);
    const html = await page.content();
    await writeFile(join(dir, "page.html"), html, "utf8");
  } finally {
    await page.close();
  }
}

async function cacheTicket(ctx: BrowserContext, id: number) {
  const dir = join(CACHE_DIR, String(id));
  await mkdir(dir, { recursive: true });

  await savePageHtml(ctx, id, dir);

  const t = await parseTicket(ctx, id);
  await writeFile(join(dir, "parsed.json"), JSON.stringify(t, null, 2), "utf8");

  const classifications: Array<{ num: string; author: string; category: string; reasons: string[] }> = [];
  for (const c of t.comments) {
    const r = classifyComment({ labels: c.labels, bodyText: c.bodyText, links: c.links, imageCount: c.imageCount });
    classifications.push({ num: c.num, author: c.author, category: r.category, reasons: r.reasons });
  }

  const testers = aggregateContributions(classifications, "test", t.url);
  const reproducers = aggregateContributions(classifications, "repro", t.url);

  await writeFile(
    join(dir, "classification.json"),
    JSON.stringify(
      {
        id: t.id,
        url: t.url,
        commentCount: t.comments.length,
        testers,
        reproducers,
        comments: classifications,
      },
      null,
      2,
    ),
    "utf8",
  );

  return { ticket: t, classifications, testers, reproducers };
}

async function main() {
  const args = parseArgs();
  const milestoneDir = join(OUTPUT_DIR, args.milestone);
  const progressPath = join(milestoneDir, "milestone-data.json");
  const progress = await readProgress(progressPath, args.milestone);
  await mkdir(CACHE_DIR, { recursive: true });

  const { browser, ctx } = await openBrowser();
  try {
    console.log(`Listing fixed tickets for ${args.milestone}…`);
    const list = await listFixedTickets(ctx, args.milestone);
    console.log(`Total fixed tickets: ${list.length}`);

    let slice: TicketSummary[];
    if (args.only && args.only.length) {
      const lookup = new Map(list.map((t) => [t.id, t.changetime]));
      slice = args.only.map((id) => ({ id, changetime: lookup.get(id) || "" }));
      console.log(`Using --only override: ${slice.length} ticket(s)`);
    } else {
      slice = list.slice(args.start, args.start + args.count);
      console.log(`Batch slice: ${slice.length} ticket(s) (${args.start + 1}..${args.start + slice.length})`);
    }

    for (let i = 0; i < slice.length; i++) {
      const s = slice[i]!;
      process.stdout.write(`[${i + 1}/${slice.length}] #${s.id} … `);
      try {
        const r = await cacheTicket(ctx, s.id);
        progress.tickets[String(s.id)] = {
          url: ticketUrl(s.id),
          testers: r.testers,
          reproducers: r.reproducers,
          changetime: s.changetime,
        };
        await writeProgress(progressPath, progress);
        await writeOutputs(
          milestoneDir,
          args.milestone,
          allLeaderboardFiles(progress),
          Object.keys(progress.tickets).length,
          false,
        );
        const parts: string[] = [];
        if (r.testers.length) parts.push(`testers: ${r.testers.map((u: UserContribution) => u.user).join(", ")}`);
        if (r.reproducers.length) parts.push(`reproducers: ${r.reproducers.map((u: UserContribution) => u.user).join(", ")}`);
        console.log(parts.length ? parts.join(" | ") : "—");
      } catch (err) {
        console.log(`ERROR: ${(err as Error).message}`);
      }
      if (i < slice.length - 1) await sleep(REQUEST_DELAY_MS + Math.floor(Math.random() * 1500));
    }
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
