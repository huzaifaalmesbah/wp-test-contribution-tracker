/**
 * Fetch a WordPress.org user profile and extract:
 *   - whether they have the Test Contributor badge
 *   - their stated location
 *   - their Member Since string
 *
 * The profile page is plain HTML (no JS challenge); plain fetch works.
 */
import { resolveCountry } from "./geocode.js";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const TEST_CONTRIBUTOR_CLASS = /\bbadge-test-contributor\b/i;

export type UserProfile = {
  hasTestContributorBadge: boolean;
  /** Raw location string from the profile (may be empty). */
  location: string;
  /** Country parsed from the location; null when not recognised. */
  country: string | null;
  /** Raw "Member Since" string from the profile (may be empty). */
  memberSince: string;
};

function extractStrong(html: string, liId: string): string {
  const re = new RegExp(`<li[^>]*id=["']${liId}["'][^>]*>[\\s\\S]*?<strong>([\\s\\S]*?)</strong>`, "i");
  const m = html.match(re);
  if (!m) return "";
  return m[1]!
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Location moved from `<li id="user-location"><strong>X</strong></li>` to a
 *  bare `<span class="wp-p2-loc">X</span>` in the redesigned profile header. */
function extractLocation(html: string): string {
  const m = html.match(/<span[^>]*class=["'][^"']*\bwp-p2-loc\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);
  if (!m) return "";
  return m[1]!
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchUserProfile(user: string): Promise<UserProfile> {
  const res = await fetch(`https://profiles.wordpress.org/${encodeURIComponent(user)}/`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for @${user}`);
  const html = await res.text();
  const location = extractLocation(html);
  return {
    hasTestContributorBadge: TEST_CONTRIBUTOR_CLASS.test(html),
    location,
    country: await resolveCountry(location),
    memberSince: extractStrong(html, "user-member-since"),
  };
}
