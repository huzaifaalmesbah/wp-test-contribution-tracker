import type { CommentLabels } from "./labels.js";

export type CommentFeatures = {
  labels: CommentLabels;
  bodyText: string;
  links: string[];
  imageCount: number;
};

export type Category = "repro" | "test" | "none";
export type Quality = "high" | "medium" | "low";
export type Classification = { category: Category; quality?: Quality; reasons: string[] };

/** Strip zero-width and similar invisibles Trac inserts before external-link icons. */
function normalizeText(s: string): string {
  return s.replace(/[​‌‍﻿⁠]/g, " ");
}

// -- Patterns --------------------------------------------------------------

const PATCH_TEST_HEADING = /(patch\s*)?test(ing)?\s*report/i;
const REPRODUCTION_HEADING = /reproduction\s*report/i;
const REPRODUCE_INSTRUCTIONS_HEADING = /reproduc(?:e|tion)\s+instructions?/i;
const TESTED_PATCH_PHRASE =
  /test(?:ed|ing)?\s+(?:\S+\s+){0,3}(?:patch|pr|diff|fix|pull\s*request)\b|(?:patch|pr|diff|fix)\s+tested|i'?ve\s+tested|i\s+have\s+tested/i;
const PR_LINK = /github\.com\/WordPress\/wordpress-develop\/(pull|compare)\//i;
const PATCH_ATTACHMENT_LINK = /\/(?:raw-)?attachment\/ticket\/\d+\/[^"'\s]+\.(?:diff|patch)/i;
const PLAYGROUND_LINK = /playground\.wordpress\.net\//i;
/** Links to common screenshot/image hosts — used as image evidence when the
 * comment has the URL as a plain link rather than an embedded <img>. */
const IMAGE_HOST_LINK =
  /\b(?:i\.ibb\.co|ibb\.co|i\.imgur\.com|imgur\.com|postimg\.cc|i\.postimg\.cc|prnt\.sc|files\.catbox\.moe|catbox\.moe|kommodo\.ai|github\.com\/user-attachments|cloudup\.com|share\.cleanshot\.com|cleanshot\.com)\b/i;
/** Image file extensions referenced in body text — catches uploaded screenshots
 *  whether they resolved into an <img>, came in as a plain link, or got stuck
 *  mid-upload ("[Uploading screen.png…]()"). */
const IMAGE_FILE_MENTION = /\.(?:png|jpe?g|webp|gif|svg|bmp|heic|tiff?|avif)\b/i;
/** Screencast/video evidence. Catches uploaded video files (the filename
 *  survives even when GitHub's "[Uploading X.webm…]()" placeholder didn't
 *  resolve into a real link) and external screencast hosts. */
const VIDEO_FILE_MENTION = /\.(?:webm|mp4|mov|m4v|ogv)\b/i;
const VIDEO_HOST_LINK = /\b(?:loom\.com|youtube\.com\/watch|youtu\.be|vimeo\.com)\b/i;
// "Before" / "Before Patch" / "Before applying the patch:-" / "Before:-" — up
// to 3 patch-related words after the keyword, followed by any punctuation/whitespace.
const BEFORE_LABEL = /^before(?:\s+\S+){0,3}[\s:.\-=]*$/i;
const AFTER_LABEL = /^after(?:\s+\S+){0,3}[\s:.\-=]*$/i;
const EXPECTED_BEHAVIOR_LABEL = /^expected\s+behaviou?r[:\s]*$/i;
const EXPECTED_RESULT_LABEL = /^expected(\s+result[s]?)?[:\s]*$/i;
const BUG_EMOJI_OR_PHRASE = /🐞|bug\s+occur|bug\s+is\s+not\s+occurring/i;
/**
 * Hypothetical / question forms of "I can reproduce". Used to suppress
 * narrative_repro_strong on phrases like "I'm unsure how I can reproduce this",
 * "How can I reproduce it?", and request forms like "so I can reproduce your
 * setup?".
 */
const REPRO_HYPOTHETICAL_GUARD =
  /\b(?:how|unsure|not\s+sure|don'?t\s+know|tell\s+me|wondering|asking|so\s+(?:that\s+)?i\s+can|in\s+order\s+to|need(?:ed)?\s+to|trying\s+to|want\s+to|help\s+me)\s+(?:\S+\s+){0,4}(?:i\s+can|to)\s+reproduce\b|\bable\s+to\s+reproduce\b[^.?!\n]*\?\s*$/im;
/**
 * Maintainer-style request asking *another* person to test/reproduce/check.
 * Suppresses narrative_test/repro matches in short "can you test this?"
 * comments where the commenter isn't the tester.
 */
const TEST_REPRO_REQUEST_GUARD =
  /\b(?:can|could|would|will|please)\s+(?:you|someone|anyone|@\w+)\b[^.?!]*\b(?:test|reproduce|check|confirm|verify|share|provide)\b/i;
/**
 * Committer close-out: "Merged in r62290", "In 62290:", "[62290]", "committed
 * in r62290". Used to suppress narrative_test matches on standard ticket-close
 * messages from the committer ("Thanks for the PR! Merged in r62290.").
 */
const COMMITTER_MERGE_PHRASE =
  /\b(?:merged|committed|landed|fixed)\s+in\s+(?:r?\d{4,7}|\[\d{4,7}\])|\bIn\s+\d{4,7}:|^\s*\[\d{4,7}\]\s|\bcommit(?:ted)?\s+in\s+(?:r?\d{4,7}|\[\d{4,7}\])/im;
/**
 * Patch-author self-description: the PR author cross-posts their PR body on
 * the ticket. Detected via the GitHub PR markdown headers (## Summary,
 * ## Testing, ## Test plan, ## Trac ticket). The "This patch fixes…" pattern
 * is deliberately NOT included here — it fires on legitimate testers who
 * describe what the patch does in their report. Such comments are already
 * handled by the WEAK-pattern + PATCH_CONTEXT_PHRASE gate.
 */
const PATCH_AUTHOR_SELF_GUARD =
  /^\s*#{1,3}\s*(?:summary|testing|test\s+plan|trac\s+ticket)\b/im;
/**
 * Code-review suggestion without test execution: "but I'd rather…", "I would
 * prefer…", "would be a good idea…", "love to see…". Reviewers proposing
 * improvements rather than reporting test results.
 */
const CODE_REVIEW_SUGGESTION_GUARD =
  /\b(?:but\s+(?:i'd|i\s+would)|i'd\s+rather|i\s+would\s+(?:prefer|rather)|i\s+(?:would\s+)?suggest|i\s+recommend|would\s+be\s+(?:a\s+)?good\s+idea|love\s+to\s+see)\b/i;
/**
 * Comment quotes an AI assistant's review/analysis ("Gemini 3 review:",
 * "Claude analysis", "GPT-4 said"). The AI is not a tester.
 */
const AI_REVIEW_QUOTE_GUARD =
  /\b(?:gemini|claude|chatgpt|gpt-?\d+|copilot)\s+(?:\d+\s+)?(?:review|analysis|said|response|verdict|opinion|suggests?|recommends?)\b/i;
const PATCH_CONTEXT_PHRASE =
  /\b(?:patch|pr|diff|pull[\s-]?request)\s+(?:\d|tested|applied|works|fixed|resolves|is)|tested?\s+(?:\S+\s+){0,2}(?:patch|pr|diff)|with\s+(?:the\s+)?patch|without\s+(?:the\s+)?patch|after\s+appl(?:y(?:ing)?|ied)\s+(?:\S+\s+){0,2}(?:patch|pr|fix|diff)/i;

const NARRATIVE_TEST_STRONG = [
  // First-person variants. "re-?" prefix accepted ("I re-tested the patch").
  /\b(?:i|we)\s+(?:also\s+|already\s+)?(?:re-?)?test(?:ed|ing)\s+(?:the\s+|your\s+|a\s+|this\s+|recent\s+|the\s+latest\s+)?(?:patch|pr\s*\d|diff|pull\s*request|fix)\b/i,
  // Bare "Tested patch from PR" — common opener for narrative test reports.
  // Past tense only ("Tested" / "Re-tested"). Present participle "Testing the
  // patch" is usually instructional/heading-style and excluded.
  // Negative lookbehind blocks past-participle adjective uses ("with a tested
  // patch", "the tested patch", "of the tested patch").
  /(?<!\b(?:the|a|an|this|that|with|of|some)\s+)\b(?:re-?)?tested\s+(?:the\s+|your\s+|a\s+|this\s+|recent\s+|the\s+latest\s+)?(?:patch|pr\s*\d|diff|pull\s*request|fix)\b/i,
  /\bpatch\s+(?:applied|tested)\b/i,
  /\bpatch\s+(?:is\s+)?(?:working|works)\s+(?:fine|properly|correctly|as\s+expected|well)\b/i,
  /\bi\s+can\s+confirm\s+(?:that\s+)?(?:[\w.\-]+\.(?:diff|patch)\b|the\s+(?:patch|fix)|the\s+diff|patch|diff|pr|fix)\b/i,
];
/**
 * Subset of NARRATIVE_TEST_MEDIUM that doesn't anchor on a patch noun.
 * "fixes the issue", "no issues here", "everything is fine", etc. fire on
 * generic bug-investigation comments too — we require PATCH_CONTEXT_PHRASE
 * elsewhere in the body before counting these as test contributions.
 */
const NARRATIVE_TEST_MEDIUM_WEAK = [
  /\bno\s+(?:more\s+)?(?:issue|error|bug|problem)s?\s*(?:now|anymore|here|after)?\b/i,
  /\b(?:resolved|fixes|fixed|solved)\s+(?:the|this)\s+(?:issue|bug|problem)\b/i,
  /\b(?:everything|all)\s+(?:is|looks|are|seems\s+to\s+(?:be\s+)?)\s*(?:fine|ok|good|working|fixed)\b/i,
  /\bsuccessfully\s+(?:resolved|fixed|solved)\b/i,
];

const NARRATIVE_TEST_MEDIUM = [
  // "I tested <noun>" — bare "I tested" alone fires on bug-investigation comments
  // ("I tested this myself by generating UUIDs in a loop"). Require an object
  // (patch/pr/diff/fix/it/this/etc.) within ~6 tokens.
  /\bi'?ve\s+(?:also\s+|already\s+|just\s+)?tested\s+(?:\S+\s+){0,6}(?:patch|pr\b|diff|fix|changeset|changes|pull\s*request|it|this(?:\s+\S+){0,2})\b/i,
  /\bi\s+have\s+(?:also\s+|already\s+|just\s+)?tested\s+(?:\S+\s+){0,6}(?:patch|pr\b|diff|fix|changeset|changes|pull\s*request|it|this(?:\s+\S+){0,2})\b/i,
  /\bi\s+(?:also\s+|already\s+|just\s+)?tested\s+(?:\S+\s+){0,6}(?:patch|pr\b|diff|fix|changeset|changes|pull\s*request|it|this(?:\s+\S+){0,2})\b/i,
  /\bi'?m\s+(?:also\s+)?testing\b/i,
  /\bi\s+am\s+(?:also\s+)?testing\b/i,
  /\bi\s+(?:also\s+)?(?:try|tried)\s+(?:to\s+test|testing)\b/i,
  // "I checked/reviewed your PR/patch/diff" — moved from STRONG to MEDIUM.
  // Bare "I checked your PR" matches code reviews that aren't actual tests
  // (e.g., suggesting improvements). "saw" deliberately dropped — "I saw the
  // PR" usually means "I noticed a PR exists", not "I read/tested it".
  /\bi\s+(?:also\s+)?(?:reviewed|reviewing|checked|checking)\s+(?:your\s+|the\s+|a\s+|this\s+)?(?:patch|pr|diff)\b/i,
  // Subject-anchored phrases.
  /\b(?:patch|fix|it|this|everything|all)\s+(?:seems\s+to\s+(?:work|be\s+working)|works)\s+(?:as|like)\s+expected\b/i,
  /\b(?:everything|all)\s+(?:is|looks|are|seems\s+to\s+(?:be\s+)?)\s*(?:fine|ok|good|working|fixed)\b/i,
  /\bno\s+(?:more\s+)?(?:issue|error|bug|problem)s?\s*(?:now|anymore|here|after)?\b/i,
  /\b(?:resolved|fixes|fixed|solved)\s+(?:the|this)\s+(?:issue|bug|problem)\b/i,
  /\bafter\s+appl(?:y(?:ing)?|ied)\s+(?:\S+\s+){0,2}(?:patch|pr|fix|diff)\b/i,
  /\bwith\s+(?:the\s+)?(?:patch|fix)\s+(?:applied|it\s+works|its?\s+works|everything\s+works)\b/i,
  /\bsuccessfully\s+(?:resolved|fixed|solved)\b/i,
  /\bworks\s+(?:properly|correctly|fine)\s+with\s+(?:the\s+)?patch\b/i,
  // Removed: bare "thanks for the patch" — fires on maintainer process-advice
  // and committer close-out comments without any actual test signal. Reviewers
  // who actually tested still match via "I tested <noun>" / "looks good with
  // the patch" / before-after / visual-evidence rules.
  // "Looks good <diff>.diff" - explicit patch context only
  /\blooks?\s+(?:good|fine|ok|great)\s+[\w.\-]+\.(?:diff|patch)\b/i,
  // Removed: bare "looks good to me" — pure code-review approval without
  // test execution. Genuine cases are caught by narrative_test_with_visual
  // when there's a screenshot/screencast.
  /\blooks?\s+(?:good|fine|ok|great)\s+with\s+(?:the\s+)?(?:patch|fix|diff)\b/i,
];

const NARRATIVE_REPRO_STRONG = [
  /\bi'?ve\s+(?:been\s+able\s+to\s+|successfully\s+)?reproduce/i,
  /\bi\s+(?:have\s+|am\s+|was\s+|were\s+)?(?:been\s+)?able\s+to\s+reproduce\b/i,
  /\bi\s+can\s+reproduce\b/i,
  // Removed bare /\bable\s+to\s+reproduce\s+(it|this|the X)/ — matched question
  // forms like "Have you been able to reproduce it?" that aren't first-person claims.
  /\bi\s+can\s+confirm\s+(?:this|the)\s+(?:issue|bug|problem)\b/i,
  /\b(?:reproduced|reproducing)\s+(?:the|this)\s+(?:issue|bug|problem|error)/i,
  /\bi\s+(?:was\s+|am\s+)?unable\s+to\s+(?:reproduce|replicate)\b/i,
  /\bi\s+(?:was\s*n'?t|wasnt|am\s*not|amnot)\s+able\s+to\s+(?:reproduce|replicate)\b/i,
  /\bi\s+(?:cannot|can'?t|could\s*not|couldn'?t)\s+(?:reproduce|replicate)\b/i,
  /\bunable\s+to\s+(?:reproduce|replicate)\s+(?:the|this|it)\b/i,
];
const NARRATIVE_REPRO_MEDIUM = [
  /\bi\s+(?:also\s+|again\s+)?(?:face[d]?|encounter(?:ed)?|got|see|noticed|observed)\s+(?:the\s+(?:same\s+)?|this\s+(?:same\s+)?)?(?:issue|bug|problem)\b/i,
  /\bgot\s+(?:the\s+same|this)\s+(?:issue|bug|problem)\b/i,
  /\b(?:same|similar)\s+(?:issue|bug|problem)\s+here\b/i,
  // Tightened: bare "I check/verified/confirmed" fires on dev-discussion comments
  // (e.g. "I check every file", "I verified that the provided image..."). Require
  // it to be followed by an explicit repro context (this/this issue/the bug/etc)
  // or a specific WP version.
  /\bi\s+(?:again\s+|also\s+|just\s+)?(?:check(?:ed)?|verified|confirmed)\s+this(?:\s+(?:issue|bug|problem))?\b/i,
  /\bi\s+(?:again\s+|also\s+|just\s+)?(?:check(?:ed)?|verified|confirmed)\s+that\s+(?:this|it)\b/i,
  /\bi\s+(?:again\s+|also\s+|just\s+)?(?:check(?:ed)?|verified|confirmed)\s+the\s+(?:issue|bug|problem|behavior|behaviou?r|fix)\b/i,
  /\bi\s+(?:again\s+|also\s+|just\s+)?(?:check(?:ed)?|verified|confirmed)\s+(?:on|in|with)\s+(?:wp|wordpress)?\s*[\d.]+(?:-[a-z\d]+)*/i,
  /\bi\s+(?:again\s+|also\s+|just\s+)?(?:check(?:ed)?|verified|confirmed)\s+(?:wp|wordpress)?\s*[\d.]+(?:-[a-z\d]+)+/i,
  // "I tested this with WordPress 6.8" / "tested on WP 6.7" / "I tested in WP 7.0"
  // — bug-behaviour reproduction on a specific version (no patch context).
  /\btest(?:ed|ing)?\s+(?:\S+\s+){0,3}(?:on|with|in)\s+(?:the\s+)?(?:latest\s+)?(?:wordpress|wp)\s+(?:version\s+)?[\d.()a-z-]+/i,
];

const STRUCTURAL_LABEL_NORMS = new Set([
  "environment",
  "testenvironment",
  "stepstaken",
  "stepstotest",
  "stepstoreproduce",
  "reproductionsteps",
  "reproduceinstructions",
  "reproductioninstructions",
  "stepsperformed",
  "steps",
  "testingsteps",
  "expectedresult",
  "expectedresults",
  "expectedbehaviour",
  "expectedbehavior",
  "actualresult",
  "actualresults",
  "actualbehaviour",
  "actualbehavior",
  "observedresult",
  "observedresults",
  "result",
  "results",
  "additionalnotes",
  "supplementalartifacts",
  "supplementalartifact",
  "screenshots",
  "screenshot",
  "screencast",
  "screencastwithresults",
  "screenshotsscreencastwithresults",
  "supportcontent",
  "activeplugins",
]);

// -- Feature accessors ------------------------------------------------------

type Ctx = {
  c: CommentFeatures;
  text: string;
};

function labelPool(c: CommentFeatures): string[] {
  return [...c.labels.headings, ...c.labels.paragraphLabels, ...c.labels.tableHeaders, ...c.labels.tableFirstCol];
}
function headingOrParagraph(c: CommentFeatures): string[] {
  return [...c.labels.headings, ...c.labels.paragraphLabels];
}
function structuralLabelCount(c: CommentFeatures): number {
  const present = new Set<string>();
  for (const n of c.labels.normalized) if (STRUCTURAL_LABEL_NORMS.has(n)) present.add(n);
  return present.size;
}
const hasPatchTestHeading = (c: CommentFeatures) =>
  headingOrParagraph(c).some((h) => PATCH_TEST_HEADING.test(h) && !REPRODUCTION_HEADING.test(h));
const hasReproductionHeading = (c: CommentFeatures) =>
  headingOrParagraph(c).some((h) => REPRODUCTION_HEADING.test(h));
const hasReproduceInstructionsLabel = (c: CommentFeatures) =>
  headingOrParagraph(c).some((h) => REPRODUCE_INSTRUCTIONS_HEADING.test(h));
const hasExpectedBehavior = (c: CommentFeatures) =>
  labelPool(c).some((t) => EXPECTED_BEHAVIOR_LABEL.test(t.trim()));
const hasExpectedResult = (c: CommentFeatures) =>
  labelPool(c).some((t) => {
    const tt = t.trim();
    return EXPECTED_RESULT_LABEL.test(tt) && !EXPECTED_BEHAVIOR_LABEL.test(tt);
  });
const hasBefore = (c: CommentFeatures) => labelPool(c).some((t) => BEFORE_LABEL.test(t.trim()));
const hasAfter = (c: CommentFeatures) => labelPool(c).some((t) => AFTER_LABEL.test(t.trim()));
const hasTestedPatchPhrase = (text: string) => TESTED_PATCH_PHRASE.test(text);
const hasPRLink = (c: CommentFeatures) => c.links.some((l) => PR_LINK.test(l));
const hasPatchAttachmentLink = (c: CommentFeatures) => c.links.some((l) => PATCH_ATTACHMENT_LINK.test(l));
const hasPlaygroundLink = (c: CommentFeatures) => c.links.some((l) => PLAYGROUND_LINK.test(l));
const hasImageHostLink = (c: CommentFeatures) => c.links.some((l) => IMAGE_HOST_LINK.test(l));
const hasImageEvidence = (c: CommentFeatures, text: string) =>
  c.imageCount >= 1 || hasImageHostLink(c) || IMAGE_FILE_MENTION.test(text);
const hasVideoEvidence = (c: CommentFeatures, text: string) =>
  VIDEO_FILE_MENTION.test(text) || c.links.some((l) => VIDEO_HOST_LINK.test(l));
const hasVisualEvidence = ({ c, text }: Ctx) => hasImageEvidence(c, text) || hasVideoEvidence(c, text);
const countMatches = (text: string, patterns: RegExp[]) => patterns.reduce((n, p) => n + (p.test(text) ? 1 : 0), 0);
const hasPatchSignals = ({ c, text }: Ctx) =>
  hasPRLink(c) ||
  hasPatchAttachmentLink(c) ||
  hasPlaygroundLink(c) ||
  hasTestedPatchPhrase(text) ||
  hasPatchTestHeading(c) ||
  PATCH_CONTEXT_PHRASE.test(text);

// -- Rules (single source of truth) ----------------------------------------

type Rule = { name: string; test: (ctx: Ctx) => boolean };

const REPRO_RULES: Rule[] = [
  { name: "repro_heading", test: ({ c }) => hasReproductionHeading(c) },
  {
    name: "expected_behavior_struct",
    test: (ctx) => hasExpectedBehavior(ctx.c) && structuralLabelCount(ctx.c) >= 2 && !hasPatchSignals(ctx),
  },
  {
    name: "bug_emoji_struct",
    test: (ctx) =>
      BUG_EMOJI_OR_PHRASE.test(ctx.text) && structuralLabelCount(ctx.c) >= 2 && !hasPatchSignals(ctx),
  },
  {
    name: "reproduce_instructions_label",
    test: (ctx) => hasReproduceInstructionsLabel(ctx.c) && !hasPatchSignals(ctx),
  },
  {
    name: "narrative_repro_strong",
    test: (ctx) =>
      countMatches(ctx.text, NARRATIVE_REPRO_STRONG) >= 1 &&
      !REPRO_HYPOTHETICAL_GUARD.test(ctx.text) &&
      !TEST_REPRO_REQUEST_GUARD.test(ctx.text) &&
      !PATCH_AUTHOR_SELF_GUARD.test(ctx.text) &&
      !AI_REVIEW_QUOTE_GUARD.test(ctx.text) &&
      !hasPatchSignals(ctx),
  },
  {
    name: "narrative_repro_medium",
    test: (ctx) =>
      countMatches(ctx.text, NARRATIVE_REPRO_MEDIUM) >= 1 &&
      !TEST_REPRO_REQUEST_GUARD.test(ctx.text) &&
      !PATCH_AUTHOR_SELF_GUARD.test(ctx.text) &&
      !AI_REVIEW_QUOTE_GUARD.test(ctx.text) &&
      !hasPatchSignals(ctx),
  },
];

const TEST_RULES: Rule[] = [
  { name: "patch_test_heading", test: ({ c }) => hasPatchTestHeading(c) },
  {
    name: "before_after_with_image",
    test: ({ c, text }) => hasBefore(c) && hasAfter(c) && hasImageEvidence(c, text),
  },
  {
    name: "tested_patch_with_link",
    test: ({ c, text }) => hasTestedPatchPhrase(text) && (hasPRLink(c) || hasPatchAttachmentLink(c)),
  },
  {
    name: "expected_result_with_struct",
    test: ({ c }) => hasExpectedResult(c) && structuralLabelCount(c) >= 2,
  },
  { name: "struct_3plus", test: ({ c }) => structuralLabelCount(c) >= 3 },
  {
    name: "struct_2_with_patch_signal",
    test: ({ c, text }) =>
      structuralLabelCount(c) >= 2 && (hasPRLink(c) || hasPatchAttachmentLink(c) || hasTestedPatchPhrase(text)),
  },
  { name: "playground_with_image", test: ({ c, text }) => hasPlaygroundLink(c) && hasImageEvidence(c, text) },
  // Playground link + a narrative test phrase. The presence of a Playground URL
  // is strong evidence the user actually exercised the patch; pair with any
  // test phrase (strong or medium) for a high-confidence formal classification.
  {
    name: "playground_with_test_phrase",
    test: ({ c, text }) =>
      hasPlaygroundLink(c) &&
      (countMatches(text, NARRATIVE_TEST_STRONG) >= 1 || countMatches(text, NARRATIVE_TEST_MEDIUM) >= 1),
  },
  {
    name: "narrative_test_strong",
    test: ({ text }) =>
      countMatches(text, NARRATIVE_TEST_STRONG) >= 1 &&
      !COMMITTER_MERGE_PHRASE.test(text) &&
      !TEST_REPRO_REQUEST_GUARD.test(text) &&
      !PATCH_AUTHOR_SELF_GUARD.test(text) &&
      !AI_REVIEW_QUOTE_GUARD.test(text),
  },
  // Narrative test phrase paired with visual evidence (screenshot or screencast).
  // Bumps the tier from low to medium without requiring the full template —
  // the visual corroborates the textual claim.
  {
    name: "narrative_test_with_visual",
    test: (ctx) =>
      (countMatches(ctx.text, NARRATIVE_TEST_STRONG) >= 1 ||
        countMatches(ctx.text, NARRATIVE_TEST_MEDIUM) >= 1) &&
      hasVisualEvidence(ctx),
  },
  // Bare narrative without corroborating evidence. Lands in the low quality
  // tier — image/patch/PR link verification is unreliable across arbitrary hosts,
  // so the tier itself is the filter rather than an upfront gate.
  {
    name: "narrative_test_medium",
    test: ({ text }) => {
      const total = countMatches(text, NARRATIVE_TEST_MEDIUM);
      if (total === 0) return false;
      // If only weak (un-patch-anchored) patterns match, require a patch
      // context phrase elsewhere — kills bug-investigation comments that
      // mention "fixes the problem" / "no issues now" without testing a patch.
      const weak = countMatches(text, NARRATIVE_TEST_MEDIUM_WEAK);
      if (total === weak && !PATCH_CONTEXT_PHRASE.test(text)) return false;
      return (
        !COMMITTER_MERGE_PHRASE.test(text) &&
        !TEST_REPRO_REQUEST_GUARD.test(text) &&
        !PATCH_AUTHOR_SELF_GUARD.test(text) &&
        !CODE_REVIEW_SUGGESTION_GUARD.test(text) &&
        !AI_REVIEW_QUOTE_GUARD.test(text)
      );
    },
  },
];

// -- Public API ------------------------------------------------------------

export function classifyComment(c: CommentFeatures): Classification {
  const ctx: Ctx = { c, text: normalizeText(c.bodyText) };

  const reproReasons = REPRO_RULES.filter((r) => r.test(ctx)).map((r) => r.name);
  if (reproReasons.length) return { category: "repro", quality: qualityFromReasons(reproReasons), reasons: reproReasons };

  const testReasons = TEST_RULES.filter((r) => r.test(ctx)).map((r) => r.name);
  if (testReasons.length) return { category: "test", quality: qualityFromReasons(testReasons), reasons: testReasons };

  return { category: "none", reasons: [] };
}

export function isReproductionReport(c: CommentFeatures): boolean {
  return classifyComment(c).category === "repro";
}
export function isPatchTestComment(c: CommentFeatures): boolean {
  return classifyComment(c).category === "test";
}

/**
 * Quality tiers:
 *   high   — matches the official Reproduction Report / Patch Testing Report
 *            template (heading + multiple structural sections like Environment,
 *            Steps taken, Expected behavior/result, Screenshots).
 *   medium — partial structural evidence: Before/After labels with an image,
 *            a "tested patch" phrase paired with a PR/patch link, Playground
 *            link with image or test phrase, or two structural labels with a
 *            patch signal.
 *   low    — narrative-only claims ("I tested", "I can reproduce", "looks
 *            good"). No image/link verification is required to land here —
 *            users post arbitrary URLs, so the tier is the filter rather than
 *            an upfront gate.
 */
const HIGH_REASONS = new Set<string>([
  "patch_test_heading",
  "repro_heading",
  "struct_3plus",
  "expected_result_with_struct",
  "expected_behavior_struct",
  "bug_emoji_struct",
  "reproduce_instructions_label",
]);
const MEDIUM_REASONS = new Set<string>([
  "before_after_with_image",
  "tested_patch_with_link",
  "playground_with_image",
  "playground_with_test_phrase",
  "struct_2_with_patch_signal",
  "narrative_test_with_visual",
]);

/** Derive the quality tier from a set of classifier reasons. Used both per-
 *  comment (inside classifyComment) and per-user (to aggregate across a user's
 *  comments by taking the max tier). */
export function qualityFromReasons(reasons: string[]): Quality {
  if (reasons.some((r) => HIGH_REASONS.has(r))) return "high";
  if (reasons.some((r) => MEDIUM_REASONS.has(r))) return "medium";
  return "low";
}

