/**
 * The check registry. Each category file exports `checks: Check[]`.
 * Technical SEO files are owned by the technical-checks module; AI/GEO/agentic
 * files by the AI-readiness module.
 */
import type { Check } from '../core/types.js';
import { checks as crawlability } from './crawlability.js';
import { checks as response } from './response.js';
import { checks as onpage } from './onpage.js';
import { checks as content } from './content.js';
import { checks as canonical } from './canonical.js';
import { checks as links } from './links.js';
import { checks as images } from './images.js';
import { checks as schema } from './schema.js';
import { checks as hreflang } from './hreflang.js';
import { checks as mobile } from './mobile.js';
import { checks as performance } from './performance.js';
import { checks as security } from './security.js';
import { checks as urls } from './urls.js';
import { checks as sitemaps } from './sitemaps.js';
import { checks as pagination } from './pagination.js';
import { checks as accessibility } from './accessibility.js';
import { checks as jsRendering } from './js-rendering.js';
import { checks as analytics } from './analytics.js';
import { checks as cms } from './cms.js';
import { checks as aiCrawlers } from './ai-crawlers.js';
import { checks as llmsTxt } from './llms-txt.js';
import { checks as geo } from './geo.js';
import { checks as entity } from './entity.js';
import { checks as agentic } from './agentic.js';

export const ALL_CHECKS: Check[] = [
  ...crawlability,
  ...response,
  ...onpage,
  ...content,
  ...canonical,
  ...links,
  ...images,
  ...schema,
  ...hreflang,
  ...mobile,
  ...performance,
  ...security,
  ...urls,
  ...sitemaps,
  ...pagination,
  ...accessibility,
  ...jsRendering,
  ...analytics,
  ...cms,
  ...aiCrawlers,
  ...llmsTxt,
  ...geo,
  ...entity,
  ...agentic,
];

export function checkById(id: string): Check | undefined {
  return ALL_CHECKS.find((c) => c.def.id === id);
}
