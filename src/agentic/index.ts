/**
 * AI access and agentic-web module: the AI bot list, live bot fetches, the
 * origin probe, and the llms.txt / GEO helpers the report uses.
 */
export {
  AI_BOTS,
  BOTS_REVIEWED,
  BROWSER_UA,
  PURPOSE_COPY,
  PURPOSE_WEIGHT,
  botByToken,
  botByUserAgent,
  fetchingBots,
  robotsBots,
  type AiBot,
  type BotPurpose,
} from './bots.js';
export {
  fetchAsBots,
  sampleBotFetches,
  botFetchDetail,
  detectChallenge,
  verdictFor,
  type SampleBotFetch,
} from './bot-fetch.js';
export { runAgenticProbes, parseLinkHeader } from './probe.js';
export { llmsTxtGrade, parseLlmsTxt, type LlmsGrade, type LlmsParsed } from './llms.js';
export { geoPageScore, geoSignals, type GeoScore, type GeoSignals } from './geo-score.js';
export * from './validate.js';
