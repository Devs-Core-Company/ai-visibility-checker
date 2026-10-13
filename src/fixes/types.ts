/**
 * Types local to the fixes module. The shared contract (Fix, CheckDef, Issue…) lives in
 * src/core/types.ts; these only describe how recipes are written and what the apply
 * layer returns.
 */
import type {
  AuditResult,
  CheckDef,
  FixTier,
  Issue,
  PageSummary,
  StackInfo,
} from '../core/types.js';

/** Brand facts used to fill generated artefacts (JSON-LD, llms.txt, agent card). */
export interface BrandFacts {
  name?: string;
  description?: string;
  url?: string;
  logo?: string;
  sameAs?: string[];
  email?: string;
  telephone?: string;
  address?: {
    streetAddress?: string;
    addressLocality?: string;
    addressRegion?: string;
    postalCode?: string;
    addressCountry?: string;
  };
  /** schema.org LocalBusiness subtype, e.g. 'Dentist', 'LegalService'. */
  businessType?: string;
  openingHours?: string[];
  services?: string[];
  location?: string;
}

export interface FixContext {
  stack: StackInfo;
  /** Origin, e.g. https://example.com */
  site?: string;
  pages?: PageSummary[];
  /** The full audit result, when available (robots body, probes, other checks). */
  result?: AuditResult;
  brand?: BrandFacts;
}

export type NextRouter = 'app' | 'pages' | null;

/** What a recipe receives. */
export interface RecipeInput extends FixContext {
  def: CheckDef;
  issues: Issue[];
  origin: string;
  /** Host without scheme, e.g. example.com */
  host: string;
  /** Affected URLs (deduplicated, in issue order). */
  urls: string[];
  router: NextRouter;
}

/** The stack-specific part of a fix. */
export interface StackFix {
  title?: string;
  steps: string[];
  files: string[];
  snippet?: { language: string; code: string };
  /** Extra acceptance criteria for the agent prompt. */
  acceptance?: string[];
}

export interface Recipe {
  id: string;
  /**
   * Check-id patterns: exact ids, globs (`onpage.title-*`, `ai-crawlers.*-blocked`) or RegExps.
   * Check ids are `<category>.<slug>`.
   */
  patterns: (string | RegExp)[];
  impact: 'high' | 'medium' | 'low';
  effort: 'minutes' | 'hours' | 'days';
  /** Force a tier (e.g. 'manual' for content work). Otherwise the check's own tier is used. */
  tier?: FixTier;
  /** Which connectors can apply this recipe automatically. */
  auto?: { wordpress?: boolean; repo?: boolean };
  build(input: RecipeInput): StackFix;
}
