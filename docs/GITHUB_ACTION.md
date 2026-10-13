# GitHub Action

Run the AI Visibility Checker in GitHub Actions to audit your site on a schedule
and after every deploy. Each run:

- crawls the site and runs every check (technical SEO, content, AI crawler access,
  llms.txt, AEO/GEO, agentic web),
- uploads the issues as SARIF, so they appear under **Security → Code scanning**
  and close by themselves once fixed,
- writes the changes since the last run (new and fixed issues, score and pillar
  changes, changed pages) and the full Markdown report to the job summary,
- keeps the HTML, JSON, Markdown and SARIF reports as a build artifact,
- fails the job when the score drops below `fail-under`.

History is kept in the Actions cache (`keep-history: true`), so every run is
compared with the one before it.

## Inputs

| Input | Default | What it does |
| --- | --- | --- |
| `url` | (required) | The site to audit. |
| `fail-under` | `0` | Fail the job when the score is below this. `0` never fails. |
| `format` | `html,sarif,md` | Report formats. `sarif` and `md` are always written. |
| `max-pages` | `500` | Stop after this many pages. |
| `args` | | Extra `avc audit` arguments, e.g. `--visibility --engines chatgpt,claude`. |
| `version` | `main` | Git ref of the checker to run. Pin a tag for repeatable results. |
| `node-version` | `22` | Node.js 22.5 or newer. |
| `upload-sarif` | `true` | Upload to code scanning (needs `security-events: write`). |
| `keep-history` | `true` | Cache the local database between runs for diffs. |
| `out` | `avc-reports` | Folder for the report files. |

Outputs: `score`, `grade`, `sarif` (path).

## Example: weekly, on deploy, and by hand

```yaml
# .github/workflows/ai-visibility.yml
name: AI visibility audit

on:
  schedule:
    - cron: '17 6 * * 1' # Mondays 06:17 UTC
  deployment_status: # after a successful deploy (Vercel, Netlify and others report these)
  workflow_dispatch:

permissions:
  contents: read
  security-events: write # SARIF upload
  actions: read

concurrency:
  group: ai-visibility
  cancel-in-progress: false

jobs:
  audit:
    if: github.event_name != 'deployment_status' || github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: Devs-Core-Company/ai-visibility-checker/.github/actions/avc-audit@main
        with:
          url: https://example.com
          fail-under: 70
```

To audit the preview of a deploy instead of production, pass
`url: ${{ github.event.deployment_status.environment_url }}`. Previews behind
password protection need a bypass header or cookie; see `avc audit --help`.

## AI visibility in CI

Add `--visibility` to `args` to ask ChatGPT, Claude, Gemini and Perplexity about
your brand on each run. This spends money on your own API keys, so keep it to the
weekly schedule and set the caps:

```yaml
      - uses: Devs-Core-Company/ai-visibility-checker/.github/actions/avc-audit@main
        if: github.event_name == 'schedule'
        with:
          url: https://example.com
          args: --visibility
        env:
          AI_GATEWAY_API_KEY: ${{ secrets.AI_GATEWAY_API_KEY }} # or OPENAI_API_KEY, ANTHROPIC_API_KEY…
          AVC_MAX_RUN_USD: '2'
          AVC_MAX_MONTH_USD: '10'
```

Without keys the score is "readiness only": it measures whether AI engines can
reach, read and trust the site, not whether they already name you.

## Alerts from CI

The job summary and code scanning cover most teams. To get a Slack, Discord or
Teams message as well, set `AVC_WEBHOOK_URL` from a secret and run
`avc monitor run <url>` in a later step; it compares with the previous audit and
sends alerts for score drops, new critical issues, pages that became noindex or
started erroring, newly blocked AI crawlers, and robots.txt or llms.txt changes.

## Running without the action

```bash
npx github:Devs-Core-Company/ai-visibility-checker audit https://example.com \
  --fail-under 70 --format sarif,md --out avc-reports
npx github:Devs-Core-Company/ai-visibility-checker diff https://example.com --md
```

`--fail-under` exits with code 2 when the score is below the threshold.
