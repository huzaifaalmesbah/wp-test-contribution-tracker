/**
 * Resolve a country from any free-form location string by geocoding it with
 * OpenStreetMap's Nominatim API. Results (including null for unrecognised
 * locations) are cached at data/geocode-cache.json so each location is
 * queried only once across runs and machines.
 *
 * Respects Nominatim's 1 req/sec usage policy and identifies via User-Agent.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const CACHE_PATH = join(process.cwd(), "data", "geocode-cache.json");
const NOMINATIM_MIN_INTERVAL_MS = 1100; // > 1 req/sec
const USER_AGENT = "wp-test-contribution-tracker/0.1 (+https://github.com/)";

/** Canonicalise Nominatim's country names to the shorter forms we use. */
const COUNTRY_ALIASES: Record<string, string> = {
  "United States of America": "United States",
  "Russian Federation": "Russia",
  "Republic of Korea": "South Korea",
  "Democratic People's Republic of Korea": "North Korea",
  Czechia: "Czech Republic",
  Myanmar: "Myanmar",
  Eswatini: "Eswatini",
};

type GeocodeCache = Record<string, string | null>;

let cachePromise: Promise<GeocodeCache> | null = null;
let lastCallTs = 0;

async function loadCache(): Promise<GeocodeCache> {
  if (cachePromise) return cachePromise;
  cachePromise = (async () => {
    try {
      const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8"));
      return typeof parsed === "object" && parsed !== null ? (parsed as GeocodeCache) : {};
    } catch {
      return {};
    }
  })();
  return cachePromise;
}

async function persistCache(cache: GeocodeCache): Promise<void> {
  const sorted: GeocodeCache = {};
  for (const k of Object.keys(cache).sort()) sorted[k] = cache[k]!;
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(sorted, null, 2), "utf8");
}

async function rateLimit() {
  const elapsed = Date.now() - lastCallTs;
  if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, NOMINATIM_MIN_INTERVAL_MS - elapsed));
  }
  lastCallTs = Date.now();
}

async function nominatim(location: string): Promise<string | null> {
  await rateLimit();
  const url =
    `https://nominatim.openstreetmap.org/search?` +
    `q=${encodeURIComponent(location)}&format=json&limit=1&addressdetails=1`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, "Accept-Language": "en" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ address?: { country?: string } }>;
    const raw = Array.isArray(data) && data[0]?.address?.country;
    if (typeof raw !== "string" || !raw) return null;
    return COUNTRY_ALIASES[raw] ?? raw;
  } catch {
    return null;
  }
}

/**
 * Resolve a country from a free-form location. Cache-then-network:
 *   - Empty / whitespace → null without touching the network
 *   - Cache hit → return cached result (null is also a valid cached value)
 *   - Else → one Nominatim call, cache the result
 */
export async function resolveCountry(location: string | undefined | null): Promise<string | null> {
  if (!location || !location.trim()) return null;
  const key = location.trim();
  const cache = await loadCache();
  if (key in cache) return cache[key] ?? null;

  const found = await nominatim(key);
  cache[key] = found;
  await persistCache(cache);
  return found;
}
