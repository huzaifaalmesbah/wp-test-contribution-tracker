/**
 * Two persistent caches under data/, both committed to git:
 *
 *   data/test-contributors.json
 *     Users WITH the Test Contributor badge. Skipped on every enrich run —
 *     once you have the badge, you have it.
 *
 *   data/new-contributors.json
 *     Users seen contributing in some milestone but WITHOUT the badge yet.
 *     Skipped by default (the badge state is from the last check), but
 *     `npm run enrich -- --refresh-new` re-checks every user in this list
 *     in case they've earned the badge in the meantime — successful upgrades
 *     are moved from this file to test-contributors.json.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
const TEST_CONTRIBUTORS_PATH = join(DATA_DIR, "test-contributors.json");
const NEW_CONTRIBUTORS_PATH = join(DATA_DIR, "new-contributors.json");

export type RegistryUser = {
  location: string;
  country: string | null;
  memberSince: string;
};

export type Registry = {
  description: string;
  lastUpdated: string;
  users: Record<string, RegistryUser>;
};

const TEST_DESC =
  "WordPress.org users known to have the Test Contributor badge, with location and member-since data. Updated by `npm run enrich`.";
const NEW_DESC =
  "WordPress.org users seen contributing tests but without the Test Contributor badge at last check. Re-checkable via `npm run enrich -- --refresh-new`.";

async function load(path: string, description: string): Promise<Registry> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Registry;
    if (!parsed.users || typeof parsed.users !== "object" || Array.isArray(parsed.users)) {
      throw new Error("invalid shape");
    }
    return parsed;
  } catch {
    return { description, lastUpdated: new Date().toISOString(), users: {} };
  }
}

async function save(path: string, r: Registry): Promise<void> {
  const sortedKeys = Object.keys(r.users).sort();
  const sorted: Record<string, RegistryUser> = {};
  for (const k of sortedKeys) sorted[k] = r.users[k]!;
  const next: Registry = {
    description: r.description,
    lastUpdated: new Date().toISOString(),
    users: sorted,
  };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2), "utf8");
}

export const loadTestContributors = () => load(TEST_CONTRIBUTORS_PATH, TEST_DESC);
export const saveTestContributors = (r: Registry) => save(TEST_CONTRIBUTORS_PATH, r);
export const loadNewContributors = () => load(NEW_CONTRIBUTORS_PATH, NEW_DESC);
export const saveNewContributors = (r: Registry) => save(NEW_CONTRIBUTORS_PATH, r);
