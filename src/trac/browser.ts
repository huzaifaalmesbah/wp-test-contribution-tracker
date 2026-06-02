import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export async function openBrowser(): Promise<{ browser: Browser; ctx: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 800 },
  });
  // tsx/esbuild compiles our page.evaluate callbacks with `keepNames: true`,
  // which injects __name(...) wrapper calls. Polyfill it in the page context.
  await ctx.addInitScript("window.__name = window.__name || function(fn){return fn;};");
  return { browser, ctx };
}

/**
 * Navigate to a Trac URL and wait past the JS challenge.
 * The challenge serves an HTML doc with title "Checking your browser..."
 * that POSTs to /__challenge then reloads. We wait until that's cleared
 * and the real ticket DOM is visible.
 */
export async function gotoTrac(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForFunction(
    () => {
      const title = document.title || "";
      if (title.toLowerCase().includes("checking your browser")) return false;
      return Boolean(document.querySelector("#content"));
    },
    { timeout: 45_000 },
  );
}
