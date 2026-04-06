"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

import type { ScanResult } from "@/lib/scanner/types";

const glossary = {
  publisherSignals:
    "Publisher signals are the clues that tell machines who created this content. This includes things like your site name, logo, and links to your official profiles.",
  authorIdentity:
    "Author identity is how clearly a page shows who wrote it and who that person is.",
  structuredData:
    "Structured data is extra code on your page that explains your content in a way machines can easily understand. Think of it as labels that tell machines: this is the title, this is the author, this is the publisher.",
  sameAsLinks:
    "sameAs links are links that connect your site or author to your official profiles on other platforms, like LinkedIn or Twitter.",
  crawlability:
    "Crawlability means whether search engines and AI systems can access and read your page.",
  indexability:
    "Indexability means whether your page is allowed to appear in search results.",
  snippet:
    "A snippet is the short preview of your page that shows up in search results.",
  contentStructure:
    "Content structure is how your page is organized — headings, paragraphs, and sections.",
  thinContent:
    "Thin content means the page doesn’t have enough useful information to be clearly understood or reused.",
  crossPlatformPresence:
    "Cross-platform presence means how well your content and identity show up beyond your own website, such as connections to profiles or mentions on other platforms.",
} as const;

const pillarDescriptions: Record<string, string> = {
  FINDABILITY: "Can machines locate and surface this page.",
  INTERPRETATION: "Can machines correctly interpret what this page is about.",
  ATTRIBUTION: "Can machines connect this page to a known source.",
  DELIVERY: "Can machines retrieve and process this page efficiently.",
};

const pillarHelpers: Record<string, string> = {
  FINDABILITY: `${glossary.crawlability} ${glossary.indexability} ${glossary.snippet}`,
  INTERPRETATION: `${glossary.contentStructure} ${glossary.thinContent}`,
  ATTRIBUTION: `${glossary.crossPlatformPresence} ${glossary.publisherSignals} ${glossary.authorIdentity}`,
  DELIVERY: `${glossary.structuredData} ${glossary.sameAsLinks}`,
};

function contextualGlossary(issueId: string) {
  if (issueId === "publisher_identity") {
    return glossary.publisherSignals;
  }

  if (issueId === "author_presence" || issueId === "author_byline") {
    return glossary.authorIdentity;
  }

  if (issueId === "sameas_schema") {
    return glossary.sameAsLinks;
  }

  if (issueId === "schema_presence" || issueId === "schema_completeness") {
    return glossary.structuredData;
  }

  if (
    issueId === "h1_present" ||
    issueId === "heading_hierarchy" ||
    issueId === "paragraph_structure" ||
    issueId === "extractable_main_content"
  ) {
    return glossary.contentStructure;
  }

  if (issueId === "content_depth") {
    return glossary.thinContent;
  }

  if (issueId === "crawlability_allowed" || issueId === "robots_accessible") {
    return glossary.crawlability;
  }

  if (issueId === "meta_noindex_present") {
    return glossary.indexability;
  }

  if (issueId === "snippet_eligibility") {
    return glossary.snippet;
  }

  return null;
}

function scoreTone(score: number) {
  if (score >= 85) return "bg-accent-soft text-accent";
  if (score >= 70) return "bg-[#edf6ff] text-[#205c99]";
  if (score >= 50) return "bg-[#fff3da] text-[#8c5a00]";
  return "bg-[#fde4de] text-danger";
}

function issueTone(status: "pass" | "warn" | "fail") {
  if (status === "fail") return "border-danger/20 bg-danger/7 text-danger";
  if (status === "warn") return "border-warn/20 bg-warn/8 text-warn";
  return "border-accent/20 bg-accent/8 text-accent";
}

function statusDescription(status: ScanResult["status"]) {
  if (status === "AI-Ready") {
    return "This page gives machines clear publisher details, author information, and content context.";
  }

  if (status === "AI-Ready with Gaps") {
    return "This page is readable, but missing publisher details, author information, or metadata are limiting machine understanding.";
  }

  if (status === "At Risk") {
    return "This page has a weak pillar that is reducing reliable machine understanding or access.";
  }

  return "This page is not reliably usable by machines across multiple core pillars.";
}

export default function Home() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const resultRef = useRef<HTMLElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const resultsMode = Boolean(result || loading);

  const topFixes = useMemo(() => result?.quick_wins ?? [], [result]);

  const subtitleMarkup = (
    <div className="mt-2 space-y-1 text-ink-soft">
      <p className="text-inherit">What machines see</p>
      <p className="text-sm font-medium uppercase tracking-[0.18em] text-foreground/55 sm:text-base">
        vs
      </p>
      <p className="text-inherit">what you think they see</p>
    </div>
  );

  useEffect(() => {
    if (result && resultRef.current) {
      resultRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [result]);

  function buildReport(scan: ScanResult) {
    const pillarLines = scan.pillars.map(
      (pillar) => `- ${pillar.name.replaceAll("_", " ")}: ${pillar.score}/25`,
    );

    const issueLines = scan.top_issues.map((issue, index) => {
      const howToDoIt = issue.howToDoIt.map((step) => `  - ${step}`).join("\n");

      return [
        `${index + 1}. ${issue.message}`,
        `What this means: ${issue.explanation}`,
        ...(issue.visibleLayer ? [`Visible layer: ${issue.visibleLayer}`] : []),
        ...(issue.machineLayer ? [`Machine-readable layer: ${issue.machineLayer}`] : []),
        `Why this matters for AI systems: ${issue.impact}`,
        `What to do: ${issue.whatToDo}`,
        "How to do it:",
        howToDoIt,
        "Who does what:",
        ...(issue.assignments?.map(
          (assignment) => `- ${assignment.role} -> ${assignment.responsibility}`,
        ) ?? ["- Team review -> Review this issue together and assign the next step."]),
      ].join("\n");
    });

    return [
      "AI Readability Scanner Report",
      "",
      `URL scanned: ${scan.url}`,
      `Overall score: ${scan.total_score}/100`,
      `Status: ${scan.status}`,
      "",
      "Pillar Scores",
      ...pillarLines,
      "",
      "Top Issues",
      ...(issueLines.length > 0
        ? issueLines
        : ["No major issues were flagged in this scan."]),
    ].join("\n");
  }

  async function handleCopyReport() {
    if (!result) {
      return;
    }

    try {
      await navigator.clipboard.writeText(buildReport(result));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2500);
    }
  }

  function handleNewScan() {
    setResult(null);
    setError(null);
    setCopyState("idle");

    window.requestAnimationFrame(() => {
      inputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });

      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 250);
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setCopyState("idle");

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url }),
      });

      const payload = (await response.json()) as ScanResult | { error: string };

      if (!response.ok || "error" in payload) {
        throw new Error(
          "error" in payload ? payload.error : "The scan could not be completed.",
        );
      }

      setResult(payload);
    } catch (scanError) {
      setResult(null);
      setError(
        scanError instanceof Error
          ? scanError.message
          : "The scan could not be completed.",
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col px-5 py-8 sm:px-8 lg:px-10">
      <section
        className={`fade-up ${resultsMode ? "space-y-3" : "grid gap-6 lg:grid-cols-[1.1fr_0.9fr] lg:items-center"}`}
      >
        <div
          className={`rounded-[2rem] border border-line bg-surface-strong/80 shadow-[0_20px_60px_rgba(84,63,35,0.08)] transition-all ${
            resultsMode ? "space-y-4 p-4 sm:p-5" : "space-y-6 p-7 sm:p-10"
          }`}
        >
          {resultsMode ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-foreground/55">
                  Signal Strategy · Diagnostic
                </p>
                <h1 className="mt-1 font-display text-3xl leading-tight text-foreground sm:text-4xl">
                  AI Readiness Audit
                </h1>
                <div className="text-sm leading-6 text-muted sm:text-base">
                  {subtitleMarkup}
                </div>
              </div>
              <div className="pill bg-accent-soft text-accent">
                Ready for another URL
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-4">
                <h1 className="max-w-4xl font-display text-5xl leading-[0.98] tracking-tight text-foreground sm:text-7xl">
                  AI Readiness Audit
                </h1>
                <div className="max-w-3xl text-2xl leading-9 text-ink-soft sm:text-3xl sm:leading-10">
                  {subtitleMarkup}
                </div>
                <p className="text-[0.72rem] font-semibold uppercase tracking-[0.22em] text-foreground/55">
                  Signal Strategy · Diagnostic
                </p>
                <p className="max-w-2xl text-lg leading-8 text-muted">
                  Scan any page and see how readable, accessible, and usable its
                  content is for modern AI and search systems. The goal is clarity,
                  crawlability, and attribution, not predictions about rankings or
                  guaranteed inclusion.
                </p>
              </div>
            </>
          )}

          <form
            onSubmit={handleSubmit}
            className={`card rounded-[1.6rem] ${resultsMode ? "p-3 sm:p-4" : "p-4 sm:p-5"}`}
          >
            <label
              htmlFor="url"
              className="mb-3 block text-sm font-semibold uppercase tracking-[0.16em] text-muted"
            >
              URL to scan
            </label>
            <div className="flex flex-col gap-3 md:flex-row">
              <input
                id="url"
                ref={inputRef}
                type="url"
                inputMode="url"
                placeholder="https://example.com/article"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                className={`flex-1 rounded-2xl border border-line bg-white/80 px-5 text-base outline-none transition focus:border-accent focus:ring-4 focus:ring-accent/10 ${
                  resultsMode ? "min-h-12" : "min-h-14"
                }`}
              />
              <button
                type="submit"
                disabled={loading}
                className={`rounded-2xl bg-foreground px-6 text-base font-semibold text-white transition hover:bg-ink-soft disabled:cursor-not-allowed disabled:opacity-60 ${
                  resultsMode ? "min-h-12" : "min-h-14"
                }`}
              >
                {loading ? "Scanning page..." : "Run scan"}
              </button>
            </div>
            {!resultsMode ? (
              <p className="mt-3 text-sm leading-6 text-muted">
                This scanner checks static signals like crawlability, content
                structure, structured data, and attribution. It does not determine
                AI eligibility or ranking.
              </p>
            ) : null}
            {loading ? (
              <div className="mt-4 rounded-2xl border border-accent/20 bg-accent/8 px-4 py-3 text-sm text-accent">
                Scanning page... checking crawlability, page structure, publisher details, and machine-readable signals.
              </div>
            ) : null}
            {error ? (
              <div className="mt-4 rounded-2xl border border-danger/20 bg-danger/8 px-4 py-3 text-sm text-danger">
                {error}
              </div>
            ) : null}
          </form>
        </div>

        {!resultsMode ? (
          <div className="fade-up card rounded-[2rem] p-6 [animation-delay:120ms] sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                  What gets scored
                </p>
                <h2 className="mt-2 font-display text-3xl text-foreground">
                  Four balanced pillars
                </h2>
              </div>
              <div className="pill bg-white/80 text-ink-soft">0-100 total</div>
            </div>

            <div className="mt-6 grid gap-3">
              {Object.entries(pillarDescriptions).map(([pillar, description], index) => (
                <div
                  key={pillar}
                  className="rounded-[1.4rem] border border-line bg-white/70 p-4"
                  style={{ animationDelay: `${160 + index * 70}ms` }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-semibold tracking-[0.08em] text-foreground">
                      {pillar.replaceAll("_", " ")}
                    </p>
                    <span className="text-xs uppercase tracking-[0.16em] text-muted">
                      25 pts
                    </span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted">{description}</p>
                  <p className="mt-2 text-sm leading-6 text-ink-soft">
                    {pillarHelpers[pillar]}
                  </p>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </section>

      {loading ? (
        <section className="fade-up mt-3 grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
          <div className="card rounded-[2rem] p-8">
            <div className="h-4 w-36 animate-pulse rounded-full bg-foreground/10" />
            <div className="mt-5 h-20 w-48 animate-pulse rounded-[2rem] bg-foreground/10" />
            <div className="mt-5 h-5 w-full animate-pulse rounded-full bg-foreground/10" />
            <div className="mt-3 h-5 w-10/12 animate-pulse rounded-full bg-foreground/10" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div
                key={index}
                className="card rounded-[1.7rem] p-5"
              >
                <div className="h-4 w-24 animate-pulse rounded-full bg-foreground/10" />
                <div className="mt-4 h-12 w-16 animate-pulse rounded-2xl bg-foreground/10" />
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {result ? (
        <section ref={resultRef} className="fade-up mt-3 space-y-5">
          <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="card rounded-[2rem] p-6 sm:p-8">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                  Scan result
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    onClick={handleNewScan}
                    className="rounded-full border border-line bg-white px-5 py-3 text-base font-semibold text-foreground shadow-sm transition hover:bg-surface-strong"
                  >
                    New scan
                  </button>
                  <button
                    type="button"
                    onClick={handleCopyReport}
                    className="rounded-full border border-line bg-white px-5 py-3 text-base font-semibold text-foreground shadow-sm transition hover:bg-surface-strong"
                  >
                    {copyState === "copied"
                      ? "Copied"
                      : copyState === "error"
                        ? "Copy failed"
                        : "Copy report"}
                  </button>
                </div>
              </div>

              <div className="mt-5 grid gap-6 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
                <div className="rounded-[1.9rem] bg-foreground px-7 py-6 text-white shadow-[0_16px_40px_rgba(29,41,56,0.18)]">
                  <p className="text-xs uppercase tracking-[0.18em] text-white/70">
                    Total score
                  </p>
                  <div className="mt-3 flex flex-wrap items-end gap-4">
                    <p className="font-display text-7xl leading-none">
                      {result.total_score}
                    </p>
                    <div className="pb-2">
                      <p className="text-[0.72rem] font-semibold uppercase tracking-[0.2em] text-white/60">
                        {result.status}
                      </p>
                      <p className="mt-1 text-sm text-white/70">out of 100</p>
                    </div>
                  </div>
                </div>

                <div className="max-w-xl self-center">
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                    Primary diagnosis
                  </p>
                  <h2 className="mt-3 max-w-2xl font-display text-3xl leading-tight text-foreground sm:text-4xl">
                    {statusDescription(result.status)}
                  </h2>
                  <p className="mt-3 text-sm leading-6 text-muted">
                    {result.status_reason}
                  </p>
                </div>

                <div className="rounded-[1.7rem] border border-line bg-white/70 p-5">
                  <div className="flex items-center justify-between gap-4">
                    <h3 className="font-display text-2xl text-foreground">
                      Total score
                    </h3>
                    <span className="text-sm text-muted">Best next actions</span>
                  </div>
                  <div className="mt-4 grid gap-3">
                    {topFixes.length > 0 ? (
                      topFixes.map((fix) => (
                        <div
                          key={fix}
                          className="rounded-2xl border border-line bg-surface-strong px-4 py-4 text-sm leading-6 text-ink-soft"
                        >
                          {fix}
                        </div>
                      ))
                    ) : (
                      <div className="rounded-2xl border border-accent/20 bg-accent/8 px-4 py-4 text-sm leading-6 text-accent">
                        This scan did not surface any urgent fixes.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-6 max-w-3xl">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                  URL scanned
                </p>
                <p className="mt-2 break-all text-sm leading-6 text-ink-soft">
                  {result.url}
                </p>
              </div>

              <div className="mt-5 max-w-3xl">
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                  Scan summary
                </p>
                <p className="mt-2 text-sm leading-6 text-muted">
                  {result.explanation}
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {result.pillars.map((pillar) => (
                <article
                  key={pillar.name}
                  className="card rounded-[1.7rem] p-5"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">
                    {pillar.name.replaceAll("_", " ")}
                  </p>
                  <div className="mt-4 flex items-end justify-between gap-3">
                    <p className="font-display text-5xl leading-none text-foreground">
                      {pillar.score}
                    </p>
                    <span className={`pill ${scoreTone(pillar.score)}`}>
                      /25
                    </span>
                  </div>
                  <p className="mt-4 text-sm leading-6 text-muted">
                    {pillar.summary}
                  </p>
                </article>
              ))}
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-[0.95fr_1.05fr]">
            <section className="card rounded-[2rem] p-6 sm:p-8">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                    Biggest gaps
                  </p>
                  <h3 className="mt-2 font-display text-3xl text-foreground">
                    Priority issues
                  </h3>
                </div>
              </div>
              <div className="mt-5 space-y-3">
                {result.top_issues.slice(0, 3).map((issue) => (
                  <div
                    key={issue.id}
                    className="rounded-[1.4rem] border border-line bg-white/70 p-4"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`pill ${issueTone(issue.status)}`}>
                        {issue.severity} priority
                      </span>
                      <span className="text-xs uppercase tracking-[0.16em] text-muted">
                        {issue.pillar.replaceAll("_", " ")}
                      </span>
                    </div>
                    <p className="mt-4 text-lg font-semibold text-foreground">
                      {issue.message}
                    </p>
                    <div className="mt-4 space-y-3 text-sm leading-6">
                      <div>
                        <p className="font-semibold text-foreground">What this means</p>
                        <p className="text-muted">{issue.explanation}</p>
                        {contextualGlossary(issue.id) ? (
                          <p className="mt-2 text-ink-soft">
                            {contextualGlossary(issue.id)}
                          </p>
                        ) : null}
                      </div>
                      {issue.visibleLayer ? (
                        <div>
                          <p className="font-semibold text-foreground">Visible layer</p>
                          <p className="text-muted">{issue.visibleLayer}</p>
                        </div>
                      ) : null}
                      {issue.machineLayer ? (
                        <div>
                          <p className="font-semibold text-foreground">
                            Machine-readable layer
                          </p>
                          <p className="text-muted">{issue.machineLayer}</p>
                        </div>
                      ) : null}
                      <div>
                        <p className="font-semibold text-foreground">
                          Why this matters for AI systems
                        </p>
                        <p className="text-muted">{issue.impact}</p>
                      </div>
                      <div>
                        <p className="font-semibold text-foreground">What to do</p>
                        <p className="mt-2 text-ink-soft">{issue.whatToDo}</p>
                      </div>
                      <div>
                        <p className="font-semibold text-foreground">How to do it</p>
                        <ul className="mt-2 space-y-2 text-ink-soft">
                          {issue.howToDoIt.map((step) => (
                            <li key={step} className="rounded-xl bg-surface-strong px-3 py-2">
                              {step}
                            </li>
                          ))}
                        </ul>
                      </div>
                      {issue.assignments?.length ? (
                        <div>
                          <p className="font-semibold text-foreground">Who does what</p>
                          <div className="mt-2 space-y-2">
                            {issue.assignments.map((assignment) => (
                              <p
                                key={`${assignment.role}-${assignment.responsibility}`}
                                className="rounded-xl bg-surface-strong px-3 py-2 text-sm leading-6 text-ink-soft"
                              >
                                <span className="font-semibold text-foreground">
                                  {assignment.role}
                                </span>
                                {" -> "}
                                {assignment.responsibility}
                              </p>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <section className="space-y-4">
              {result.pillars.map((pillar) => (
                <article
                  key={pillar.name}
                  className="card rounded-[2rem] p-6 sm:p-7"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-muted">
                        Detailed breakdown
                      </p>
                      <h3 className="mt-2 font-display text-3xl text-foreground">
                        {pillar.name.replaceAll("_", " ")}
                      </h3>
                    </div>
                    <div className={`pill ${scoreTone(pillar.score)}`}>
                      {pillar.score}/25
                    </div>
                  </div>
                  <p className="mt-4 max-w-2xl text-sm leading-6 text-muted">
                    {pillarDescriptions[pillar.name]}
                  </p>
                  <div className="mt-5 grid gap-3 lg:grid-cols-2">
                    <div className="rounded-[1.4rem] border border-line bg-white/70 p-4">
                      <p className="text-sm font-semibold text-foreground">
                        What was detected
                      </p>
                      <div className="mt-3 space-y-2">
                        {pillar.detected.length > 0 ? (
                          pillar.detected.map((item) => (
                            <p
                              key={item}
                              className="rounded-xl bg-surface-strong px-3 py-2 text-sm leading-6 text-ink-soft"
                            >
                              {item}
                            </p>
                          ))
                        ) : (
                          <p className="rounded-xl bg-surface-strong px-3 py-2 text-sm leading-6 text-muted">
                            No strong details were clearly confirmed in this pillar.
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="rounded-[1.4rem] border border-line bg-white/70 p-4">
                      <p className="text-sm font-semibold text-foreground">
                        What is unclear or missing
                      </p>
                      <div className="mt-3 space-y-2">
                        {pillar.unclear.length > 0 ? (
                          pillar.unclear.map((item) => (
                            <p
                              key={item}
                              className="rounded-xl bg-surface-strong px-3 py-2 text-sm leading-6 text-ink-soft"
                            >
                              {item}
                            </p>
                          ))
                        ) : (
                          <p className="rounded-xl bg-surface-strong px-3 py-2 text-sm leading-6 text-accent">
                            This pillar looks clear based on the details the scan confirmed.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="mt-4 rounded-[1.4rem] border border-line bg-white/70 p-4">
                    <p className="text-sm font-semibold text-foreground">
                      Scoring logic and evidence
                    </p>
                    <p className="mt-2 text-sm leading-6 text-muted">
                      {pillar.summary}
                    </p>
                    <p className="mt-2 text-xs text-muted">
                      Score reflects the strongest confirmed details, plus partial credit where details are visible but not strongly defined in site code.
                    </p>
                  </div>
                </article>
              ))}
            </section>
          </div>
        </section>
      ) : null}
    </main>
  );
}
