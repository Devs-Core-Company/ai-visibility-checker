# Contributing

Thanks for helping. Bug reports, wrong results, new checks and fixes for more stacks are all welcome.

## Set up

```bash
git clone https://github.com/Devs-Core-Company/ai-visibility-checker.git
cd ai-visibility-checker
npm ci
npm run check        # typecheck + prettier + tests
npm run dev -- audit http://127.0.0.1:4400   # run the CLI from source (tsx)
```

Use `AVC_LLM_MOCK=1` for anything that touches AI engines, so tests and local runs cost nothing.
`AVC_DATA_DIR=$(mktemp -d)` keeps your real history out of the way.

## How the code is organised

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first. `src/core/types.ts` is the shared contract.
Each folder has one job: `crawl`, `checks`, `agentic`, `ai`, `fixes`, `connect`, `audit`, `monitor`,
`report`, and the user surfaces `cli`, `server` (dashboard) and `mcp`.

## Adding a check

1. Add it to the right file in `src/checks/` with an id `<category>.<slug>` (kebab-case). **Ids are
   permanent**: history and diffs depend on them. Never rename or reuse one.
2. Fill in `pillar`, `severity`, `scope`, `fixTier`, `why` (one or two plain sentences), `fix`, and
   `requires` if it needs optional data. Link the authoritative source in `refs`.
3. Checks must not throw and must not fetch (site checks may make a few requests through
   `site.fetcher`).
4. Add a test with a small HTML fixture, both a passing and a failing case.
5. If the fix differs by stack, add a recipe in `src/fixes/recipes/`.

## Style

- TypeScript, ESM, relative imports end in `.js`. Prettier: single quotes, trailing commas, 100
  columns (`npm run format`).
- User-facing text: plain, specific, short sentences, British spelling. No hype, and no claims we
  cannot back up.
- Dashboard: server-rendered `hono/jsx`, plain CSS and a little vanilla JS in `public/`. No build
  step, no external fonts or scripts.

## Pull requests

- One change per pull request, with a test.
- `npm run check` and `npm run compile` must pass (CI runs them on Node 22 and 24).
- Describe what changed and why; for a check, include an example page where it fires.

By contributing you agree that your contribution is licensed under the MIT licence.

Note: the build script is called `compile`, not `build`. npm prepares git
dependencies (runs an install and build in a temporary copy) whenever a package
has a `build`, `prepare`, `prepack` or install script, and that breaks
`npm install -g github:Devs-Core-Company/ai-visibility-checker`. Keep those
script names out of package.json.
