import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { qualityFromReasons, type Quality } from "../extract/classify.js";

/** A user who contributed a test or reproduction on a ticket, with the
 *  union of classifier reasons across their classified comments and the
 *  comment URLs for quick verification. */
export type UserContribution = {
  user: string;
  /** Highest tier across this user's qualifying comments on the ticket.
   *  high: full template (Reproduction/Patch Testing Report headings or 3+
   *  structural sections). medium: Before/After + image, tested-patch link,
   *  playground evidence, or 2 structural labels + patch signal. low:
   *  narrative-only ("I tested", "I can reproduce"). */
  quality: Quality;
  reasons: string[];
  /** Direct links to each comment by this user that contributed. */
  comments: string[];
  /** Optional, populated by `npm run enrich`. True when the user has no
   *  Test Contributor badge on their wordpress.org profile. */
  newContributor?: boolean;
  /** Optional, populated by `npm run enrich`. Country parsed from the user's
   *  wordpress.org profile location, or null if not resolvable. */
  country?: string | null;
  /** Optional, populated by `npm run enrich`. Raw "Member Since" string from
   *  the user's wordpress.org profile. */
  memberSince?: string;
};

export type TicketEntry = {
  /** Full Trac URL — kept for easy click-through verification. */
  url: string;
  testers: UserContribution[];
  reproducers: UserContribution[];
  /** Opaque change-time tag captured at scrape time. Compared as string. */
  changetime: string;
};

export type ProgressFile = {
  schemaVersion: 1;
  milestone: string;
  tickets: Record<string, TicketEntry>;
};

const empty = (milestone: string): ProgressFile => ({
  schemaVersion: 1,
  milestone,
  tickets: {},
});

export async function readProgress(path: string, milestone: string): Promise<ProgressFile> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as ProgressFile;
    if (parsed.schemaVersion !== 1 || parsed.milestone !== milestone) return empty(milestone);
    if (!parsed.tickets || typeof parsed.tickets !== "object") return empty(milestone);
    return parsed;
  } catch {
    return empty(milestone);
  }
}

export async function writeProgress(path: string, data: ProgressFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

export function scannedTicketIds(progress: ProgressFile): Set<number> {
  const ids = new Set<number>();
  for (const k of Object.keys(progress.tickets)) {
    const n = parseInt(k, 10);
    if (!isNaN(n)) ids.add(n);
  }
  return ids;
}

export function ticketUrl(id: number | string): string {
  return `https://core.trac.wordpress.org/ticket/${id}`;
}

type CountField = "testers" | "reproducers";

export type LeaderboardRow = {
  username: string;
  count: number;
  quality?: Quality;
  newContributor?: boolean;
  country?: string | null;
  memberSince?: string;
};

/** Walk all tickets and build a leaderboard for a category. The same user
 *  across multiple tickets aggregates into one row; quality is the max tier
 *  across the user's contributions; newContributor / country / memberSince
 *  are user-level properties consistent across the user's tickets. */
type UserAgg = {
  count: number;
  quality: Quality;
  newContributor?: boolean;
  country?: string | null;
  memberSince?: string;
};

const QUALITY_RANK: Record<Quality, number> = { low: 0, medium: 1, high: 2 };
const maxQuality = (a: Quality, b: Quality): Quality => (QUALITY_RANK[a] >= QUALITY_RANK[b] ? a : b);

function recordObservation(byUser: Map<string, UserAgg>, c: UserContribution): void {
  const existing = byUser.get(c.user);
  if (existing) {
    existing.count++;
    existing.quality = maxQuality(existing.quality, c.quality);
  } else {
    byUser.set(c.user, {
      count: 1,
      quality: c.quality,
      newContributor: c.newContributor,
      country: c.country,
      memberSince: c.memberSince,
    });
  }
}

function aggMapToRows(byUser: Map<string, UserAgg>): LeaderboardRow[] {
  return [...byUser.entries()].map(([username, d]) => ({
    username,
    count: d.count,
    quality: d.quality,
    newContributor: d.newContributor,
    country: d.country,
    memberSince: d.memberSince,
  }));
}

/** One category (testers OR reproducers), all tiers, with max quality per user. */
function buildLeaderboard(progress: ProgressFile, field: CountField): LeaderboardRow[] {
  const byUser = new Map<string, UserAgg>();
  for (const entry of Object.values(progress.tickets)) {
    for (const c of entry[field]) recordObservation(byUser, c);
  }
  return aggMapToRows(byUser);
}

/** Both categories combined (testers + reproducers). */
function buildCombinedLeaderboard(progress: ProgressFile): LeaderboardRow[] {
  const byUser = new Map<string, UserAgg>();
  for (const entry of Object.values(progress.tickets)) {
    for (const c of [...entry.testers, ...entry.reproducers]) {
      recordObservation(byUser, c);
    }
  }
  return aggMapToRows(byUser);
}

/** Aggregate per-user contributions for one category. Each user gets the union
 * of reasons across their classified comments and the direct URLs to their
 * qualifying comments. User-level quality is derived from the union of reasons
 * — which is equivalent to taking the max tier across the user's comments,
 * since the per-comment quality is itself a function of the comment's reasons. */
export function aggregateContributions(
  perComment: Array<{ num: string; author: string; category: string; reasons: string[] }>,
  category: "test" | "repro",
  ticketHref: string,
): UserContribution[] {
  type Bucket = { reasons: Set<string>; commentNums: string[] };
  const byUser = new Map<string, Bucket>();
  for (const c of perComment) {
    if (c.category !== category) continue;
    if (!byUser.has(c.author)) byUser.set(c.author, { reasons: new Set(), commentNums: [] });
    const b = byUser.get(c.author)!;
    for (const r of c.reasons) b.reasons.add(r);
    b.commentNums.push(c.num);
  }
  return [...byUser.entries()]
    .map(([user, b]): UserContribution => {
      const reasons = [...b.reasons].sort();
      const quality = qualityFromReasons(reasons);
      const comments = b.commentNums
        .sort((a, b2) => parseInt(a, 10) - parseInt(b2, 10))
        .map((n) => `${ticketHref}#comment:${n}`);
      return { user, quality, reasons, comments };
    })
    .sort((a, b) => a.user.localeCompare(b.user));
}

export function computeCounts(progress: ProgressFile, field: CountField): LeaderboardRow[] {
  return buildLeaderboard(progress, field);
}

/** Combined (testers + reproducers) for one progress file. */
export function computeCombinedCounts(progress: ProgressFile): LeaderboardRow[] {
  return buildCombinedLeaderboard(progress);
}

/** Combined contributions filtered by badge status (requires `npm run enrich`).
 *  withBadge=true  → users with newContributor === false (Test Contributor badge holders)
 *  withBadge=false → users with newContributor === true  (no badge yet)
 *  Contributions where newContributor is undefined (un-enriched) are excluded
 *  from both. */
function buildByBadgeStatus(progress: ProgressFile, withBadge: boolean): LeaderboardRow[] {
  const byUser = new Map<string, UserAgg>();
  for (const entry of Object.values(progress.tickets)) {
    for (const c of [...entry.testers, ...entry.reproducers]) {
      const isNew = c.newContributor === true;
      const hasBadge = c.newContributor === false;
      if (withBadge && !hasBadge) continue;
      if (!withBadge && !isNew) continue;
      recordObservation(byUser, c);
    }
  }
  return aggMapToRows(byUser);
}

export function computeTestContributorCounts(progress: ProgressFile): LeaderboardRow[] {
  return buildByBadgeStatus(progress, true);
}
export function computeNewContributorCounts(progress: ProgressFile): LeaderboardRow[] {
  return buildByBadgeStatus(progress, false);
}
