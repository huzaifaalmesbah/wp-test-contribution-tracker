import { writeFile } from "node:fs/promises";
import { openBrowser, gotoTrac } from "./trac/browser.js";

function parseArgs(): { milestone: string; debug: boolean } {
  const args = process.argv.slice(2);
  let milestone = "";
  let debug = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--milestone" && args[i + 1]) milestone = args[++i]!;
    else if (args[i] === "--debug") debug = true;
  }
  if (!milestone) {
    console.error("Usage: npm run list -- --milestone 7.0 [--debug]");
    process.exit(1);
  }
  return { milestone, debug };
}

async function main() {
  const { milestone, debug } = parseArgs();
  const { browser, ctx } = await openBrowser();
  try {
    const page = await ctx.newPage();
    const url = `https://core.trac.wordpress.org/query?status=closed&group=resolution&milestone=${encodeURIComponent(
      milestone,
    )}&max=0&col=id&col=resolution`;
    await gotoTrac(page, url);

    if (debug) {
      const html = await page.content();
      await writeFile(".cache/query-debug.html", html, "utf8");
      console.error(`[debug] wrote .cache/query-debug.html (${html.length} bytes)`);
    }

    const groups = await page.evaluate(() => {
      // Walk the query result. Each group is introduced by an <h2> whose text
      // starts with the resolution word (e.g. "Fixed (123 matches)", or the
      // first-letter-uppercase variants Trac sometimes uses). The ticket rows
      // for that group are in the very next <table>. To be robust, accept any
      // h2 whose first alphanumeric token matches a known resolution.
      const out: Record<string, number[]> = {};
      const KNOWN = new Set(["fixed", "invalid", "duplicate", "wontfix", "worksforme"]);
      document.querySelectorAll("h2").forEach((h2) => {
        const txt = (h2.textContent || "").trim().toLowerCase();
        const m = /([a-z]+)/.exec(txt);
        if (!m) return;
        const resolution = m[1]!;
        if (!KNOWN.has(resolution)) return;
        let el: Element | null = h2.nextElementSibling;
        while (el && el.tagName !== "TABLE") el = el.nextElementSibling;
        if (!el) return;
        const ids: number[] = [];
        el.querySelectorAll("a[href^='/ticket/']").forEach((a) => {
          const href = a.getAttribute("href") || "";
          const mm = /^\/ticket\/(\d+)$/.exec(href);
          if (mm) ids.push(parseInt(mm[1]!, 10));
        });
        out[resolution] = Array.from(new Set(ids)).sort((a, b) => a - b);
      });

      // Fallback: if no h2-based groups were found, group by row class/text.
      if (Object.keys(out).length === 0) {
        const all = new Set<number>();
        document.querySelectorAll("table.listing tbody tr").forEach((tr) => {
          const link = tr.querySelector("a[href^='/ticket/']");
          const href = link?.getAttribute("href") || "";
          const m = /^\/ticket\/(\d+)$/.exec(href);
          if (!m) return;
          const id = parseInt(m[1]!, 10);
          all.add(id);
          // resolution column may carry it
          const res = (tr.querySelector("td.resolution")?.textContent || "").trim().toLowerCase();
          const key = res || "unknown";
          if (!out[key]) out[key] = [];
          out[key].push(id);
        });
        for (const k of Object.keys(out)) out[k] = Array.from(new Set(out[k]!)).sort((a, b) => a - b);
      }
      return out;
    });

    await page.close();

    const total = Object.values(groups).reduce((s, arr) => s + arr.length, 0);
    console.log(`Milestone ${milestone}: ${total} closed ticket(s)\n`);
    for (const [res, ids] of Object.entries(groups).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${res.padEnd(12)} ${String(ids.length).padStart(4)} ticket(s)`);
    }
    console.log("");
    const fixed = groups["fixed"] ?? [];
    console.log(`Fixed tickets (${fixed.length}):`);
    console.log(fixed.join(", "));
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
