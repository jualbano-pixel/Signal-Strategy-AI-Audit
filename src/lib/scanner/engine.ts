import { RULES } from "@/lib/scanner/rules";
import {
  EvaluatedRule,
  PillarName,
  PillarResult,
  RuleDefinition,
  RuleStatus,
  ScanContext,
  ScanResult,
} from "@/lib/scanner/types";

const CRITICAL_RULES = new Set([
  "crawlability_allowed",
  "robots_accessible",
  "canonical_present",
  "sitemap_present",
]);

const MODERATE_RULES = new Set([
  "publisher_identity",
  "author_presence",
  "sameas_schema",
  "publication_date",
  "schema_presence",
  "schema_completeness",
  "content_depth",
]);

const LOW_VALUE_STRUCTURE_RULES = new Set([
  "h1_present",
  "heading_hierarchy",
  "paragraph_structure",
  "extractable_main_content",
]);

function includesDirective(value: string | undefined, needle: string) {
  return value?.toLowerCase().includes(needle) ?? false;
}

function normalizeUrl(input: string) {
  try {
    return new URL(input).toString();
  } catch {
    return new URL(`https://${input}`).toString();
  }
}

function hasStrongArticleStructure(context: ScanContext) {
  const articleSignals = [
    context.mainH1Count >= 1 || context.h1Count >= 1,
    Boolean(context.authorText),
    Boolean(context.publicationDate),
    context.paragraphCount >= 3,
    context.hasMainContent || Boolean(context.articleSchema),
  ];

  return articleSignals.filter(Boolean).length >= 4;
}

function normalizeWords(value: string | undefined) {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4);
}

function headingAlignsWithTopic(context: ScanContext) {
  const headingWords = new Set(normalizeWords(context.mainHeadingText));
  const titleWords = new Set(normalizeWords(context.title));

  let matches = 0;
  for (const word of headingWords) {
    if (titleWords.has(word)) {
      matches += 1;
    }
  }

  return matches >= 2 || (matches >= 1 && headingWords.size >= 3);
}

function severityPenalty(rule: EvaluatedRule) {
  if (rule.status === "pass") {
    return 0;
  }

  if (LOW_VALUE_STRUCTURE_RULES.has(rule.id)) {
    return rule.status === "fail" ? 1 : 0;
  }

  const multiplier = rule.status === "fail" ? 1 : 0.5;

  if (CRITICAL_RULES.has(rule.id)) {
    return Math.round(6 * multiplier);
  }

  if (MODERATE_RULES.has(rule.id)) {
    return Math.round(3 * multiplier);
  }

  return Math.round(1 * multiplier);
}

function interpretationPenalty(rule: EvaluatedRule) {
  if (rule.status === "pass") {
    return 0;
  }

  if (rule.id === "extractable_main_content") {
    return rule.status === "fail" ? 6 : 4;
  }

  if (rule.id === "author_byline" || rule.id === "author_presence") {
    return rule.status === "fail" ? 4 : 3;
  }

  if (rule.id === "publication_date") {
    return rule.status === "fail" ? 3 : 2;
  }

  if (rule.id === "content_depth") {
    return rule.status === "fail" ? 4 : 2;
  }

  if (rule.id === "html_structure") {
    return rule.status === "fail" ? 3 : 2;
  }

  if (LOW_VALUE_STRUCTURE_RULES.has(rule.id)) {
    return rule.status === "fail" ? 1 : 0;
  }

  return severityPenalty(rule);
}

function attributionPenalty(rule: EvaluatedRule) {
  if (rule.status === "pass") {
    return 0;
  }

  if (rule.id === "publisher_identity") {
    return rule.status === "fail" ? 6 : 5;
  }

  if (rule.id === "author_presence") {
    return rule.status === "fail" ? 4 : 3;
  }

  if (rule.id === "sameas_schema" || rule.id === "social_profile_links") {
    return rule.status === "fail" ? 3 : 2;
  }

  return severityPenalty(rule);
}

function pillarPenalty(pillar: PillarName, rules: EvaluatedRule[]) {
  if (pillar === "INTERPRETATION") {
    return rules.reduce((sum, rule) => sum + interpretationPenalty(rule), 0);
  }

  if (pillar === "ATTRIBUTION") {
    return rules.reduce((sum, rule) => sum + attributionPenalty(rule), 0);
  }

  return rules.reduce((sum, rule) => sum + severityPenalty(rule), 0);
}

function pillarCap(pillar: PillarName, rules: EvaluatedRule[]) {
  if (pillar === "INTERPRETATION") {
    const interpretationProblems = [
      "extractable_main_content",
      "author_byline",
      "publication_date",
      "content_depth",
      "html_structure",
    ].filter((id) => rules.some((rule) => rule.id === id && rule.status !== "pass")).length;

    if (interpretationProblems >= 2) {
      return 15;
    }
  }

  if (pillar === "ATTRIBUTION") {
    const publisherUnclear = rules.some(
      (rule) => rule.id === "publisher_identity" && rule.status !== "pass",
    );
    const authorUnclear = rules.some(
      (rule) => rule.id === "author_presence" && rule.status !== "pass",
    );

    if (publisherUnclear && authorUnclear) {
      return 17;
    }
  }

  return 25;
}

function withRuleCopy(
  rule: RuleDefinition,
  updates: Partial<
    Pick<
      EvaluatedRule,
      "message" | "explanation" | "impact" | "whatToDo" | "howToDoIt" | "assignments"
    >
  >,
) {
  return {
    ...rule,
    ...updates,
  };
}

function evaluateRule(rule: RuleDefinition, context: ScanContext): EvaluatedRule {
  let status: RuleStatus = "warn";
  let details = "";
  let resolvedRule = rule;

  switch (rule.id) {
    case "robots_accessible":
      status = context.robotsReachable ? "pass" : "fail";
      details = context.robotsReachable
        ? "robots.txt is reachable."
        : "robots.txt could not be fetched.";
      break;
    case "crawlability_allowed":
      status =
        context.crawlAllowed === false
          ? "fail"
          : context.crawlAllowed === true
            ? "pass"
            : "warn";
      details =
        context.crawlAllowed === true
          ? "The current page path appears crawlable."
          : context.crawlAllowed === false
            ? "The current page path appears blocked by robots rules."
            : "Crawlability could not be confirmed from robots.txt.";
      break;
    case "meta_noindex_present": {
      const hasNoindex =
        includesDirective(context.metaRobots, "noindex") ||
        includesDirective(context.xRobotsTag, "noindex");
      status = hasNoindex ? "fail" : "pass";
      details = hasNoindex
        ? "A noindex directive was detected."
        : "No noindex directive was detected.";
      break;
    }
    case "snippet_eligibility": {
      const hasPreviewLimits =
        includesDirective(context.metaRobots, "nosnippet") ||
        includesDirective(context.xRobotsTag, "nosnippet") ||
        includesDirective(context.metaRobots, "max-snippet:0") ||
        includesDirective(context.xRobotsTag, "max-snippet:0");
      status = hasPreviewLimits ? "fail" : "pass";
      details = hasPreviewLimits
        ? "Snippet-limiting directives were found."
        : "No strong snippet restrictions were found.";
      break;
    }
    case "sitemap_present":
      status =
        context.sitemapUrls.length > 0
          ? "pass"
          : context.robotsReachable
            ? "fail"
            : "warn";
      details =
        context.sitemapUrls.length > 0
          ? `Found ${context.sitemapUrls.length} sitemap signal${context.sitemapUrls.length === 1 ? "" : "s"}.`
          : "No sitemap signal was found.";
      break;
    case "canonical_present":
      status = context.canonical ? "pass" : "fail";
      details = context.canonical
        ? `Canonical points to ${context.canonical}.`
        : "No canonical tag was found.";
      break;
    case "h1_present":
      status =
        context.mainH1Count === 1 && headingAlignsWithTopic(context)
          ? "pass"
        : context.h1Count >= 1
          ? "warn"
          : "fail";
      details =
        context.mainH1Count === 1 && headingAlignsWithTopic(context)
          ? `A clear main heading was found: ${context.mainHeadingText ?? "present"}.`
          : context.h1Count >= 1
            ? `The scan found ${context.h1Count} H1 tag${context.h1Count === 1 ? "" : "s"}, but the main heading is not clearly aligned with the page topic in the primary content area.`
            : "One main H1 heading is not clearly defined.";
      break;
    case "heading_hierarchy":
      status =
        context.headingCount >= 4 &&
        (Boolean(context.authorText) || Boolean(context.publicationDate)) &&
        context.wordCount >= 300
          ? "pass"
        : context.headingCount >= 2
          ? "warn"
            : "warn";
      details = `Found ${context.headingCount} heading${context.headingCount === 1 ? "" : "s"} in total.`;
      break;
    case "paragraph_structure":
      status =
        context.paragraphCount >= 3 &&
        context.averageParagraphLength <= 120 &&
        context.wordCount >= 300 &&
        hasStrongArticleStructure(context)
          ? "pass"
        : context.paragraphCount >= 2
          ? "warn"
            : "warn";
      details = `Found ${context.paragraphCount} paragraph${context.paragraphCount === 1 ? "" : "s"} with an average length of ${context.averageParagraphLength} words.`;
      break;
    case "extractable_main_content":
      status =
        context.hasMainContent && (hasStrongArticleStructure(context) || context.wordCount >= 300)
          ? "pass"
          : context.hasMainContent
            ? "warn"
            : "warn";
      details = context.hasMainContent
        ? "Main content containers are present."
        : "A strong main or article container is not clearly defined.";
      break;
    case "author_byline":
      status =
        context.authorText && (Boolean(context.publicationDate) || context.wordCount >= 250)
          ? "pass"
          : context.authorText
            ? "warn"
            : "warn";
      details = context.authorText
        ? `Author signal found: ${context.authorText}.`
        : "No clear author byline was found.";
      break;
    case "publication_date":
      status = context.publicationDate ? "pass" : "fail";
      details = context.publicationDate
        ? `Date signal found: ${context.publicationDate}.`
        : "No publish or update date was found.";
      break;
    case "content_depth":
      if (hasStrongArticleStructure(context)) {
        status =
          context.wordCount >= 350
            ? "pass"
            : context.wordCount >= 180
              ? "warn"
              : "fail";
        details = `The scan found about ${context.wordCount} words of extractable article text, with strong article structure signals present.`;

        if (context.wordCount < 350) {
          resolvedRule = withRuleCopy(rule, {
            message:
              context.wordCount < 180
                ? "The scan found very little extractable article text"
                : "Extractable article text appears shorter than expected",
            explanation:
              context.wordCount < 180
                ? "The page has article-like structure, but the scan could only confirm a small amount of body text."
                : "The page has article-like structure, but the amount of extractable body text is lower than expected for a fuller article.",
            impact:
              context.wordCount < 180
                ? "When very little body text can be extracted, machines have less context to understand, summarize, or reuse the article accurately."
                : "Shorter extractable body text can limit how much context machines can pull from the page, even when the article structure is clear.",
            whatToDo:
              context.wordCount < 180
                ? "Check whether the article body is fully visible and extractable."
                : "Consider adding a little more extractable article text if the page should carry deeper context.",
            howToDoIt:
              context.wordCount < 180
                ? [
                    "Make sure the main article text appears in normal page HTML and not only in harder-to-detect page elements.",
                    "Confirm that the article body is inside a clear main content area with readable paragraphs.",
                    "If the article is intentionally brief, treat this as a light caution rather than a serious problem.",
                  ]
                : [
                    "If this page should provide deeper context, add a bit more body text, examples, or supporting detail.",
                    "Keep the article text inside a clear main content area with readable paragraphs.",
                    "If this is a short editorial piece or news update, treat this as a mild signal rather than a major issue.",
                  ],
            assignments:
              context.wordCount < 180
                ? [
                    {
                      role: "Editorial / Content",
                      responsibility:
                        "Check whether the published article includes the full intended body text and enough context for readers.",
                    },
                    {
                      role: "Developer",
                      responsibility:
                        "Verify that the article body is exposed in a clear, extractable content area in the page HTML.",
                    },
                  ]
                : [
                    {
                      role: "Editorial / Content",
                      responsibility:
                        "Decide whether this article should include more body text, examples, or supporting context.",
                    },
                  ],
          });
        }
      } else {
        status =
          context.wordCount >= 700
            ? "pass"
            : context.wordCount >= 300
              ? "warn"
              : "fail";
        details = `Estimated extractable body copy: ${context.wordCount} words.`;
        if (context.wordCount < 700) {
          resolvedRule = withRuleCopy(rule, {
            message:
              context.wordCount < 300
                ? "The scan found less extractable body text than expected"
                : "Content depth may be limited for machine extraction",
            explanation:
              context.wordCount < 300
                ? "The scan could only confirm a small amount of extractable body text, and article structure signals are not especially strong."
                : "The page includes some body text, but the amount of extractable content may be limited for stronger machine understanding.",
            impact:
              context.wordCount < 300
                ? "When a page has both limited body text and weak structure, machines have less context to understand what the page is really about."
                : "Limited extractable text can reduce context for machines, especially when the page is not clearly structured like an article.",
            whatToDo:
              context.wordCount < 300
                ? "Add more useful body text and strengthen the page structure."
                : "Consider adding more clear body text if this page should carry more explanatory depth.",
            howToDoIt:
              context.wordCount < 300
                ? [
                    "Add more helpful text that explains the page topic in plain language.",
                    "Use headings and paragraphs so the main content is easier to extract.",
                    "Keep the most important information in the main content area, not only in sidebars or widgets.",
                  ]
                : [
                    "Add more explanatory text if this page is meant to answer questions or provide deeper detail.",
                    "Use headings and paragraphs to make the body text easier to extract.",
                    "Keep the main text in a clear content area so machines can isolate it more reliably.",
                  ],
            assignments:
              context.wordCount < 300
                ? [
                    {
                      role: "Editorial / Content",
                      responsibility:
                        "Add more useful body text that explains the page topic clearly.",
                    },
                    {
                      role: "Developer",
                      responsibility:
                        "Make sure the page layout exposes the main text in a clear content area.",
                    },
                  ]
                : [
                    {
                      role: "Editorial / Content",
                      responsibility:
                        "Decide whether this page should carry more detail or supporting explanation.",
                    },
                  ],
          });
        }
      }
      break;
    case "publisher_identity":
      if (
        context.organizationSchema &&
        context.articleHasPublisherReference &&
        context.articlePublisherMatchesOrganization &&
        context.organizationHasSameAs
      ) {
        status = "pass";
        details =
          "Publisher details are present, connected to the article, and supported by profile links.";
      } else if (!context.organizationSchema && !context.publisherNameVisible) {
        status = "warn";
        details =
          "Publisher details are not consistently detected in visible content and site code.";
        resolvedRule = withRuleCopy(rule, {
          message: "Publisher identity is not clearly defined",
          explanation:
            "The page does not define one consistent publisher across visible publisher details and site code.",
          impact:
            "Machines rely on consistent identity details to attribute content to a source. Without this, attribution is weaker and less consistent across platforms.",
          visibleLayer:
            "Publisher details like name, logo, or About-page links are not consistently shown on the page.",
          machineLayer:
            "Article markup and site code do not define one clear publisher record with official profile links.",
          whatToDo: "Define publisher details clearly on the page and in the site code.",
          howToDoIt: [
            "Add the publisher name in the page header, footer, or article area.",
            "Add a logo and link to an About or publisher page.",
            "Add the same publisher details in the site code, including official profile links.",
          ],
          assignments: [
            {
              role: "Brand / Marketing",
              responsibility: "Confirm the official publisher name, logo, and profile links that should represent the brand.",
            },
            {
              role: "Developer",
              responsibility: "Make sure those publisher details are exposed clearly in the page code and tied to the article page.",
            },
          ],
        });
      } else if (
        context.organizationSchema &&
        (!context.organizationHasSameAs || !context.articleHasPublisherReference)
      ) {
        status = "warn";
        details =
          "Publisher details exist, but the article-to-publisher connection is not fully defined.";
        resolvedRule = withRuleCopy(rule, {
          message: "Publisher identity is not clearly defined",
          explanation:
            "Publisher details exist, but this article does not define them consistently enough across visible content and site code.",
          impact:
            "Machines rely on consistent publisher details to attribute content to a source. Without a complete article-to-publisher link, attribution is less reliable.",
          visibleLayer:
            "The publisher may be visible on the site, but the article page does not define that publisher clearly enough.",
          machineLayer:
            "The article markup does not fully connect to the sitewide publisher record and official profile links.",
          whatToDo: "Define the publisher relationship for this article page.",
          howToDoIt: [
            "Confirm the publisher name and logo shown on the page.",
            "Add a publisher reference in the article markup that points to the existing publisher record.",
            "Add official profile links in the site code if they are not already defined.",
          ],
          assignments: [
            {
              role: "Brand / Marketing",
              responsibility: "Confirm which publisher details and official profile links should appear for this brand.",
            },
            {
              role: "Developer",
              responsibility: "Check whether the article page points to the existing publisher details in the page code.",
            },
          ],
        });
      } else if (
        context.organizationSchema &&
        context.articleSchema &&
        !context.articleHasPublisherReference
      ) {
        status = "warn";
        details =
          "Publisher details exist sitewide, but this article does not point back to them consistently.";
        resolvedRule = withRuleCopy(rule, {
          message: "Publisher identity is not clearly defined",
          explanation:
            "Publisher details exist sitewide, but this article page does not consistently tie back to them in article markup.",
          impact:
            "Machines use article markup to connect a page to its source. Without that link, attribution is less consistent from page to page.",
          visibleLayer:
            "Publisher details are defined elsewhere on the site, but this article does not make that connection clear enough.",
          machineLayer:
            "The article markup does not point to the same publisher record used sitewide.",
          whatToDo: "Connect this article page to the existing publisher details.",
          howToDoIt: [
            "Confirm the publisher name used on the article page matches the brand name used across the site.",
            "Add a publisher reference in the article markup that points to the same publisher record used sitewide.",
            "Define the same official profile links in the publisher record used by the article page.",
          ],
          assignments: [
            {
              role: "Brand / Marketing",
              responsibility: "Confirm the publisher name used on the page matches the one used across the site.",
            },
            {
              role: "Developer",
              responsibility: "Tie the article page back to the existing publisher record in the page code.",
            },
          ],
        });
      } else if (context.publisherNameVisible || context.domainBrandSignal) {
        status = "warn";
        details =
          "Visible publisher details were found, but the site code does not define them consistently.";
        resolvedRule = withRuleCopy(rule, {
          message: "Publisher identity is not clearly defined",
          explanation:
            "Visible publisher details are present, but the site code does not consistently connect them to the article.",
          impact:
            "Machines rely on both visible publisher details and site code to attribute content to a source. Without both, attribution is weaker.",
          visibleLayer:
            "Publisher branding is visible on the page, but the article does not define it strongly enough as the source.",
          machineLayer:
            "The site code does not connect the article to the same publisher details and profile links.",
          whatToDo: "Connect visible publisher details to the article markup and site code.",
          howToDoIt: [
            "Keep the publisher name and branding visible on the page, header, or footer.",
            "Add a publisher reference in the article markup that points to the sitewide publisher record.",
            "Define official profile links in the site code so the publisher can be linked across platforms.",
          ],
          assignments: [
            {
              role: "Brand / Marketing",
              responsibility: "Check that the visible publisher name and brand signals are clear on the page.",
            },
            {
              role: "Developer",
              responsibility: "Verify that the article code includes the publisher reference and official profile links in a detectable way.",
            },
          ],
        });
      } else {
        status = "warn";
        details =
          "Publisher details are not consistently detected in visible content and site code.";
        resolvedRule = withRuleCopy(rule, {
          message: "Publisher identity is not clearly defined",
          explanation:
            "Publisher details are not consistently defined across visible content and site code.",
          impact:
            "Machines rely on consistent identity details to attribute content to a source. Without that consistency, attribution is weaker across platforms.",
          visibleLayer:
            "Visible publisher details are not defined consistently enough across the page.",
          machineLayer:
            "The site code does not define one clear publisher record with matching article markup and profile links.",
          whatToDo: "Define publisher details more consistently on the page and in the site code.",
          howToDoIt: [
            "Confirm the publisher name, logo, and About page link used on the page.",
            "Add a publisher reference in the article markup and define the same publisher in the site code.",
            "Add official profile links in the publisher record used by the page.",
          ],
          assignments: [
            {
              role: "Brand / Marketing",
              responsibility: "Define the official publisher name, logo, and profile links used by the brand.",
            },
            {
              role: "Developer",
              responsibility: "Add those publisher details consistently in article markup and site code.",
            },
          ],
        });
      }
      break;
    case "author_presence":
      status =
        context.personSchema || context.authorText
          ? context.personSchema && context.authorText
            ? "pass"
            : "warn"
          : "fail";
      details =
        context.personSchema || context.authorText
          ? "Author information is present, but not fully defined across the page and site code."
          : "Author information is not clearly defined in the page and site code.";
      break;
    case "social_profile_links":
      status =
        context.socialLinks.length >= 2 ||
        context.schemaSameAsLinks.length >= 2
          ? "pass"
          : context.socialLinks.length === 1 || context.schemaSameAsLinks.length === 1
            ? "warn"
            : "warn";
      details = `Found ${context.socialLinks.length} visible social/profile link${context.socialLinks.length === 1 ? "" : "s"} and ${context.schemaSameAsLinks.length} machine-readable profile link${context.schemaSameAsLinks.length === 1 ? "" : "s"}.`;
      break;
    case "sameas_schema": {
      const hasSameAs = context.schemaNodes.some((node) => {
        const sameAs = node.sameAs;
        return Array.isArray(sameAs) && sameAs.length > 0;
      });
      status = hasSameAs ? "pass" : context.socialLinks.length > 0 ? "warn" : "warn";
      details = hasSameAs
        ? "sameAs links were found in structured data."
        : context.socialLinks.length > 0
          ? "Visible profile links were found, but matching profile links are not consistently defined in the site code."
          : "Machine-readable profile links are not clearly defined in the site code.";
      break;
    }
    case "external_platform_mentions":
      status =
        context.externalPlatformLinks.length >= 3
          ? "pass"
          : context.externalPlatformLinks.length >= 1
            ? "warn"
            : "fail";
      details = `Found ${context.externalPlatformLinks.length} outbound link${context.externalPlatformLinks.length === 1 ? "" : "s"} to external platforms.`;
      break;
    case "schema_presence":
      status = context.schemaNodes.length > 0 ? "pass" : "fail";
      details =
        context.schemaNodes.length > 0
          ? `Found ${context.schemaNodes.length} JSON-LD block${context.schemaNodes.length === 1 ? "" : "s"}.`
          : "No JSON-LD blocks were found.";
      break;
    case "schema_completeness": {
      const hasCoreCoverage =
        Boolean(context.articleSchema) &&
        Boolean(context.organizationSchema || context.personSchema);
      status =
        hasCoreCoverage &&
        Boolean(context.authorText || context.personSchema) &&
        Boolean(context.canonical)
          ? "pass"
          : context.schemaNodes.length > 0
            ? "warn"
            : "warn";
      details = hasCoreCoverage
        ? "Structured data covers the page and identity layer."
        : "Structured data coverage is partial and some page details are not consistently defined.";
      break;
    }
    case "mobile_viewport":
      status = context.hasViewport ? "pass" : "warn";
      details = context.hasViewport
        ? "A mobile viewport tag is present."
        : "No mobile viewport tag was found.";
      break;
    case "basic_performance":
      status =
        context.responseTimeMs <= 1200
          ? "pass"
          : context.responseTimeMs <= 2500
            ? "warn"
            : "fail";
      details = `Initial response time was ${context.responseTimeMs}ms.`;
      break;
    case "html_structure": {
      const hasBasics =
        Boolean(context.title) &&
        Boolean(context.metaDescription) &&
        Boolean(context.htmlLang);
      status = hasBasics ? "pass" : "warn";
      details = `Title: ${context.title ? "yes" : "no"}, description: ${context.metaDescription ? "yes" : "no"}, html lang: ${context.htmlLang ? "yes" : "no"}.`;
      break;
    }
    case "redirect_health":
      status =
        context.statusCode >= 200 &&
        context.statusCode < 300 &&
        context.redirectsFollowed <= 1
          ? "pass"
          : context.statusCode >= 200 && context.statusCode < 400
            ? "warn"
            : "fail";
      details = `Resolved with status ${context.statusCode} after ${context.redirectsFollowed} redirect${context.redirectsFollowed === 1 ? "" : "s"}.`;
      break;
    default:
      status = "warn";
      details = "Rule was not evaluated.";
  }

  const score =
    status === "pass" ? rule.weight : status === "warn" ? Math.ceil(rule.weight / 3) : 0;

  return {
    ...resolvedRule,
    status,
    score,
    details,
  };
}

function buildPillarSummary(name: PillarName, rules: EvaluatedRule[]) {
  const failed = rules.filter((rule) => rule.status === "fail");
  const warned = rules.filter((rule) => rule.status === "warn");

  if (failed.length === 0 && warned.length === 0) {
    return `${name.replaceAll("_", " ")} is in strong shape overall.`;
  }

  const topProblem = [...failed, ...warned].sort((a, b) => b.weight - a.weight)[0];
  return `${name.replaceAll("_", " ")} is mainly limited by ${topProblem.component.toLowerCase()}.`;
}

function pillarConfidence(score: number): "HIGH" | "MEDIUM" | "LOW" {
  if (score >= 20) return "HIGH";
  if (score >= 14) return "MEDIUM";
  return "LOW";
}

function dedupeByRootCause(rules: EvaluatedRule[]) {
  const severityRank = { high: 3, medium: 2, low: 1 };
  const seen = new Map<string, EvaluatedRule>();

  for (const rule of rules) {
    const key = rule.rootCause ?? rule.id;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, rule);
      continue;
    }

    const currentScore =
      severityRank[rule.severity] * 100 + rule.weight * 10 - rule.score;
    const existingScore =
      severityRank[existing.severity] * 100 + existing.weight * 10 - existing.score;

    if (currentScore > existingScore) {
      seen.set(key, rule);
    }
  }

  return [...seen.values()];
}

function buildSignalsSummary(rules: EvaluatedRule[]) {
  const detected = rules
    .filter((rule) => rule.status === "pass")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map((rule) => {
      switch (rule.id) {
        case "publisher_identity":
          return "Publisher details were clearly detected.";
        case "author_presence":
        case "author_byline":
          return "Author details were detected.";
        case "sameas_schema":
          return "Machine-readable profile links were detected.";
        case "social_profile_links":
          return "Visible profile links were detected.";
        case "schema_presence":
          return "Machine-readable page details were detected.";
        case "schema_completeness":
          return "Page details in code look well connected.";
        case "html_structure":
          return "Page title, description, and language were defined.";
        case "h1_present":
          return "A clear main heading was detected.";
        case "heading_hierarchy":
          return "Section headings were detected.";
        case "paragraph_structure":
          return "Readable paragraph structure was detected.";
        case "extractable_main_content":
          return "A clear main content area was detected.";
        case "crawlability_allowed":
          return "The page is crawlable.";
        case "meta_noindex_present":
          return "No instruction hiding the page from search was detected.";
        default:
          return rule.details;
      }
    });

  const unclear = rules
    .filter((rule) => rule.status !== "pass")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 4)
    .map((rule) => {
      switch (rule.id) {
        case "publisher_identity":
          return "Publisher details are not fully connected to this page.";
        case "author_presence":
          return "Author identity was not strongly confirmed.";
        case "sameas_schema":
          return "Machine-readable profile links were not clearly confirmed.";
        case "social_profile_links":
          return "Visible or machine-readable profile links were only partly confirmed.";
        case "schema_completeness":
          return "Machine-readable page details look partial or unclear.";
        case "html_structure":
          return "Page title, meta description, or language is not consistently defined.";
        case "h1_present":
          return "One clear main heading was not strongly confirmed.";
        case "heading_hierarchy":
          return "Section structure could be clearer.";
        case "paragraph_structure":
          return "Paragraph structure could be easier to scan.";
        case "extractable_main_content":
          return "The main content area was not clearly isolated.";
        default:
          return rule.message;
      }
    });

  return { detected, unclear };
}

function overallStatus(
  totalScore: number,
  pillars: PillarResult[],
): Pick<ScanResult, "status" | "status_reason"> {
  const lowPillars = pillars.filter((pillar) => pillar.confidence === "LOW");
  const mediumPillars = pillars.filter((pillar) => pillar.confidence === "MEDIUM");
  const criticalCompromised = pillars.filter(
    (pillar) =>
      (pillar.name === "FINDABILITY" || pillar.name === "DELIVERY") &&
      pillar.confidence !== "HIGH",
  );

  if (lowPillars.length >= 2 || totalScore < 40) {
    return {
      status: "Failing",
      status_reason: `Low machine confidence in ${lowPillars.map((pillar) => pillar.name).join(" and ") || "multiple pillars"}.`,
    };
  }

  if (lowPillars.length >= 1 || criticalCompromised.length >= 1) {
    const cause = lowPillars[0]?.name ?? criticalCompromised[0]?.name ?? "a critical pillar";
    return {
      status: "At Risk",
      status_reason: `${cause} is reducing reliable machine use of this page.`,
    };
  }

  if (totalScore >= 80 && pillars.every((pillar) => pillar.confidence === "HIGH")) {
    return {
      status: "AI-Ready",
      status_reason: "All four pillars are functioning with high machine confidence.",
    };
  }

  if (mediumPillars.length >= 1) {
    return {
      status: "AI-Ready with Gaps",
      status_reason: `${mediumPillars.map((pillar) => pillar.name).join(", ")} needs stronger machine confidence.`,
    };
  }

  return {
    status: "At Risk",
    status_reason: "Machine confidence is inconsistent across the pillar set.",
  };
}

function buildExplanation(pillars: PillarResult[]) {
  const strongest = [...pillars].sort((a, b) => b.score - a.score)[0];
  const weakest = [...pillars].sort((a, b) => a.score - b.score)[0];

  return `This page is strongest in ${strongest.name.replaceAll("_", " ").toLowerCase()} and weakest in ${weakest.name.replaceAll("_", " ").toLowerCase()}. The score reflects machine readability, crawlability, attribution, and structural clarity rather than ranking or guaranteed inclusion.`;
}

export function buildScanResult(context: ScanContext): ScanResult {
  const evaluatedRules = RULES.map((rule) => evaluateRule(rule, context));

  const pillars: PillarResult[] = ([
    "FINDABILITY",
    "INTERPRETATION",
    "ATTRIBUTION",
    "DELIVERY",
  ] as const).map((pillar) => {
    const pillarRules = evaluatedRules.filter((rule) => rule.pillar === pillar);
    const baseScore = 25;
    const penalty = pillarPenalty(pillar, pillarRules);
    const criticalCount = pillarRules.filter(
      (rule) => rule.status !== "pass" && CRITICAL_RULES.has(rule.id),
    ).length;
    const stackingPenalty = criticalCount > 1 ? (criticalCount - 1) * 2 : 0;
    const uncappedScore = Math.max(0, baseScore - penalty - stackingPenalty);
    const score = Math.min(uncappedScore, pillarCap(pillar, pillarRules));

    return {
      name: pillar,
      score,
      confidence: pillarConfidence(score),
      issues: pillarRules.filter((rule) => rule.status !== "pass"),
      summary: buildPillarSummary(pillar, pillarRules),
      ...buildSignalsSummary(pillarRules),
    };
  });

  const totalScore = pillars.reduce((sum, pillar) => sum + pillar.score, 0);
  const { status, status_reason } = overallStatus(totalScore, pillars);
  const prioritized = dedupeByRootCause(
    evaluatedRules
    .filter((rule) => rule.status !== "pass")
    .sort((a, b) => {
      const severityRank = { high: 3, medium: 2, low: 1 };
      return (
        severityRank[b.severity] - severityRank[a.severity] ||
        b.weight - a.weight ||
        a.id.localeCompare(b.id)
      );
    }),
  );

  return {
    url: normalizeUrl(context.url),
    total_score: Math.round(totalScore),
    status,
    status_reason,
    pillars,
    top_issues: prioritized.slice(0, 5),
    quick_wins: prioritized
      .slice(0, 3)
      .map((rule) => rule.whatToDo)
      .filter(Boolean),
    explanation: buildExplanation(pillars),
    scanned_at: new Date().toISOString(),
  };
}
