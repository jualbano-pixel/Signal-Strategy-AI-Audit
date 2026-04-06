import * as cheerio from "cheerio";
import robotsParser from "robots-parser";

import { buildScanResult } from "@/lib/scanner/engine";
import { JsonLdNode, ScanContext, ScanResult } from "@/lib/scanner/types";

const SCAN_USER_AGENT =
  "AI Readability Scanner/1.0 (+https://example.com/scanner)";

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
    ? value.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim()))
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

async function fetchWithTiming(url: string) {
  const started = performance.now();
  const response = await fetch(url, {
    headers: {
      "user-agent": SCAN_USER_AGENT,
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(10000),
  });
  const responseTimeMs = Math.round(performance.now() - started);

  return { response, responseTimeMs };
}

export async function analyzeUrl(input: string): Promise<ScanResult> {
  const url = normalizeInputUrl(input);
  const { response, responseTimeMs } = await fetchWithTiming(url);
  const html = await response.text();
  const headers = toHeaderMap(response.headers);
  const finalUrl = response.url;
  const finalParsedUrl = new URL(finalUrl);

  const $ = cheerio.load(html);

  const title = textContent($("title").first().text()) || undefined;
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() || undefined;
  const metaRobots =
    $('meta[name="robots"]').attr("content")?.trim() || undefined;
  const xRobotsTag = headers["x-robots-tag"];
  const canonical = $('link[rel="canonical"]').attr("href")?.trim();
  const htmlLang = $("html").attr("lang")?.trim();
  const hasViewport = Boolean($('meta[name="viewport"]').attr("content"));
  const h1Count = $("h1").length;
  const mainH1Count = $("main h1, article h1, [role='main'] h1").length;
  const mainHeadingText =
    textContent($("main h1, article h1, [role='main'] h1").first().text()) ||
    textContent($("h1").first().text()) ||
    undefined;
  const headingCount = $("h1, h2, h3, h4, h5, h6").length;

  const paragraphTexts = $("main p, article p, p")
    .toArray()
    .map((element) => textContent($(element).text()))
    .filter(Boolean);
  const paragraphCount = paragraphTexts.length;
  const wordCount = countWords(paragraphTexts.join(" "));
  const averageParagraphLength = paragraphCount
    ? Math.round(wordCount / paragraphCount)
    : 0;

  const hasMainContent =
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
  const articleSchema = schemaNodes.find((node) =>
    schemaTypeIncludes(node, "Article"),
  );
  const articlePublisherReference = readPublisherReference(articleSchema);
  const articlePublisherName = readString(articlePublisherReference?.name);
  const organizationName = readString(organizationSchema?.name);
  const siteName =
    $('meta[property="og:site_name"]').attr("content")?.trim() ||
    $('meta[name="application-name"]').attr("content")?.trim() ||
    "";
  const headerFooterText = `${$("header").first().text()} ${$("footer").first().text()}`;
  const hostTokens = hostnameBrandTokens(finalParsedUrl.hostname);
  const publisherNameVisible = Boolean(
    siteName ||
      headerFooterText.trim() ||
      organizationName,
  );
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

  const robotsUrl = new URL("/robots.txt", finalParsedUrl.origin).toString();
  let robotsTxt = "";
  let robotsReachable = false;
  let crawlAllowed: boolean | undefined;
  let sitemapUrls: string[] = [];

  try {
    const robotsResponse = await fetch(robotsUrl, {
      headers: { "user-agent": SCAN_USER_AGENT, accept: "text/plain,*/*;q=0.5" },
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
        headers: { "user-agent": SCAN_USER_AGENT, accept: "application/xml,text/xml,*/*;q=0.5" },
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
    htmlLang,
    robotsTxt,
    robotsReachable,
    crawlAllowed,
    sitemapUrls,
    headers,
    title,
    metaDescription,
    metaRobots,
    xRobotsTag,
    canonical,
    hasViewport,
    h1Count,
    mainH1Count,
    mainHeadingText,
    headingCount,
    paragraphCount,
    averageParagraphLength,
    wordCount,
    hasMainContent,
    authorText,
    publicationDate,
    socialLinks,
    schemaSameAsLinks,
    externalPlatformLinks,
    schemaNodes,
    schemaTypes,
    organizationSchema,
    personSchema,
    articleSchema,
    publisherNameVisible,
    domainBrandSignal,
    organizationHasSameAs,
    articleHasPublisherReference,
    articlePublisherMatchesOrganization,
    redirectsFollowed: finalUrl === url ? 0 : 1,
  };

  return buildScanResult(context);
}
