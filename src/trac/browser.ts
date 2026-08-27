import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export async function openBrowser(): Promise<{ browser: Browser; ctx: BrowserContext }> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
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
  await page.waitForSelector("#content", { timeout: 60_000 });
}
