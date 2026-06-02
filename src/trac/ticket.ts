import type { BrowserContext } from "playwright";
import { gotoTrac } from "./browser.js";
import { collectLabelsBrowserFn } from "../extract/labels.js";

export type ParsedComment = {
  num: string;
  author: string;
  bodyText: string;
  links: string[];
  imageCount: number;
  labels: {
    headings: string[];
    paragraphLabels: string[];
    tableHeaders: string[];
    tableFirstCol: string[];
    normalized: string[];
  };
};

export type ParsedTicket = {
  id: number;
  url: string;
  comments: ParsedComment[];
};

/**
 * Load a Trac ticket page and extract one entry per comment.
 * Filters out gravatar/avatar images so imageCount reflects real screenshots.
 */
export async function parseTicket(ctx: BrowserContext, id: number): Promise<ParsedTicket> {
  const page = await ctx.newPage();
  const url = `https://core.trac.wordpress.org/ticket/${id}`;
  try {
    await gotoTrac(page, url);

    const comments = await page.evaluate(
      ({ labelsFnStr }: { labelsFnStr: string }) => {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        const collectLabels = new Function(`${labelsFnStr}\nreturn collectLabels;`)() as (
          root: Element,
        ) => {
          headings: string[];
          paragraphLabels: string[];
          tableHeaders: string[];
          tableFirstCol: string[];
          normalized: string[];
        };

        const isAvatar = (src: string): boolean => {
          if (!src) return true;
          if (src.includes("grav-redirect.php")) return true;
          if (src.includes("gravatar.com")) return true;
          if (/[?&]s=\d{1,3}\b/.test(src) && src.includes("wordpress.org")) return true;
          return false;
        };

        const out: Array<{
          num: string;
          author: string;
          bodyText: string;
          links: string[];
          imageCount: number;
          labels: ReturnType<typeof collectLabels>;
        }> = [];

        document.querySelectorAll("div.change[id^='trac-change-']").forEach((change) => {
          const cnumEl = change.querySelector("span.cnum a");
          const num = (cnumEl?.textContent || "").trim().replace(/^#/, "");

          // Author extraction. Normal comments use .trac-author. GitHub-mirror
          // comments (h3.change.prbot) come from prbot and contain content
          // (e.g. the PR description with Before/After tables) authored by a
          // real user — attribute to that user via the first profile link in
          // the header.
          const h3 = change.querySelector("h3.change") as HTMLElement | null;
          const isPrBot = !!h3 && h3.classList.contains("prbot");
          let author = "";
          if (isPrBot && h3) {
            const profileLink = h3.querySelector<HTMLAnchorElement>(
              ".username-line a.ext-link[href*='profiles.wordpress.org/']",
            );
            if (profileLink) {
              const href = profileLink.getAttribute("href") || "";
              const match = /\/profiles\.wordpress\.org\/([^/"]+)/.exec(href);
              if (match) author = match[1]!;
            }
          } else {
            const authorEl = change.querySelector(".username-line .trac-author");
            author = (authorEl?.textContent || "").trim();
          }

          const body = change.querySelector("div.comment.searchable") as HTMLElement | null;
          if (!body) return;

          // Clone the body and strip <blockquote> elements. Trac wraps quoted
          // text from previous comments in <blockquote class="citation"> when a
          // user uses "Replying to <user>:". Including that quoted text in the
          // body would attribute the original author's testing claims to the
          // replier (false positives).
          const bodyForAnalysis = body.cloneNode(true) as HTMLElement;
          bodyForAnalysis.querySelectorAll("blockquote").forEach((bq) => bq.remove());

          const bodyText = (bodyForAnalysis.textContent || "").trim();
          const links: string[] = [];
          bodyForAnalysis.querySelectorAll("a[href]").forEach((a) => {
            const href = a.getAttribute("href");
            if (href) links.push(href);
          });

          let imageCount = 0;
          bodyForAnalysis.querySelectorAll("img").forEach((img) => {
            const src = img.getAttribute("src") || "";
            if (!isAvatar(src)) imageCount++;
          });

          const labels = collectLabels(bodyForAnalysis);

          if (author) {
            out.push({ num, author, bodyText, links, imageCount, labels });
          }
        });

        return out;
      },
      { labelsFnStr: collectLabelsBrowserFn },
    );

    return { id, url, comments };
  } finally {
    await page.close();
  }
}
