/**
 * AI visibility: does ChatGPT, Claude, Gemini, Perplexity (and Grok) name and
 * cite the brand, against whom, and why not. See docs/ARCHITECTURE.md.
 */
export {
  availableEngines,
  defaultEngines,
  engineLabel,
  engineStatus,
  isMock,
  ENGINE_INFO,
  type EngineEntry,
  type EngineStatus,
  type Via,
} from './engines.js';
export {
  inferBrand,
  mergeBrand,
  refineBrand,
  extractSiteFacts,
  sameAsLinks,
  type SiteFacts,
} from './brand.js';
export {
  suggestPrompts,
  templatePrompts,
  makePrompt,
  namesBrand,
  type SuggestOptions,
} from './suggest.js';
export { runVisibility, summarise, runCeiling, Budget, type RunVisibilityInput } from './run.js';
export { explainGaps, explainGapsWithModel, sourceType, type Gap } from './gaps.js';
export { compareRuns } from './compare.js';
export { heuristicJudge, type Judgement } from './judge.js';
export { lookupEntity } from './entity.js';
export { mockAnswer, MOCK_LABEL } from './mock.js';
export { MODEL_PRICES, PRICES_REVIEWED, estimateCost, expectedCallCost } from './pricing.js';
