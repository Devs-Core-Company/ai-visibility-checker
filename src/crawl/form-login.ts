/**
 * Sign in through a site's login form with the user's Chrome, then hand the
 * session cookies to the crawler so members-only pages can be audited.
 *
 * Safety: the username and password come only from the environment
 * (AVC_FORM_USER, AVC_FORM_PASS), never from a config file, the dashboard or
 * the MCP server. While signed in, the crawler skips links that log out,
 * delete or open admin areas (see DANGEROUS_LINK). Use a throwaway account
 * with the least access that still sees the pages you want audited.
 */
import { findChrome } from './render.js';

export interface FormLoginOptions {
  url: string;
  userSelector?: string;
  passSelector?: string;
  submitSelector?: string;
  chromePath?: string;
  timeoutMs?: number;
}

export interface FormLoginResult {
  ok: boolean;
  cookie?: string;
  cookies?: number;
  error?: string;
}

const USER_FIELDS = [
  'input[type="email"]',
  'input[name="log"]',
  'input[name="username"]',
  'input[name="user"]',
  'input[name="email"]',
  'input[name="login"]',
  'input[autocomplete="username"]',
  'input[type="text"]',
];
const PASS_FIELDS = ['input[type="password"]'];
const SUBMIT = ['button[type="submit"]', 'input[type="submit"]', 'form button'];

export function formCredentials(env = process.env): { user: string; pass: string } | null {
  const user = env.AVC_FORM_USER?.trim();
  const pass = env.AVC_FORM_PASS;
  return user && pass ? { user, pass } : null;
}

/** Cookie header from Playwright cookies (name=value; …), only for cookies scoped to `host`. */
export function cookieHeader(
  cookies: { name: string; value: string; domain: string }[],
  host: string,
): string {
  const h = host.toLowerCase();
  return cookies
    .filter((c) => {
      const d = c.domain.replace(/^\./, '').toLowerCase();
      return h === d || h.endsWith(`.${d}`) || d.endsWith(`.${h}`);
    })
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

export async function formLogin(opts: FormLoginOptions): Promise<FormLoginResult> {
  const creds = formCredentials();
  if (!creds) return { ok: false, error: 'Set AVC_FORM_USER and AVC_FORM_PASS to sign in.' };
  const chromePath = findChrome(opts.chromePath);
  if (!chromePath)
    return { ok: false, error: 'Form sign-in needs Chrome, Chromium or Edge (AVC_CHROME_PATH).' };
  let browser: import('playwright-core').Browser | null = null;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const timeout = opts.timeoutMs ?? 30_000;
    await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout });
    const fill = async (selectors: string[], value: string): Promise<boolean> => {
      for (const s of selectors) {
        const el = page.locator(s).first();
        if ((await el.count()) && (await el.isVisible().catch(() => false))) {
          await el.fill(value);
          return true;
        }
      }
      return false;
    };
    if (!(await fill(opts.userSelector ? [opts.userSelector] : USER_FIELDS, creds.user)))
      return { ok: false, error: 'Could not find the username field on the login page.' };
    if (!(await fill(opts.passSelector ? [opts.passSelector] : PASS_FIELDS, creds.pass)))
      return { ok: false, error: 'Could not find the password field on the login page.' };
    const before = page.url();
    let clicked = false;
    for (const s of opts.submitSelector ? [opts.submitSelector] : SUBMIT) {
      const el = page.locator(s).first();
      if (await el.count()) {
        await Promise.all([
          page.waitForLoadState('load', { timeout }).catch(() => {}),
          el.click({ timeout }),
        ]);
        clicked = true;
        break;
      }
    }
    if (!clicked) await page.keyboard.press('Enter');
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    const host = new URL(opts.url).hostname;
    const cookies = await context.cookies();
    const cookie = cookieHeader(cookies, host);
    const stillOnForm = (await page.locator('input[type="password"]').count()) > 0;
    if (!cookie || (stillOnForm && page.url() === before))
      return { ok: false, error: 'Sign-in did not seem to work (still on the login form).' };
    return { ok: true, cookie, cookies: cookies.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message.split('\n')[0] };
  } finally {
    await browser?.close().catch(() => {});
  }
}
