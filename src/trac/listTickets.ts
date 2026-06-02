import type { BrowserContext } from "playwright";
import { gotoTrac } from "./browser.js";

export type TicketSummary = {
  id: number;
  /** Opaque change-time tag from Trac. Used only for equality comparison. */
  changetime: string;
};

/**
 * List fixed tickets for a milestone, each with an opaque change-time tag.
 * We add &resolution=fixed so only resolution=fixed tickets are returned.
 * &col=changetime asks Trac to include the last-modified column.
 */
export async function listFixedTickets(
  ctx: BrowserContext,
  milestone: string,
): Promise<TicketSummary[]> {
  const page = await ctx.newPage();
  const url =
    `https://core.trac.wordpress.org/query?` +
    `status=closed&resolution=fixed&milestone=${encodeURIComponent(milestone)}` +
    `&max=0&col=id&col=changetime&order=id`;
  try {
    await gotoTrac(page, url);
    const rows = await page.evaluate(() => {
      const out: { id: number; changetime: string }[] = [];
      document.querySelectorAll("table.listing tbody tr").forEach((tr) => {
        const a = tr.querySelector("td.id a[href^='/ticket/'], td.id a, a[href^='/ticket/']");
        const href = a?.getAttribute("href") || "";
        const m = /^\/ticket\/(\d+)/.exec(href);
        if (!m) return;
        const id = parseInt(m[1]!, 10);
        const ct = tr.querySelector("td.changetime");
        // Trac renders <a class="timeline" title="..."> inside td.changetime.
        // The title is a human-readable timestamp; we use it as an opaque tag.
        const titleEl = ct?.querySelector("a[title], [title]");
        const titleAttr = titleEl?.getAttribute("title") || "";
        // Fallback: link href contains ?from=<iso>
        const hrefAttr = (ct?.querySelector("a") as HTMLAnchorElement | null)?.getAttribute("href") || "";
        const fromMatch = /[?&]from=([^&]+)/.exec(hrefAttr);
        const changetime = titleAttr || (fromMatch ? decodeURIComponent(fromMatch[1]!) : "");
        out.push({ id, changetime });
      });
      return out;
    });
    // Dedup (same ID could appear once per page group; resolution=fixed is single group)
    const seen = new Map<number, TicketSummary>();
    for (const r of rows) if (!seen.has(r.id)) seen.set(r.id, r);
    return [...seen.values()].sort((a, b) => a.id - b.id);
  } finally {
    await page.close();
  }
}

/**
 * Kept for the `list` CLI (multi-resolution inspection).
 */
export async function listMilestoneTickets(
  ctx: BrowserContext,
  milestone: string,
): Promise<number[]> {
  const tickets = await listFixedTickets(ctx, milestone);
  return tickets.map((t) => t.id);
}
