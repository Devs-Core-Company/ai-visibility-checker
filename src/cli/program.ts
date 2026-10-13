/**
 * The `avc` command tree (commander). Command bodies live in ./commands/*.
 * `buildProgram()` is exported so tests can drive it without spawning a process.
 */
import { Argument, Command, InvalidArgumentError, Option } from 'commander';
import { APP_NAME, APP_VERSION } from '../core/version.js';
import { fail } from './output.js';
import { ExitError } from './errors.js';
import { errMsg } from './services.js';
import { cmdInit } from './commands/init.js';
import { cmdAudit } from './commands/audit.js';
import { cmdVisibility, cmdPromptsSuggest } from './commands/visibility.js';
import { cmdFix, cmdRollback } from './commands/fix.js';
import { cmdGenerate } from './commands/generate.js';
import { cmdConnect, cmdLogs } from './commands/connect.js';
import {
  cmdDiff,
  cmdHistory,
  cmdReport,
  cmdSites,
  cmdSitesAdd,
  cmdSitesRemove,
} from './commands/history.js';
import { cmdMonitor, cmdMonitorRun, cmdSchedule } from './commands/monitor.js';
import { cmdChecks } from './commands/checks.js';
import { cmdDoctor } from './commands/doctor.js';

export { ExitError };

export function int(name: string) {
  return (v: string): number => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0)
      throw new InvalidArgumentError(`${name} must be a whole number.`);
    return n;
  };
}

const collect = (v: string, prev: string[] = []) => [
  ...prev,
  ...v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];

/** Wrap an async action so errors print cleanly and set the exit code. */
function run<A extends unknown[]>(fn: (...args: A) => Promise<void> | void) {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      if (err instanceof ExitError) {
        if (err.message) fail(err.message);
        process.exitCode = err.code;
        return;
      }
      fail(errMsg(err));
      if (process.env.AVC_DEBUG && err instanceof Error && err.stack) console.error(err.stack);
      process.exitCode = 1;
    }
  };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('avc')
    .description(
      `${APP_NAME} by Devs Core: audit your own site for Google and AI engines, track whether ChatGPT, Claude, Gemini and Perplexity name you, and fix what holds you back.`,
    )
    .version(APP_VERSION, '-v, --version')
    .showHelpAfterError('(run `avc --help` for usage)')
    .configureHelp({ sortSubcommands: false });

  program
    .command('init')
    .description('Set up a site: URL, brand, competitors. Writes avc.config.json in this folder.')
    .option('--url <url>', 'site URL (skips the question)')
    .option('--brand <name>', 'brand name')
    .option('--competitors <list>', 'comma-separated competitor names', collect)
    .option('--user', 'save to ~/.avc/config.json instead of ./avc.config.json')
    .option('-y, --yes', 'accept defaults, ask nothing')
    .action(run(cmdInit));

  program
    .command('audit')
    .description('Crawl a site and run every check. Saves the audit and writes reports.')
    .argument('<url>', 'site URL or configured site id')
    .option('--max-pages <n>', 'stop after this many pages (0 = no limit)', int('--max-pages'))
    .option('--depth <n>', 'maximum click depth', int('--depth'))
    .addOption(new Option('--render', 'render pages in Chrome to compare raw vs JavaScript output'))
    .addOption(new Option('--no-render', 'never render with Chrome'))
    .option('--include <regex>', 'only crawl URLs matching (repeatable)', collect)
    .option('--exclude <regex>', 'skip URLs matching (repeatable)', collect)
    .option(
      '--only <checks>',
      'run only these checks: ids, id prefixes, categories or pillars',
      collect,
    )
    .option('--skip <checks>', 'skip these checks (same selectors as --only)', collect)
    .option('--visibility', 'also ask AI engines about your brand (uses your AI keys)')
    .option(
      '--engines <list>',
      'engines for --visibility: chatgpt,claude,gemini,perplexity,grok,deepseek',
      collect,
    )
    .option('--repeats <n>', 'ask each prompt this many times per engine', int('--repeats'))
    .option('--mock', 'fake AI answers, no spend')
    .option('-f, --format <list>', 'report formats: html,json,md,csv,sarif', 'html,json')
    .option('-o, --out <dir>', 'where to write reports', 'avc-reports')
    .option(
      '--fail-under <score>',
      'exit with code 2 when the score is below this (for CI)',
      int('--fail-under'),
    )
    .option('--open', 'open the HTML report when done')
    .option('--json', 'print the result as JSON to stdout (no progress output)')
    .option('-q, --quiet', 'no progress output')
    .option('--no-save', 'do not store the audit in history')
    .action(run(cmdAudit));

  program
    .command('visibility')
    .description('Ask AI engines your prompts and measure mentions, share of voice and citations.')
    .argument('<url>', 'site URL or configured site id')
    .option('--prompts <file>', 'prompts file: one per line, or JSON')
    .option('--engines <list>', 'chatgpt,claude,gemini,perplexity,grok,deepseek', collect)
    .option('--repeats <n>', 'ask each prompt this many times per engine', int('--repeats'))
    .option('--mock', 'fake AI answers, no spend')
    .option('-y, --yes', 'do not ask before spending')
    .option('--json', 'print the run as JSON')
    .action(run(cmdVisibility));

  const prompts = program.command('prompts').description('Manage the prompts you track.');
  prompts
    .command('suggest')
    .description('Suggest prompts people might ask AI engines about your category.')
    .argument('<url>', 'site URL or configured site id')
    .option('--save', 'save them to the site config')
    .option('--json', 'print as JSON')
    .action(run(cmdPromptsSuggest));

  program
    .command('fix')
    .description(
      'Plan fixes from an audit, preview the changes, and apply them to WordPress or a local repo.',
    )
    .argument('[ref]', 'site URL, site id or audit id (default: latest audit)')
    .addOption(new Option('--target <target>', 'where to apply').choices(['wordpress', 'repo']))
    .option('--repo <path>', 'path to the site source (for --target repo)')
    .option('--only <checks>', 'only these checks', collect)
    .option('--dry-run', 'show what would change, change nothing (default)')
    .option('--apply', 'apply the changes (asks first unless --yes)')
    .option('-y, --yes', 'do not ask for confirmation')
    .option('--json', 'print the plan as JSON')
    .option('--rollback <file>', 'undo a previous apply from its snapshot (same as `avc rollback`)')
    .action(run(cmdFix));

  program
    .command('rollback')
    .description('Undo a WordPress fix using the snapshot saved before it was applied.')
    .argument('<file>', 'snapshot file printed by `avc fix --apply`')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(run(cmdRollback));

  program
    .command('generate')
    .description(
      'Generate llms.txt, robots.txt, Organization JSON-LD or an A2A agent card for a site.',
    )
    .addArgument(
      new Argument('<kind>', 'llms-txt | robots | schema | agent-card').choices([
        'llms-txt',
        'robots',
        'schema',
        'agent-card',
      ]),
    )
    .argument('<url>', 'site URL, site id or audit id')
    .option('-o, --out <file>', 'write to a file instead of stdout')
    .addOption(
      new Option('--policy <policy>', 'robots.txt policy for AI crawlers')
        .choices(['allow-all', 'allow-search', 'block-training', 'block-all'])
        .default('allow-search'),
    )
    .option('--fresh', 'crawl again instead of using the latest audit')
    .action(run(cmdGenerate));

  program
    .command('connect')
    .description('Connect a data source or fix target, and test it.')
    .addArgument(
      new Argument(
        '<source>',
        'google | gsc | ga4 | psi | bing | wordpress | logs | repo | status',
      ).choices(['google', 'gsc', 'ga4', 'psi', 'bing', 'wordpress', 'logs', 'repo', 'status']),
    )
    .argument('[site]', 'site URL or id (default: the only configured site)')
    .option(
      '--property <id>',
      'GSC property (sc-domain:example.com) or GA4 property (properties/123)',
    )
    .option('--key <key>', 'API key (PSI, Bing)')
    .option('--client-id <id>', 'Google OAuth client id (Desktop app)')
    .option('--client-secret <secret>', 'Google OAuth client secret')
    .option('--service-account <file>', 'Google service-account JSON key file')
    .option('--wp-url <url>', 'WordPress site URL')
    .option('--url <url>', 'same as --wp-url')
    .option('--wp-user <user>', 'WordPress user name')
    .option('--user <user>', 'same as --wp-user')
    .option(
      '--wp-app-password <password>',
      'WordPress application password (or set AVC_WP_APP_PASSWORD)',
    )
    .option('--path <paths>', 'log file paths/globs or repo path', collect)
    .option('--no-test', 'save settings without testing them')
    .action(run(cmdConnect));

  program
    .command('logs')
    .description('Analyse server access logs for verified AI crawler visits.')
    .argument('<files...>', 'access log files (plain or .gz)')
    .option('--site <url>', 'site URL, to list pages bots never fetched')
    .option('--no-verify', 'skip reverse-DNS / IP-range verification')
    .option('--json', 'print as JSON')
    .action(run(cmdLogs));

  program
    .command('diff')
    .description('Compare two audits: score, new and fixed issues, pages, AI visibility.')
    .argument('[a]', 'older audit id, or a site (compares its last two audits)')
    .argument('[b]', 'newer audit id (default: latest for the same site)')
    .option('--json', 'print as JSON')
    .option('--md', 'print as Markdown')
    .action(run(cmdDiff));

  program
    .command('history')
    .description('List stored audits and AI visibility runs for a site.')
    .argument('[site]', 'site URL or id (default: all sites)')
    .option('-n, --limit <n>', 'how many', int('--limit'), 20)
    .option('--json', 'print as JSON')
    .action(run(cmdHistory));

  program
    .command('report')
    .description('Write report files for a stored audit.')
    .argument('[auditId]', 'audit id, site, or "latest"', 'latest')
    .option('-f, --format <list>', 'html,json,md,csv,sarif', 'html')
    .option('-o, --out <dir>', 'output folder', 'avc-reports')
    .option('--open', 'open the HTML report')
    .action(run(cmdReport));

  const sites = program.command('sites').alias('site').description('List, add or remove sites.');
  sites
    .command('list', { isDefault: true })
    .description('List configured sites and sites with history.')
    .option('--json', 'print as JSON')
    .action(run(cmdSites));
  sites
    .command('add')
    .description('Add a site to ~/.avc/config.json.')
    .argument('<url>', 'site URL')
    .option('--name <brand>', 'brand name')
    .action(run(cmdSitesAdd));
  sites
    .command('remove')
    .description('Remove a site from ~/.avc/config.json.')
    .argument('<id>', 'site id')
    .option('--purge', 'also delete its stored audits and runs')
    .action(run(cmdSitesRemove));

  const monitor = program
    .command('monitor')
    .description('Scheduled audits and AI visibility checks, with alerts.');
  monitor
    .command('start', { isDefault: true })
    .description('Run every schedule in the foreground (Ctrl+C to stop).')
    .option('--once <site>', 'run one site now and exit')
    .action(run(cmdMonitor));
  monitor
    .command('run')
    .description('Run one scheduled job now: audit, diff against the last one, send alerts.')
    .argument('<site>', 'site URL or id')
    .option('--visibility', 'run the AI visibility job instead of the audit')
    .option('--dry-run-alerts', 'print alerts instead of sending them')
    .action(run(cmdMonitorRun));

  program
    .command('schedule')
    .description(
      'Set a schedule for a site and print the line to add to cron, launchd or Task Scheduler.',
    )
    .argument('<site>', 'site URL or id')
    .option('--cron <expr>', 'cron expression for audits, e.g. "0 6 * * 1"')
    .option('--visibility-cron <expr>', 'cron expression for AI visibility runs')
    .option('--install', 'install it in the system scheduler')
    .action(run(cmdSchedule));

  program
    .command('ui')
    .description('Open the local dashboard (127.0.0.1 only).')
    .option('-p, --port <n>', 'port', int('--port'))
    .option('--host <host>', 'listen address (non-loopback is exposed to your network)')
    .option('--no-open', 'do not open the browser')
    .option('--monitor', 'also run scheduled audits while the dashboard is open')
    .action(
      run(async (opts: { port?: number; host?: string; open?: boolean; monitor?: boolean }) => {
        const { startDashboard } = await import('../server/index.js');
        await startDashboard(opts);
      }),
    );

  program
    .command('mcp')
    .description('Run the MCP server on stdio for Claude Code, Claude Desktop, Cursor or VS Code.')
    .action(
      run(async () => {
        const { startMcpServer } = await import('../mcp/server.js');
        await startMcpServer();
      }),
    );

  program
    .command('checks')
    .description('List every check with its pillar, severity and fix tier.')
    .option('--category <id>', 'filter by category')
    .option(
      '--pillar <id>',
      'filter by pillar: technical, content, ai-access, geo, agentic, ai-visibility',
    )
    .option('-s, --search <text>', 'search titles and ids')
    .option('--json', 'print as JSON')
    .action(run(cmdChecks));

  program
    .command('doctor')
    .description('Check Node, Chrome, keys, the data folder and connections.')
    .option('--json', 'print as JSON')
    .action(run(cmdDoctor));

  return program;
}
