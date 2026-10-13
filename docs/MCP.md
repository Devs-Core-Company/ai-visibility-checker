# MCP server

`avc mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so an AI
assistant can audit your site, read the issues, get stack-specific fixes with agent prompts, check
AI crawler access and AI visibility, and apply fixes after you approve them.

It uses the same data folder (`~/.avc`) and keys as the CLI and dashboard, so audits run from one are
visible in the others.

## Set it up

You need Node.js 22.5 or newer. With `avc` installed globally, use `avc mcp` as the command; otherwise
`npx -y github:Devs-Core-Company/ai-visibility-checker mcp` works anywhere.

### Claude Code

```bash
claude mcp add avc -- npx -y github:Devs-Core-Company/ai-visibility-checker mcp
# or, with avc installed:
claude mcp add avc -- avc mcp
```

Pass keys with `-e`, for example `claude mcp add avc -e AI_GATEWAY_API_KEY=... -- avc mcp`, or save
them once with `avc ui` → Settings.

### Claude Desktop

Settings → Developer → Edit config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "avc": {
      "command": "npx",
      "args": ["-y", "github:Devs-Core-Company/ai-visibility-checker", "mcp"]
    }
  }
}
```

### Cursor

`.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` for all projects):

```json
{
  "mcpServers": {
    "avc": {
      "command": "npx",
      "args": ["-y", "github:Devs-Core-Company/ai-visibility-checker", "mcp"]
    }
  }
}
```

### VS Code (GitHub Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "avc": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:Devs-Core-Company/ai-visibility-checker", "mcp"]
    }
  }
}
```

Add `"env": { "AVC_DATA_DIR": "/path" }` to any of these to use a different data folder.

## Tools

| Tool | What it does | Changes anything? |
| --- | --- | --- |
| `audit_site` | Crawl and check a site; returns score, pillars and top priorities | Saves the audit |
| `get_issues` | Issues filtered by pillar, category, severity, check, URL or text | No |
| `get_page` | Everything recorded about one page, with its issues | No |
| `get_fix` | Stack-aware fix for a check: steps, files, snippet, agent prompt, affected URLs | No |
| `list_checks` | The check catalogue | No |
| `crawler_access` | Per AI crawler: robots.txt decision and deciding line, live fetch verdict | No |
| `agentic_readiness` | Origin probes, llms.txt structure, agentic check results | No |
| `ai_visibility` | Latest stored run; with `run=true`, a new run (see below) | Spends money only with `confirm_spend=true` |
| `diff_audits` | Score, new and fixed issues, pages, AI visibility between two audits | No |
| `generate_llms_txt` | llms.txt from the latest audit | No |
| `generate_robots_txt` | robots.txt with managed AI crawler rules for a policy | No |
| `generate_schema` | Organization + WebSite JSON-LD | No |
| `plan_fixes` | Ranked fixes; with `target`, a dry-run preview | No |
| `apply_fixes` | Apply to WordPress or a local repo | Only with `confirm=true` |
| `list_sites` | Configured sites and available AI engines | No |

Resource: `avc://report/{site}`, the latest audit report for a site as Markdown.

## Safety

- **Spending.** `ai_visibility` with `run=true` first returns the engines, number of answers and an
  upper-bound cost, with your caps and this month's spend. It only runs when called again with
  `confirm_spend=true`, and the per-run and monthly caps still apply. In mock mode nothing is spent.
- **Changes.** `apply_fixes` is a dry run unless `confirm=true`. The tool description tells the
  assistant to show you the preview and get your go-ahead first. WordPress changes save a rollback
  snapshot (`avc rollback <file>`).
- **Output.** The server writes only protocol messages to stdout; progress goes to stderr.

## Example prompts

- "Audit example.com with up to 200 pages and tell me the three things to fix first."
- "Which AI crawlers are blocked on example.com, and by which robots.txt line?"
- "Get the fix for `schema.invalid-json` and apply it in this repo."
- "How often does ChatGPT name us for our tracked prompts? Show me the estimate before running."
- "What changed since the last audit?"
