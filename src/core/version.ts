import { readFileSync } from 'node:fs';

export const APP_NAME = 'AI Visibility Checker';
// package.json is two levels up from both src/core/ and dist/core/, in the repo, an npm install,
// the Docker image and the .mcpb bundle, so the version has one source of truth.
export const APP_VERSION: string = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version;
export const DEFAULT_USER_AGENT = `AVC/${APP_VERSION} (+https://devs-core.com/ai-visibility-checker/app)`;
