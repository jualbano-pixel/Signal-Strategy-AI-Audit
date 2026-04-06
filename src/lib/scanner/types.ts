export const PILLARS = [
  "FINDABILITY",
  "INTERPRETATION",
  "ATTRIBUTION",
  "DELIVERY",
] as const;

export type PillarName = (typeof PILLARS)[number];

export type RuleSeverity = "low" | "medium" | "high";
export type RuleStatus = "pass" | "warn" | "fail";

export type RuleDefinition = {
  id: string;
  rootCause?: string;
  pillar: PillarName;
  component: string;
  weight: number;
  severity: RuleSeverity;
  check: string;
  pass_condition: string;
  message: string;
  explanation: string;
  impact: string;
  visibleLayer?: string;
  machineLayer?: string;
  whatToDo: string;
  howToDoIt: string[];
  assignments?: Array<{
    role: "Editorial / Content" | "Brand / Marketing" | "Developer";
    responsibility: string;
  }>;
};

export type EvaluatedRule = RuleDefinition & {
  status: RuleStatus;
  score: number;
  details: string;
};

export type RuleNarrativeFields = Partial<
  Pick<
    EvaluatedRule,
    | "message"
    | "explanation"
    | "impact"
    | "whatToDo"
    | "howToDoIt"
    | "assignments"
    | "visibleLayer"
    | "machineLayer"
  >
>;

export type PillarResult = {
  name: PillarName;
  score: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  issues: EvaluatedRule[];
  summary: string;
  detected: string[];
  unclear: string[];
};

export type ScoreLabel =
  | "AI-Ready"
  | "AI-Ready with Gaps"
  | "At Risk"
  | "Failing";

export type ScanResult = {
  url: string;
  total_score: number;
  status: ScoreLabel;
  status_reason: string;
  pillars: PillarResult[];
  top_issues: EvaluatedRule[];
  quick_wins: string[];
  explanation: string;
  scanned_at: string;
};

export type JsonLdNode = Record<string, unknown>;

export type ScanContext = {
  url: string;
  finalUrl: string;
  hostname: string;
  responseTimeMs: number;
  statusCode: number;
  contentType: string;
  html: string;
  htmlLang?: string;
  robotsTxt?: string;
  robotsReachable: boolean;
  crawlAllowed?: boolean;
  sitemapUrls: string[];
  headers: Record<string, string>;
  title?: string;
  metaDescription?: string;
  metaRobots?: string;
  xRobotsTag?: string;
  canonical?: string;
  hasViewport: boolean;
  h1Count: number;
  mainH1Count: number;
  mainHeadingText?: string;
  headingCount: number;
  paragraphCount: number;
  averageParagraphLength: number;
  wordCount: number;
  hasMainContent: boolean;
  authorText?: string;
  publicationDate?: string;
  socialLinks: string[];
  schemaSameAsLinks: string[];
  externalPlatformLinks: string[];
  schemaNodes: JsonLdNode[];
  schemaTypes: string[];
  organizationSchema?: JsonLdNode;
  personSchema?: JsonLdNode;
  articleSchema?: JsonLdNode;
  publisherNameVisible: boolean;
  domainBrandSignal: boolean;
  organizationHasSameAs: boolean;
  articleHasPublisherReference: boolean;
  articlePublisherMatchesOrganization: boolean;
  redirectsFollowed: number;
};
