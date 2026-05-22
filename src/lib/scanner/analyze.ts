import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

import { buildScanResult } from "@/lib/scanner/engine";
import {
  BlockedByType,
  ConfidenceBucket,
  JsonLdNode,
  RetrievalAttempt,
  RetrievalEvidence,
  RetrievalModeUsed,
  ScanContext,
  ScanDebug,
  ScanResult,
} from "@/lib/scanner/types";

const SCAN_USER_AGENT =
  "AI Readiness Scanner/1.0 (+https://example.com/scanner)";
const BROWSER_FALLBACK_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const SOCIAL_HOSTS = [
  "x.com",
  "twitter.com",
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "github.com",
  "tiktok.com",
  "medium.com",
  "substack.com",
];

const BLOCKED_RETRY_DELAY_MS = 1200;

const ARTICLE_CONTAINER_SELECTORS = [
  "main",
  "article",
  "[role='main']",
  ".entry-content",
  ".post-content",
  ".article-content",
  ".article-body",
  ".post-body",
  ".story-content",
  ".td-post-content",
  ".single-content",
  ".content-inner",
  ".jeg_post_content",
  ".news-article",
  ".content-area",
];

type FetchMode = "scanner" | "browser-fallback";
type FallbackType = "browser-fallback" | "wordpress-rest-api";

type AnalyzeOptions = {
  debug?: boolean;
};

type ExtractedDocument = {
  title?: string;
  siteName?: string;
  metaDescription?: string;
  metaRobots?: string;
  canonical?: string;
  modifiedDate?: string;
  section?: string;
  image?: string;
  htmlLang?: string;
  hasViewport: boolean;
  h1Count: number;
  mainH1Count: number;
  mainHeadingText?: string;
  headingCount: number;
  paragraphTexts: string[];
  paragraphCount: number;
  wordCount: number;
  averageParagraphLength: number;
  hasMainContent: boolean;
  authorText?: string;
  publicationDate?: string;
  socialLinks: string[];
  externalPlatformLinks: string[];
  schemaNodes: JsonLdNode[];
  schemaTypes: string[];
  organizationSchema?: JsonLdNode;
  personSchema?: JsonLdNode;
  articleSchema?: JsonLdNode;
  publisherNameVisible: boolean;
  domainBrandSignal: boolean;
  organizationHasSameAs: boolean;
  schemaSameAsLinks: string[];
  articleHasPublisherReference: boolean;
  articlePublisherMatchesOrganization: boolean;
  detectedArticleSelectors: string[];
  h1Candidates: string[];
  bodyTextLength: number;
  extractedTextLength: number;
  rawHtmlContainsTitleText: boolean;
  rawHtmlContainsArticleBody: boolean;
  extractionErrors: string[];
  bodyText: string;
};

type FallbackState = {
  attempted: boolean;
  type?: FallbackType;
  succeeded: boolean;
  statusCode?: number;
};

type WordPressFallbackResult = {
  attempted: boolean;
  statusCode?: number;
  html?: string;
  sourceUrl?: string;
};

type BlockedDetection = {
  blockedByProtection: boolean;
  titleContainsChallenge: boolean;
  isCloudflareChallenge: boolean;
  blockedByType: BlockedByType;
};

type FetchedPage = {
  response: Response;
  responseTimeMs: number;
  html: string;
  finalUrl: string;
  headers: Record<string, string>;
  extracted: ExtractedDocument;
};

function normalizeInputUrl(input: string) {
  const trimmed = input.trim();

  if (!trimmed) {
    throw new Error("Enter a URL to scan.");
  }

  try {
    return new URL(trimmed).toString();
  } catch {
    return new URL(`https://${trimmed}`).toString();
  }
}

function toHeaderMap(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function textContent(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function countWords(value: string) {
  const words = textContent(value).split(/\s+/).filter(Boolean);
  return words.length;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => textContent(value)).filter(Boolean))];
}

function parseJsonLd($: cheerio.CheerioAPI) {
  const nodes: JsonLdNode[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const raw = $(element).contents().text();

    if (!raw.trim()) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const graphNodes =
        typeof parsed === "object" && parsed
          ? (parsed as { "@graph"?: unknown[] })["@graph"]
          : undefined;

      const items = Array.isArray(parsed)
        ? parsed
        : Array.isArray(graphNodes)
          ? graphNodes
          : [parsed];

      items.forEach((item) => {
        if (item && typeof item === "object") {
          nodes.push(item as JsonLdNode);
        }
      });
    } catch {
      return;
    }
  });

  return nodes;
}

function schemaTypeIncludes(node: JsonLdNode, expected: string) {
  const value = node["@type"];

  if (typeof value === "string") {
    return value.toLowerCase().includes(expected.toLowerCase());
  }

  if (Array.isArray(value)) {
    return value.some(
      (entry) =>
        typeof entry === "string" &&
        entry.toLowerCase().includes(expected.toLowerCase()),
    );
  }

  return false;
}

function readString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function readSameAs(node: JsonLdNode | undefined) {
  if (!node) {
    return [];
  }

  const value = node.sameAs;
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string => typeof entry === "string" && Boolean(entry.trim()),
      )
    : [];
}

function readPublisherReference(node: JsonLdNode | undefined) {
  if (!node || typeof node.publisher !== "object" || !node.publisher) {
    return undefined;
  }

  return node.publisher as JsonLdNode;
}

function hostnameBrandTokens(hostname: string) {
  return hostname
    .replace(/^www\./, "")
    .split(".")
    .slice(0, 2)
    .join(" ")
    .replace(/[-_]/g, " ")
    .trim()
    .toLowerCase();
}

function extractSameDomainExternalLinks(
  links: string[],
  siteHostname: string,
  matcher?: (hostname: string) => boolean,
) {
  return links.filter((href) => {
    try {
      const url = new URL(href);
      if (url.hostname === siteHostname) {
        return false;
      }

      return matcher ? matcher(url.hostname) : true;
    } catch {
      return false;
    }
  });
}

function buildHeaders(mode: FetchMode, targetUrl: string) {
  const userAgent =
    mode === "browser-fallback" ? BROWSER_FALLBACK_USER_AGENT : SCAN_USER_AGENT;
  const referer = new URL(targetUrl).origin + "/";

  return {
    "user-agent": userAgent,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    connection: "keep-alive",
    ...(mode === "browser-fallback"
      ? {
          "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not/A)Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "accept-encoding": "gzip, deflate, br",
          referer,
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "same-origin",
          "sec-fetch-user": "?1",
          "upgrade-insecure-requests": "1",
        }
      : {}),
  };
}

async function fetchWithTiming(url: string, mode: FetchMode) {
  const started = performance.now();
  const response = await fetch(url, {
    headers: buildHeaders(mode, url),
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const responseTimeMs = Math.round(performance.now() - started);

  return { response, responseTimeMs };
}

function detectArticleSelectors($: cheerio.CheerioAPI) {
  return ARTICLE_CONTAINER_SELECTORS.filter((selector) => $(selector).length > 0);
}

function collectTexts(
  $: cheerio.CheerioAPI,
  selectors: string[],
  suffix: string,
) {
  const selectorList = selectors.map((selector) => `${selector} ${suffix}`).join(", ");
  if (!selectorList) {
    return [];
  }

  return uniqueStrings(
    $(selectorList)
      .toArray()
      .map((element) => $(element).text()),
  );
}

function extractDocument(html: string, finalUrl: string) {
  const $ = cheerio.load(html);
  const extractionErrors: string[] = [];

  const title =
    textContent($("title").first().text()) ||
    $('meta[property="og:title"]').attr("content")?.trim() ||
    undefined;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    undefined;
  const metaRobots = $('meta[name="robots"]').attr("content")?.trim() || undefined;
  const canonical = $('link[rel="canonical"]').attr("href")?.trim();
  const htmlLang = $("html").attr("lang")?.trim();
  const hasViewport = Boolean($('meta[name="viewport"]').attr("content"));

  const detectedArticleSelectors = detectArticleSelectors($);
  const headingTextsFromContainers = collectTexts(
    $,
    detectedArticleSelectors,
    "h1, h2, h3, h4, h5, h6",
  );
  const paragraphTextsFromContainers = collectTexts($, detectedArticleSelectors, "p");

  const globalHeadingTexts = uniqueStrings(
    $("h1, h2, h3, h4, h5, h6")
      .toArray()
      .map((element) => $(element).text()),
  );
  const globalParagraphTexts = uniqueStrings(
    $("p")
      .toArray()
      .map((element) => $(element).text()),
  );

  const h1Candidates = uniqueStrings(
    $("h1")
      .toArray()
      .map((element) => $(element).text()),
  );

  const headingTexts =
    headingTextsFromContainers.length > 0 ? headingTextsFromContainers : globalHeadingTexts;
  const paragraphTexts =
    paragraphTextsFromContainers.length > 0
      ? paragraphTextsFromContainers
      : globalParagraphTexts;

  const h1Count = h1Candidates.length;
  const mainH1Count = detectedArticleSelectors.length
    ? uniqueStrings(collectTexts($, detectedArticleSelectors, "h1")).length
    : $("main h1, article h1, [role='main'] h1").length;
  const mainHeadingText =
    uniqueStrings(collectTexts($, detectedArticleSelectors, "h1"))[0] ||
    h1Candidates[0] ||
    undefined;
  const headingCount = headingTexts.length;
  const paragraphCount = paragraphTexts.length;
  const extractedText = paragraphTexts.join(" ");
  const wordCount = countWords(extractedText);
  const averageParagraphLength = paragraphCount
    ? Math.round(wordCount / paragraphCount)
    : 0;

  const hasMainContent =
    detectedArticleSelectors.length > 0 ||
    $("main").length > 0 ||
    $("article").length > 0 ||
    $('[role="main"]').length > 0;

  const authorText =
    $('[rel="author"]').first().text().trim() ||
    $('[itemprop="author"]').first().text().trim() ||
    $('[class*="author" i]').first().text().trim() ||
    $('meta[name="author"]').attr("content")?.trim() ||
    $('meta[property="article:author"]').attr("content")?.trim() ||
    undefined;

  const publicationDate =
    $('meta[property="article:published_time"]').attr("content")?.trim() ||
    $('meta[name="article:published_time"]').attr("content")?.trim() ||
    $("time[datetime]").first().attr("datetime")?.trim() ||
    $('meta[name="date"]').attr("content")?.trim() ||
    undefined;

  const modifiedDate =
    $('meta[property="article:modified_time"]').attr("content")?.trim() ||
    $('meta[property="og:updated_time"]').attr("content")?.trim() ||
    undefined;

  const section =
    $('meta[property="article:section"]').attr("content")?.trim() ||
    $('meta[name="section"]').attr("content")?.trim() ||
    undefined;

  const image =
    $('meta[property="og:image"]').attr("content")?.trim() ||
    $('meta[name="twitter:image"]').attr("content")?.trim() ||
    undefined;

  const links = $("a[href]")
    .toArray()
    .map((element) => $(element).attr("href")?.trim())
    .filter((href): href is string => Boolean(href))
    .map((href) => {
      try {
        return new URL(href, finalUrl).toString();
      } catch {
        return href;
      }
    });

  const finalParsedUrl = new URL(finalUrl);
  const socialLinks = extractSameDomainExternalLinks(
    links,
    finalParsedUrl.hostname,
    (hostname) => SOCIAL_HOSTS.some((host) => hostname.includes(host)),
  );
  const externalPlatformLinks = extractSameDomainExternalLinks(
    links,
    finalParsedUrl.hostname,
  );

  const schemaNodes = parseJsonLd($);
  const schemaTypes = schemaNodes
    .flatMap((node) => {
      const value = node["@type"];
      return Array.isArray(value) ? value : value ? [value] : [];
    })
    .filter((value): value is string => typeof value === "string");

  const organizationSchema = schemaNodes.find((node) =>
    schemaTypeIncludes(node, "Organization"),
  );
  const personSchema = schemaNodes.find((node) => schemaTypeIncludes(node, "Person"));
  const articleSchema = schemaNodes.find((node) => schemaTypeIncludes(node, "Article"));
  const articlePublisherReference = readPublisherReference(articleSchema);
  const articlePublisherName = readString(articlePublisherReference?.name);
  const organizationName = readString(organizationSchema?.name);
  const siteName =
    $('meta[property="og:site_name"]').attr("content")?.trim() ||
    $('meta[name="application-name"]').attr("content")?.trim() ||
    "";
  const headerFooterText = `${$("header").first().text()} ${$("footer").first().text()}`;
  const hostTokens = hostnameBrandTokens(finalParsedUrl.hostname);
  const publisherNameVisible = Boolean(siteName || headerFooterText.trim() || organizationName);
  const domainBrandSignal = Boolean(
    siteName.toLowerCase().includes(hostTokens) ||
      organizationName.toLowerCase().includes(hostTokens) ||
      headerFooterText.toLowerCase().includes(hostTokens),
  );
  const organizationHasSameAs = readSameAs(organizationSchema).length > 0;
  const schemaSameAsLinks = schemaNodes.flatMap((node) => readSameAs(node));
  const articleHasPublisherReference = Boolean(articlePublisherReference);
  const articlePublisherMatchesOrganization =
    Boolean(articlePublisherName) &&
    Boolean(organizationName) &&
    articlePublisherName.toLowerCase() === organizationName.toLowerCase();

  const bodyText = textContent($("body").text());
  const bodyTextLength = bodyText.length;
  const extractedTextLength = extractedText.length;
  const rawHtmlContainsTitleText = Boolean(
    title && html.toLowerCase().includes(title.toLowerCase()),
  );
  const rawHtmlContainsArticleBody =
    paragraphTexts.some((paragraph) => paragraph.length >= 140) || wordCount >= 120;

  if (headingCount === 0) {
    extractionErrors.push("no-headings-extracted");
  }
  if (paragraphCount === 0) {
    extractionErrors.push("no-paragraphs-extracted");
  }
  if (wordCount === 0) {
    extractionErrors.push("no-body-words-extracted");
  }
  if (!rawHtmlContainsArticleBody) {
    extractionErrors.push("article-body-not-found-in-raw-html");
  }

  return {
    title,
    siteName: siteName || undefined,
    metaDescription,
    metaRobots,
    canonical,
    modifiedDate,
    section,
    image,
    htmlLang,
    hasViewport,
    h1Count,
    mainH1Count,
    mainHeadingText,
    headingCount,
    paragraphTexts,
    paragraphCount,
    wordCount,
    averageParagraphLength,
    hasMainContent,
    authorText,
    publicationDate,
    socialLinks,
    externalPlatformLinks,
    schemaNodes,
    schemaTypes,
    organizationSchema,
    personSchema,
    articleSchema,
    publisherNameVisible,
    domainBrandSignal,
    organizationHasSameAs,
    schemaSameAsLinks,
    articleHasPublisherReference,
    articlePublisherMatchesOrganization,
    detectedArticleSelectors,
    h1Candidates,
    bodyTextLength,
    extractedTextLength,
    rawHtmlContainsTitleText,
    rawHtmlContainsArticleBody,
    extractionErrors,
    bodyText,
  } satisfies ExtractedDocument;
}

function shouldTryBrowserFallback(extracted: ExtractedDocument) {
  return (
    extracted.wordCount === 0 &&
    extracted.headingCount === 0 &&
    extracted.paragraphCount === 0
  );
}

function detectBlockedRetrieval(
  statusCode: number,
  extracted: ExtractedDocument,
  headers: Record<string, string>,
): BlockedDetection {
  const title = extracted.title?.toLowerCase() ?? "";
  const body = extracted.bodyText.toLowerCase();
  const serverHeader = headers.server?.toLowerCase() ?? "";
  const cloudflareHeaderPresent =
    Boolean(headers["cf-ray"]) || serverHeader.includes("cloudflare");
  const titleContainsChallenge = title.includes("just a moment");
  const bodyContainsChallenge = body.includes("just a moment");
  const isCloudflareChallenge =
    cloudflareHeaderPresent || titleContainsChallenge || bodyContainsChallenge;
  const blockedByProtection =
    (statusCode === 403 || statusCode === 429) &&
    isCloudflareChallenge &&
    !extracted.rawHtmlContainsArticleBody;
  const blockedByType: BlockedByType = blockedByProtection
    ? cloudflareHeaderPresent
      ? "cloudflare"
      : statusCode === 429
        ? "rate_limit"
        : titleContainsChallenge || bodyContainsChallenge
          ? "challenge_page"
          : statusCode === 403
            ? "firewall"
            : "unknown"
    : null;

  return {
    blockedByProtection,
    titleContainsChallenge,
    isCloudflareChallenge,
    blockedByType,
  };
}

function looksLikeChallengeText(value?: string) {
  const normalized = value?.toLowerCase() ?? "";
  return normalized.includes("just a moment");
}

function meaningfulMetadataCount(extracted: ExtractedDocument) {
  const fields = [
    extracted.title && !looksLikeChallengeText(extracted.title),
    extracted.metaDescription && !looksLikeChallengeText(extracted.metaDescription),
    extracted.canonical,
    extracted.publicationDate,
    extracted.modifiedDate,
    extracted.authorText,
    extracted.siteName && !looksLikeChallengeText(extracted.siteName),
    extracted.image,
    extracted.section,
    extracted.schemaNodes.length > 0,
  ];

  return fields.filter(Boolean).length;
}

function hasMeaningfulMetadata(extracted: ExtractedDocument) {
  return meaningfulMetadataCount(extracted) >= 2;
}

function contentConfidenceFromExtracted(extracted: ExtractedDocument): ConfidenceBucket {
  if (!extracted.rawHtmlContainsArticleBody) {
    return "LOW";
  }

  if (extracted.wordCount >= 600 && extracted.paragraphCount >= 4) {
    return "HIGH";
  }

  return "MEDIUM";
}

function metadataConfidenceFromExtracted(extracted: ExtractedDocument): ConfidenceBucket {
  const count = meaningfulMetadataCount(extracted);

  if (count >= 5) {
    return "HIGH";
  }

  if (count >= 2) {
    return "MEDIUM";
  }

  return "LOW";
}

function retrievalModeFromAnalysis(params: {
  articleBodyRetrieved: boolean;
  metadataRetrieved: boolean;
  browserFallbackUsed: boolean;
  wordpressFallbackUsed: boolean;
}): RetrievalModeUsed {
  if (params.articleBodyRetrieved) {
    if (params.wordpressFallbackUsed) {
      return "WORDPRESS_REST_FALLBACK";
    }

    if (params.browserFallbackUsed) {
      return "BROWSER_LIKE_FETCH";
    }

    return "STANDARD_FETCH";
  }

  if (params.metadataRetrieved) {
    return "METADATA_ONLY";
  }

  return "FAILED";
}

function retrievalConfidenceFromMode(mode: RetrievalModeUsed): ConfidenceBucket {
  if (mode === "STANDARD_FETCH") {
    return "HIGH";
  }

  if (mode === "BROWSER_LIKE_FETCH" || mode === "WORDPRESS_REST_FALLBACK") {
    return "MEDIUM";
  }

  return "LOW";
}

function buildAttemptReason(
  extracted: ExtractedDocument,
  blockedDetection: BlockedDetection,
  articleBodyRetrieved: boolean,
) {
  if (articleBodyRetrieved) {
    return "article_body_retrieved";
  }

  if (blockedDetection.blockedByProtection) {
    if (blockedDetection.blockedByType === "cloudflare") {
      return "cloudflare_challenge";
    }

    if (blockedDetection.blockedByType === "rate_limit") {
      return "rate_limited";
    }

    if (blockedDetection.blockedByType === "challenge_page") {
      return "challenge_page";
    }

    return "blocked_response";
  }

  if (hasMeaningfulMetadata(extracted)) {
    return "metadata_only_available";
  }

  return "no_article_body_retrieved";
}

function buildRetrievalAttempt(
  mode: RetrievalAttempt["mode"],
  statusCode: number | undefined,
  extracted: ExtractedDocument,
  blockedDetection: BlockedDetection,
): RetrievalAttempt {
  const articleBodyRetrieved = extracted.rawHtmlContainsArticleBody;

  return {
    mode,
    statusCode,
    succeeded: articleBodyRetrieved,
    reason: buildAttemptReason(extracted, blockedDetection, articleBodyRetrieved),
  };
}

function deriveSlugFromUrl(input: string) {
  try {
    const url = new URL(input);
    const parts = url.pathname.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function metaDescriptionFromHtml(html: string) {
  const $ = cheerio.load(html);
  return textContent($.text()) || undefined;
}

function buildWordPressFallbackHtml(post: Record<string, unknown>, sourceUrl: string) {
  const title = readString((post.title as { rendered?: unknown } | undefined)?.rendered);
  const content = readString((post.content as { rendered?: unknown } | undefined)?.rendered);
  const excerpt = readString((post.excerpt as { rendered?: unknown } | undefined)?.rendered);
  const date = readString(post.date);
  const modified = readString(post.modified);
  const canonical = readString(post.link) || sourceUrl;
  const embedded = (post._embedded as Record<string, unknown> | undefined) ?? {};
  const authors = Array.isArray(embedded.author) ? embedded.author : [];
  const authorName = readString((authors[0] as { name?: unknown } | undefined)?.name);
  const metaDescription = metaDescriptionFromHtml(excerpt);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <title>${escapeHtml(title || "Article")}</title>
    ${canonical ? `<link rel="canonical" href="${escapeHtml(canonical)}" />` : ""}
    ${metaDescription ? `<meta name="description" content="${escapeHtml(metaDescription)}" />` : ""}
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    ${authorName ? `<meta name="author" content="${escapeHtml(authorName)}" />` : ""}
  </head>
  <body>
    <main>
      <article>
        ${title ? `<h1>${title}</h1>` : ""}
        ${authorName ? `<p class="author-byline">${escapeHtml(authorName)}</p>` : ""}
        ${date ? `<time datetime="${escapeHtml(date)}">${escapeHtml(modified || date)}</time>` : ""}
        ${excerpt ? `<div class="article-excerpt">${excerpt}</div>` : ""}
        <div class="article-content">${content}</div>
      </article>
    </main>
  </body>
</html>`;
}

async function tryWordPressFallback(pageUrl: string): Promise<WordPressFallbackResult> {
  const slug = deriveSlugFromUrl(pageUrl);
  if (!slug) {
    return { attempted: false };
  }

  const endpoint = new URL("/wp-json/wp/v2/posts", pageUrl);
  endpoint.searchParams.set("slug", slug);
  endpoint.searchParams.set("_embed", "1");

  const response = await fetch(endpoint.toString(), {
    headers: {
      "user-agent": BROWSER_FALLBACK_USER_AGENT,
      accept: "application/json,text/plain,*/*;q=0.5",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    return {
      attempted: true,
      statusCode: response.status,
    };
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload) || payload.length === 0) {
    return {
      attempted: true,
      statusCode: response.status,
    };
  }

  const post = payload[0];
  if (!post || typeof post !== "object") {
    return {
      attempted: true,
      statusCode: response.status,
    };
  }

  return {
    attempted: true,
    statusCode: response.status,
    html: buildWordPressFallbackHtml(post as Record<string, unknown>, pageUrl),
    sourceUrl: endpoint.toString(),
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAndExtract(url: string, mode: FetchMode): Promise<FetchedPage> {
  const { response, responseTimeMs } = await fetchWithTiming(url, mode);
  const html = await response.text();
  const finalUrl = response.url;
  const headers = toHeaderMap(response.headers);
  const extracted = extractDocument(html, finalUrl);

  return {
    response,
    responseTimeMs,
    html,
    finalUrl,
    headers,
    extracted,
  };
}

function buildRetrievalEvidence(
  robotsReachable: boolean,
  sitemapUrls: string[],
  blockedByProtection: boolean,
  statusCode: number,
  articleBodyRetrieved: boolean,
  extracted: ExtractedDocument,
  fallbackSucceeded: boolean,
): RetrievalEvidence {
  const siteDiscovery = robotsReachable || sitemapUrls.length > 0;
  const pageReachable =
    statusCode >= 200 && statusCode < 400 && !blockedByProtection;
  const metadataRetrieved = hasMeaningfulMetadata(extracted);

  return {
    siteDiscovery,
    pageReachable,
    articleBodyRetrieved,
    metadataRetrieved,
    fallbackAvailable: fallbackSucceeded,
  };
}

function buildDebug(
  fetchedUrl: string,
  finalUrl: string,
  statusCode: number,
  html: string,
  extracted: ExtractedDocument,
  mode: FetchMode,
  browserFallbackTried: boolean,
  browserFallbackUsed: boolean,
  blockedByProtection: boolean,
  blockedByType: BlockedByType,
  retrievalEvidence: RetrievalEvidence,
  retrievalModeUsed: RetrievalModeUsed,
  retrievalConfidence: ConfidenceBucket,
  contentConfidence: ConfidenceBucket,
  metadataConfidence: ConfidenceBucket,
  retrievalAttempts: RetrievalAttempt[],
  fallback: FallbackState,
  fetchProfilesTried: FetchMode[],
  retryDelayMs: number,
): ScanDebug {
  return {
    fetchedUrl,
    finalUrl,
    statusCode,
    htmlLength: html.length,
    bodyTextLength: extracted.bodyTextLength,
    extractedTextLength: extracted.extractedTextLength,
    headingCount: extracted.headingCount,
    paragraphCount: extracted.paragraphCount,
    h1Candidates: extracted.h1Candidates,
    title: extracted.title,
    metaDescription: extracted.metaDescription,
    canonical: extracted.canonical,
    detectedArticleSelectors: extracted.detectedArticleSelectors,
    extractionErrors: extracted.extractionErrors,
    rawHtmlContainsTitleText: extracted.rawHtmlContainsTitleText,
    rawHtmlContainsArticleBody: extracted.rawHtmlContainsArticleBody,
    fetchMode: mode,
    fetchProfileUsed: mode,
    fetchProfilesTried,
    browserFallbackTried,
    browserFallbackUsed,
    retryDelayMs,
    renderedContentLikelyRequired:
      !extracted.rawHtmlContainsArticleBody && extracted.rawHtmlContainsTitleText,
    blockedByProtection,
    blockedByType,
    retrievalEvidence,
    retrievalModeUsed,
    retrievalConfidence,
    contentConfidence,
    metadataConfidence,
    retrievalAttempts,
    fallbackAttempted: fallback.attempted,
    fallbackType: fallback.type,
    fallbackSucceeded: fallback.succeeded,
    fallbackStatusCode: fallback.statusCode,
  };
}

export async function analyzeUrl(
  input: string,
  options: AnalyzeOptions = {},
): Promise<ScanResult> {
  const url = normalizeInputUrl(input);
  const initialPage = await fetchAndExtract(url, "scanner");

  let page = initialPage;
  let fetchMode: FetchMode = "scanner";
  const fetchProfilesTried: FetchMode[] = ["scanner"];
  let browserFallbackTried = false;
  let browserFallbackUsed = false;
  let retryDelayMs = 0;
  let fallback: FallbackState = {
    attempted: false,
    succeeded: false,
  };
  const retrievalAttempts: RetrievalAttempt[] = [];
  let wordpressFallbackUsed = false;

  const initialBlockedDetection = detectBlockedRetrieval(
    page.response.status,
    page.extracted,
    page.headers,
  );
  retrievalAttempts.push(
    buildRetrievalAttempt(
      "STANDARD_FETCH",
      page.response.status,
      page.extracted,
      initialBlockedDetection,
    ),
  );

  if (shouldTryBrowserFallback(page.extracted) || initialBlockedDetection.blockedByProtection) {
    browserFallbackTried = true;
    fetchProfilesTried.push("browser-fallback");

    if (initialBlockedDetection.blockedByProtection) {
      retryDelayMs += BLOCKED_RETRY_DELAY_MS;
      await delay(BLOCKED_RETRY_DELAY_MS);
    }

    try {
      const fallbackPage = await fetchAndExtract(url, "browser-fallback");
      const browserBlockedDetection = detectBlockedRetrieval(
        fallbackPage.response.status,
        fallbackPage.extracted,
        fallbackPage.headers,
      );
      retrievalAttempts.push(
        buildRetrievalAttempt(
          "BROWSER_LIKE_FETCH",
          fallbackPage.response.status,
          fallbackPage.extracted,
          browserBlockedDetection,
        ),
      );
      fallback = {
        attempted: true,
        type: "browser-fallback",
        succeeded:
          fallbackPage.extracted.wordCount > page.extracted.wordCount ||
          fallbackPage.extracted.paragraphCount > page.extracted.paragraphCount ||
          fallbackPage.extracted.headingCount > page.extracted.headingCount,
        statusCode: fallbackPage.response.status,
      };

      if (fallback.succeeded) {
        page = fallbackPage;
        fetchMode = "browser-fallback";
        browserFallbackUsed = true;
      }
    } catch {
      page.extracted.extractionErrors.push("browser-fallback-fetch-failed");
      retrievalAttempts.push({
        mode: "BROWSER_LIKE_FETCH",
        succeeded: false,
        reason: "fetch_failed",
      });
      fallback = {
        attempted: true,
        type: "browser-fallback",
        succeeded: false,
      };
    }
  }

  const directBlockedDetection = detectBlockedRetrieval(
    page.response.status,
    page.extracted,
    page.headers,
  );
  const blockedByProtection = directBlockedDetection.blockedByProtection;
  const blockedByType = directBlockedDetection.blockedByType;

  let analysisHtml = page.html;
  let analysisExtracted = page.extracted;

  if (blockedByProtection || !page.extracted.rawHtmlContainsArticleBody) {
    if (blockedByProtection) {
      retryDelayMs += BLOCKED_RETRY_DELAY_MS;
      await delay(BLOCKED_RETRY_DELAY_MS);
    }

    try {
      const wpFallback = await tryWordPressFallback(url);
      if (wpFallback.attempted) {
        fallback = {
          attempted: true,
          type: "wordpress-rest-api",
          succeeded: Boolean(wpFallback.html),
          statusCode: wpFallback.statusCode,
        };
      }

      if (wpFallback.html) {
        const wpExtracted = extractDocument(wpFallback.html, url);
        const wpBlockedDetection = detectBlockedRetrieval(
          wpFallback.statusCode ?? 200,
          wpExtracted,
          {},
        );
        retrievalAttempts.push(
          buildRetrievalAttempt(
            "WORDPRESS_REST_FALLBACK",
            wpFallback.statusCode,
            wpExtracted,
            wpBlockedDetection,
          ),
        );
        const shouldUseFallback =
          blockedByProtection ||
          wpExtracted.wordCount > analysisExtracted.wordCount ||
          wpExtracted.paragraphCount > analysisExtracted.paragraphCount ||
          wpExtracted.headingCount > analysisExtracted.headingCount ||
          (!analysisExtracted.rawHtmlContainsArticleBody && hasMeaningfulMetadata(wpExtracted));

        if (shouldUseFallback) {
          analysisHtml = wpFallback.html;
          analysisExtracted = wpExtracted;
          wordpressFallbackUsed = true;
        }
      } else if (wpFallback.attempted) {
        retrievalAttempts.push({
          mode: "WORDPRESS_REST_FALLBACK",
          statusCode: wpFallback.statusCode,
          succeeded: false,
          reason: blockedByProtection ? "blocked_response" : "no_article_body_retrieved",
        });
      }
    } catch {
      page.extracted.extractionErrors.push("wordpress-rest-api-fallback-failed");
      retrievalAttempts.push({
        mode: "WORDPRESS_REST_FALLBACK",
        succeeded: false,
        reason: "fetch_failed",
      });
      fallback = {
        attempted: true,
        type: "wordpress-rest-api",
        succeeded: false,
      };
    }
  }

  const finalParsedUrl = new URL(page.finalUrl);

  const robotsUrl = new URL("/robots.txt", finalParsedUrl.origin).toString();
  let robotsTxt = "";
  let robotsReachable = false;
  let crawlAllowed: boolean | undefined;
  let sitemapUrls: string[] = [];

  try {
    const robotsResponse = await fetch(robotsUrl, {
      headers: {
        "user-agent": SCAN_USER_AGENT,
        accept: "text/plain,*/*;q=0.5",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (robotsResponse.ok) {
      robotsTxt = await robotsResponse.text();
      robotsReachable = true;

      const robots = robotsParser(robotsUrl, robotsTxt);
      crawlAllowed = robots.isAllowed(page.finalUrl, SCAN_USER_AGENT);
      sitemapUrls = robots.getSitemaps();
    }
  } catch {
    robotsReachable = false;
  }

  if (sitemapUrls.length === 0) {
    try {
      const defaultSitemap = new URL("/sitemap.xml", finalParsedUrl.origin).toString();
      const sitemapResponse = await fetch(defaultSitemap, {
        headers: {
          "user-agent": SCAN_USER_AGENT,
          accept: "application/xml,text/xml,*/*;q=0.5",
        },
        signal: AbortSignal.timeout(5000),
      });

      if (sitemapResponse.ok) {
        sitemapUrls = [defaultSitemap];
      }
    } catch {
      // Ignore sitemap fallback errors.
    }
  }

  const retrievalEvidence = buildRetrievalEvidence(
    robotsReachable,
    sitemapUrls,
    blockedByProtection,
    page.response.status,
    analysisExtracted.rawHtmlContainsArticleBody,
    analysisExtracted,
    fallback.succeeded,
  );
  const retrievalModeUsed = retrievalModeFromAnalysis({
    articleBodyRetrieved: analysisExtracted.rawHtmlContainsArticleBody,
    metadataRetrieved: retrievalEvidence.metadataRetrieved,
    browserFallbackUsed,
    wordpressFallbackUsed,
  });
  const retrievalConfidence = retrievalConfidenceFromMode(retrievalModeUsed);
  const contentConfidence = contentConfidenceFromExtracted(analysisExtracted);
  const metadataConfidence = metadataConfidenceFromExtracted(analysisExtracted);

  const context: ScanContext = {
    url,
    finalUrl: page.finalUrl,
    hostname: finalParsedUrl.hostname,
    responseTimeMs: page.responseTimeMs,
    statusCode: page.response.status,
    contentType: page.response.headers.get("content-type") ?? "",
    html: analysisHtml,
    htmlLang: analysisExtracted.htmlLang,
    robotsTxt,
    robotsReachable,
    crawlAllowed,
    sitemapUrls,
    headers: page.headers,
    title: analysisExtracted.title,
    siteName: analysisExtracted.siteName,
    metaDescription: analysisExtracted.metaDescription,
    metaRobots: analysisExtracted.metaRobots,
    xRobotsTag: page.headers["x-robots-tag"],
    canonical: analysisExtracted.canonical,
    modifiedDate: analysisExtracted.modifiedDate,
    section: analysisExtracted.section,
    image: analysisExtracted.image,
    hasViewport: analysisExtracted.hasViewport,
    h1Count: analysisExtracted.h1Count,
    mainH1Count: analysisExtracted.mainH1Count,
    mainHeadingText: analysisExtracted.mainHeadingText,
    headingCount: analysisExtracted.headingCount,
    paragraphCount: analysisExtracted.paragraphCount,
    averageParagraphLength: analysisExtracted.averageParagraphLength,
    wordCount: analysisExtracted.wordCount,
    hasMainContent: analysisExtracted.hasMainContent,
    authorText: analysisExtracted.authorText,
    publicationDate: analysisExtracted.publicationDate,
    socialLinks: analysisExtracted.socialLinks,
    schemaSameAsLinks: analysisExtracted.schemaSameAsLinks,
    externalPlatformLinks: analysisExtracted.externalPlatformLinks,
    schemaNodes: analysisExtracted.schemaNodes,
    schemaTypes: analysisExtracted.schemaTypes,
    organizationSchema: analysisExtracted.organizationSchema,
    personSchema: analysisExtracted.personSchema,
    articleSchema: analysisExtracted.articleSchema,
    publisherNameVisible: analysisExtracted.publisherNameVisible,
    domainBrandSignal: analysisExtracted.domainBrandSignal,
    organizationHasSameAs: analysisExtracted.organizationHasSameAs,
    articleHasPublisherReference: analysisExtracted.articleHasPublisherReference,
    articlePublisherMatchesOrganization: analysisExtracted.articlePublisherMatchesOrganization,
    redirectsFollowed: page.finalUrl === url ? 0 : 1,
    blockedByProtection,
    blockedByType,
    articleBodyRetrieved: analysisExtracted.rawHtmlContainsArticleBody,
    retrievalEvidence,
    retrievalModeUsed,
    retrievalConfidence,
    contentConfidence,
    metadataConfidence,
    retrievalAttempts,
    titleContainsChallenge: directBlockedDetection.titleContainsChallenge,
    isCloudflareChallenge: directBlockedDetection.isCloudflareChallenge,
    fallbackAttempted: fallback.attempted,
    fallbackType: fallback.type,
    fallbackSucceeded: fallback.succeeded,
  };

  const result = buildScanResult(context);

  if (options.debug) {
    result.debug = buildDebug(
      url,
      page.finalUrl,
      page.response.status,
      analysisHtml,
      analysisExtracted,
      fetchMode,
      browserFallbackTried,
      browserFallbackUsed,
      blockedByProtection,
      blockedByType,
      retrievalEvidence,
      retrievalModeUsed,
      retrievalConfidence,
      contentConfidence,
      metadataConfidence,
      retrievalAttempts,
      fallback,
      fetchProfilesTried,
      retryDelayMs,
    );
  }

  return result;
}
