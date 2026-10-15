# MCP server

`avc mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio, so an AI
assistant can audit your site, read the issues, get stack-specific fixes with agent prompts, check
AI crawler access and AI visibility, and apply fixes after you approve them.

It uses the same data folder (`~/.avc`) and keys as the CLI and dashboard, so audits run from one are
visible in the others.

## Set it up

You need Node.js 22.5 or newer.

### Claude desktop app: install the extension (with a settings page for your keys)

Download `ai-visibility-checker-<version>.mcpb` from the
[releases](https://github.com/Devs-Core-Company/ai-visibility-checker/releases), or build it with
`npm run bundle:mcpb` (it lands in `build/`). Double-click it, or drag it into Claude Desktop →
**Settings → Extensions**, and choose Install.

The extension has its own settings page: **Settings → Extensions → AI Visibility Checker →
Configure**. It has a field for each AI engine key (Vercel AI Gateway, OpenAI, Anthropic, Google
Gemini, Perplexity, xAI), PageSpeed Insights and Bing, plus your spend caps. Every key field is
optional and masked. Claude Desktop keeps the values in your system's secure storage and passes them
only to the extension on your computer, which sends each key only to its own provider. Leave a field
empty and the steps that need it are skipped, and the results say so.

Keys you saved with `avc keys` or the dashboard are used too. A key entered in the extension's
settings takes precedence, and `keys_status` shows which is which ("Claude Desktop settings").
The extension runs on the Node.js that Claude Desktop ships with, so you do not need Node installed
for it. To disable or uninstall it, use the switch and the Uninstall button on the same page. An
`avc setup-claude` entry has no such page in Claude Desktop (only tool permissions), because it
lives in `claude_desktop_config.json`; remove it with `avc setup-claude --remove --desktop`.
Use either the extension or the `avc setup-claude` entry below in Claude Desktop, not both,
or AVC shows up twice.

### One step: Claude desktop app, Claude Code and Cursor

```bash
npm i -g github:Devs-Core-Company/ai-visibility-checker
avc setup-claude
```

Or run the one-line installer (`install.sh` / `install.ps1`, see the README), which installs `avc` and
runs `avc setup-claude` for you.

`avc setup-claude` connects AVC to whichever of these are installed:

- **Claude desktop app (chat):** adds an `avc` entry to `claude_desktop_config.json`, keeping every
  other server and setting, and saves a backup of the old file first.
- **Claude Code** (the `claude` CLI and the app's Code tab): registers it at **user scope**, so it
  works in every folder, not only the one you ran the command in.
- **Cursor:** adds it to `~/.cursor/mcp.json`.

The entry uses absolute paths (your `node` and AVC's own launcher) plus a `PATH` that contains that
`node`. The desktop app does not inherit your shell's `PATH`, so a bare `npx` often fails silently
with nvm, conda or Homebrew; absolute paths avoid that, and there is no download on first start.

Then **fully quit the Claude app** (⌘Q on macOS, File → Exit on Windows; closing the window is not
enough) and open it again. In a new chat, AVC appears in the tools menu. Try: "Audit
https://yoursite.com with avc".

Options: `--desktop`, `--code` or `--cursor` to set up only one; `--dry-run` to see the change
without writing it; `--remove` to take AVC out again. If you switch Node versions later (nvm, fnm),
run `avc setup-claude` again so the path points at a Node that still exists.

### Doing it by hand

`claude mcp add` only reaches Claude Code, not the desktop app's chat; the two keep separate
configs. And without `--scope user` it only applies to the folder you ran it in.

**Claude Code, every folder:**

```bash
claude mcp add --scope user avc -- npx -y github:Devs-Core-Company/ai-visibility-checker mcp
```

**Claude desktop app:** Settings → Developer → Edit Config, or open the file directly:

| System  | Config file                                                       |
| ------- | ----------------------------------------------------------------- |
| macOS   | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json`                     |
| Linux   | `~/.config/Claude/claude_desktop_config.json`                     |

Use the full path to `npx` (from `which npx`, or `where npx` on Windows), and merge the entry into
any existing `mcpServers` block:

```json
{
  "mcpServers": {
    "avc": {
      "command": "/full/path/from/which/npx",
      "args": ["-y", "github:Devs-Core-Company/ai-visibility-checker", "mcp"],
      "env": { "PATH": "/folder/containing/node:/usr/bin:/bin" }
    }
  }
}
```

Then quit the app fully and reopen it.

**Cursor:** the same entry in `.cursor/mcp.json` in your project, or `~/.cursor/mcp.json` for all
projects.

API keys for the AI visibility tools: save them once with `avc ui` → Settings (the MCP server reads
the same `~/.avc` folder), or add them to the entry's `env`.

### If it does not show up

The Claude app writes a log per server that usually says exactly why it failed:

| System  | Log                                        |
| ------- | ------------------------------------------ |
| macOS   | `~/Library/Logs/Claude/mcp-server-avc.log` |
| Windows | `%APPDATA%\Claude\logs\mcp-server-avc.log` |

The usual causes: `npx: command not found` or `node: command not found` (use `avc setup-claude`,
or absolute paths as above), the first GitHub download timing out (install with `npm i -g` first),
or the app was closed rather than quit.

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

| Tool                  | What it does                                                                     | Changes anything?                           |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `audit_site`          | Crawl and check a site; returns score, pillars and top priorities                | Saves the audit                             |
| `get_issues`          | Issues filtered by pillar, category, severity, check, URL or text                | No                                          |
| `get_page`            | Everything recorded about one page, with its issues                              | No                                          |
| `get_fix`             | Stack-aware fix for a check: steps, files, snippet, agent prompt, affected URLs  | No                                          |
| `list_checks`         | The check catalogue                                                              | No                                          |
| `crawler_access`      | Per AI crawler: robots.txt decision and deciding line, live fetch verdict        | No                                          |
| `agentic_readiness`   | Origin probes, llms.txt structure, agentic check results                         | No                                          |
| `ai_visibility`       | Latest stored run; with `run=true`, a new run (see below)                        | Spends money only with `confirm_spend=true` |
| `diff_audits`         | Score, new and fixed issues, pages, AI visibility between two audits             | No                                          |
| `generate_llms_txt`   | llms.txt from the latest audit                                                   | No                                          |
| `generate_robots_txt` | robots.txt with managed AI crawler rules for a policy                            | No                                          |
| `generate_schema`     | Organization + WebSite JSON-LD                                                   | No                                          |
| `plan_fixes`          | Ranked fixes; with `target`, a dry-run preview                                   | No                                          |
| `apply_fixes`         | Apply to WordPress or a local repo                                               | Only with `confirm=true`                    |
| `list_sites`          | Configured sites and available AI engines                                        | No                                          |
| `list_audits`         | Stored audits per site, newest first                                             | No                                          |
| `pagespeed`           | PageSpeed Insights lab and field data for one URL                                | No                                          |
| `serp_preview`        | Titles and descriptions as search snippets: pixel width, truncation, thin-for-AI | No                                          |
| `ask_audit`           | Answer a question about the latest audit                                         | No                                          |
| `generate_report`     | Write html, md, csv, json, sarif, xlsx or pdf files                              | Writes report files                         |
| `create_redirect`     | Add a WordPress redirect through the AVC helper                                  | Only with `confirm=true`                    |
| `rollback`            | Restore a WordPress or repo rollback snapshot                                    | Only with `confirm=true`                    |
| `keys_status`         | Which API keys are set (never their values) and where they are stored            | No                                          |
| `setup_keys`          | Opens a private page on your computer to type API keys                           | Saves keys to your OS keychain              |

Resource: `avc://report/{site}`, the latest audit report for a site as Markdown.

## Safety

- **Spending.** `ai_visibility` with `run=true` first returns the engines, number of answers and an
  upper-bound cost, with your caps and this month's spend. It only runs when called again with
  `confirm_spend=true`, and the per-run and monthly caps still apply. In mock mode nothing is spent.
- **Changes.** `apply_fixes` is a dry run unless `confirm=true`. The tool description tells the
  assistant to show you the preview and get your go-ahead first. WordPress changes save a rollback
  snapshot (`avc rollback <file>`).
- **Keys.** Keys never go through the chat. When a key is missing, `ai_visibility` (or
  `setup_keys`) gives you a one-time link to a page on your own computer (`127.0.0.1`, expires
  after 15 minutes) where you type them. Clients that support URL elicitation open it themselves.
  The page saves to your OS keychain and never shows a key back; the assistant only ever sees the
  link. If you skip, the AI steps are skipped and the result says so.
- **Skipped steps.** `audit_site` lists what did not run and why (`skipped`), so the assistant can
  tell you, for example, that AI visibility was not measured because no key is set.
- **Long audits.** `audit_site` sends progress notifications, so clients that reset their timeout
  on progress keep waiting through a long crawl.
- **Output.** The server writes only protocol messages to stdout; progress goes to stderr.
- **Node versions.** On Node 22.5 to 22.12, where `node:sqlite` needs a flag, the `avc` launcher
  starts Node again with `--experimental-sqlite`. stdin and stdout pass straight through, so the
  MCP connection is unaffected.

## Example prompts

- "Audit example.com with up to 200 pages and tell me the three things to fix first."
- "Which AI crawlers are blocked on example.com, and by which robots.txt line?"
- "Get the fix for `schema.invalid-json` and apply it in this repo."
- "How often does ChatGPT name us for our tracked prompts? Show me the estimate before running."
- "What changed since the last audit?"
