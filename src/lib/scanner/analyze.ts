import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

import { buildScanResult } from "@/lib/scanner/engine";
import {
  JsonLdNode,
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

type AnalyzeOptions = {
  debug?: boolean;
};

type ExtractedDocument = {
  title?: string;
  metaDescription?: string;
  metaRobots?: string;
  canonical?: string;
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

function buildHeaders(mode: FetchMode) {
  const userAgent =
    mode === "browser-fallback" ? BROWSER_FALLBACK_USER_AGENT : SCAN_USER_AGENT;

  return {
    "user-agent": userAgent,
    accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    "accept-language": "en-US,en;q=0.9",
    "cache-control": "no-cache",
    pragma: "no-cache",
    ...(mode === "browser-fallback"
      ? {
          "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not/A)Brand";v="99"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "document",
          "sec-fetch-mode": "navigate",
          "sec-fetch-site": "none",
          "upgrade-insecure-requests": "1",
        }
      : {}),
  };
}

async function fetchWithTiming(url: string, mode: FetchMode) {
  const started = performance.now();
  const response = await fetch(url, {
    headers: buildHeaders(mode),
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

function extractDocument(html: string, headers: Record<string, string>, finalUrl: string) {
  const $ = cheerio.load(html);
  const extractionErrors: string[] = [];

  const title = textContent($("title").first().text()) || undefined;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() || undefined;
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
    undefined;

  const publicationDate =
    $('meta[property="article:published_time"]').attr("content")?.trim() ||
    $("time[datetime]").first().attr("datetime")?.trim() ||
    $('meta[name="date"]').attr("content")?.trim() ||
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

  const bodyTextLength = textContent($("body").text()).length;
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
    metaDescription,
    metaRobots,
    canonical,
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
  } satisfies ExtractedDocument;
}

function shouldTryBrowserFallback(extracted: ExtractedDocument) {
  return (
    extracted.wordCount === 0 &&
    extracted.headingCount === 0 &&
    extracted.paragraphCount === 0
  );
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
    browserFallbackTried,
    browserFallbackUsed,
    renderedContentLikelyRequired:
      !extracted.rawHtmlContainsArticleBody && extracted.rawHtmlContainsTitleText,
  };
}

export async function analyzeUrl(
  input: string,
  options: AnalyzeOptions = {},
): Promise<ScanResult> {
  const url = normalizeInputUrl(input);
  const initialFetch = await fetchWithTiming(url, "scanner");
  let response = initialFetch.response;
  let responseTimeMs = initialFetch.responseTimeMs;
  let html = await response.text();
  let finalUrl = response.url;
  let headers = toHeaderMap(response.headers);
  let extracted = extractDocument(html, headers, finalUrl);
  let fetchMode: FetchMode = "scanner";
  let browserFallbackTried = false;
  let browserFallbackUsed = false;

  if (shouldTryBrowserFallback(extracted)) {
    browserFallbackTried = true;

    try {
      const fallbackFetch = await fetchWithTiming(url, "browser-fallback");
      const fallbackResponse = fallbackFetch.response;
      const fallbackHtml = await fallbackResponse.text();
      const fallbackHeaders = toHeaderMap(fallbackResponse.headers);
      const fallbackExtracted = extractDocument(
        fallbackHtml,
        fallbackHeaders,
        fallbackResponse.url,
      );

      const fallbackIsBetter =
        fallbackExtracted.wordCount > extracted.wordCount ||
        fallbackExtracted.paragraphCount > extracted.paragraphCount ||
        fallbackExtracted.headingCount > extracted.headingCount;

      if (fallbackIsBetter) {
        response = fallbackResponse;
        responseTimeMs = fallbackFetch.responseTimeMs;
        html = fallbackHtml;
        finalUrl = fallbackResponse.url;
        headers = fallbackHeaders;
        extracted = fallbackExtracted;
        fetchMode = "browser-fallback";
        browserFallbackUsed = true;
      }
    } catch {
      extracted.extractionErrors.push("browser-fallback-fetch-failed");
    }
  }

  const finalParsedUrl = new URL(finalUrl);

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
      crawlAllowed = robots.isAllowed(finalUrl, SCAN_USER_AGENT);
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

  const context: ScanContext = {
    url,
    finalUrl,
    hostname: finalParsedUrl.hostname,
    responseTimeMs,
    statusCode: response.status,
    contentType: response.headers.get("content-type") ?? "",
    html,
    htmlLang: extracted.htmlLang,
    robotsTxt,
    robotsReachable,
    crawlAllowed,
    sitemapUrls,
    headers,
    title: extracted.title,
    metaDescription: extracted.metaDescription,
    metaRobots: extracted.metaRobots,
    xRobotsTag: headers["x-robots-tag"],
    canonical: extracted.canonical,
    hasViewport: extracted.hasViewport,
    h1Count: extracted.h1Count,
    mainH1Count: extracted.mainH1Count,
    mainHeadingText: extracted.mainHeadingText,
    headingCount: extracted.headingCount,
    paragraphCount: extracted.paragraphCount,
    averageParagraphLength: extracted.averageParagraphLength,
    wordCount: extracted.wordCount,
    hasMainContent: extracted.hasMainContent,
    authorText: extracted.authorText,
    publicationDate: extracted.publicationDate,
    socialLinks: extracted.socialLinks,
    schemaSameAsLinks: extracted.schemaSameAsLinks,
    externalPlatformLinks: extracted.externalPlatformLinks,
    schemaNodes: extracted.schemaNodes,
    schemaTypes: extracted.schemaTypes,
    organizationSchema: extracted.organizationSchema,
    personSchema: extracted.personSchema,
    articleSchema: extracted.articleSchema,
    publisherNameVisible: extracted.publisherNameVisible,
    domainBrandSignal: extracted.domainBrandSignal,
    organizationHasSameAs: extracted.organizationHasSameAs,
    articleHasPublisherReference: extracted.articleHasPublisherReference,
    articlePublisherMatchesOrganization: extracted.articlePublisherMatchesOrganization,
    redirectsFollowed: finalUrl === url ? 0 : 1,
  };

  const result = buildScanResult(context);

  if (options.debug) {
    result.debug = buildDebug(
      url,
      finalUrl,
      response.status,
      html,
      extracted,
      fetchMode,
      browserFallbackTried,
      browserFallbackUsed,
    );
  }

  return result;
}
