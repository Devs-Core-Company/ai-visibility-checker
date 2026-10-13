# Connections

Connected data is optional. Each source works on its own; if one fails, the audit
carries on and the report says what was missing. Check what is set up with the
dashboard's **Connections** page.

Secrets go in environment variables or `~/.avc/config.json` (mode 600), never in
`avc.config.json` in your project.

## Google (Search Console, GA4)

You need a Google Cloud project once. Pick **one** sign-in method.

1. Open <https://console.cloud.google.com/>, create a project (or reuse one).
2. **APIs & Services → Library**, enable:
   - Google Search Console API
   - Google Analytics Data API
   - Google Analytics Admin API (lets AVC find your GA4 property by itself)
   - PageSpeed Insights API (only if you create a PSI key, below)

### Option A: sign in with your Google account (OAuth, best for one person)

1. **APIs & Services → OAuth consent screen**: user type _External_ (or _Internal_
   on Workspace), fill in the app name and your email. Under _Test users_ add the
   Google account that has access to Search Console and GA4. Apps left in
   _Testing_ status make Google sign-ins expire after 7 days; publish the app
   (no review is needed for these read-only scopes for your own use) to avoid that.
2. **Credentials → Create credentials → OAuth client ID**, application type
   **Desktop app**. Copy the client ID and secret.
3. Set them and sign in:

   ```bash
   export GOOGLE_CLIENT_ID=…apps.googleusercontent.com
   export GOOGLE_CLIENT_SECRET=…
   avc connect google
   ```

   A browser opens; allow access. AVC listens once on `127.0.0.1` on a random
   port, uses PKCE, and stores the refresh token in `~/.avc/tokens/google.json`
   (mode 600). Scopes: `webmasters.readonly`, `analytics.readonly`.

To disconnect: delete `~/.avc/tokens/google.json`, and remove the app at
<https://myaccount.google.com/permissions>.

### Option B: service account (best for servers and CI)

1. **IAM & Admin → Service accounts → Create**. No project roles are needed.
2. Open it → **Keys → Add key → JSON**. Save the file somewhere private.
3. Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json` (or
   `google.serviceAccountFile` in `~/.avc/config.json`).
4. Give the service-account email (`…@….iam.gserviceaccount.com`) access:
   - **Search Console** → your property → Settings → Users and permissions →
     Add user → _Restricted_ is enough.
   - **GA4** → Admin → Property access management → **+** → _Viewer_.

### Which property

- Search Console: AVC picks a URL-prefix property for the exact origin, then a
  Domain property (`sc-domain:example.com`), then the closest URL-prefix. Override
  with `connections.gscProperty`.
- GA4: AVC looks for a property whose web stream URL matches the site. Override
  with `connections.ga4Property` (e.g. `properties/123456789`, from GA4 → Admin →
  Property details).

### What is collected

- Search Console: clicks, impressions, CTR and position for the last 28 days
  (pages and queries, up to 1,000 each), sitemap status, and URL Inspection for
  up to 10 key pages (the API allows 2,000 inspections a day per property).
- GA4: sessions whose source is an AI assistant (ChatGPT, Perplexity, Gemini,
  Claude, Copilot, You.com, Phind, Meta AI, DeepSeek, Grok, Mistral Le Chat, Poe,
  Qwen, Doubao), with engaged sessions, key events and landing pages.

### Common errors

| Message                              | Fix                                                                 |
| ------------------------------------ | ------------------------------------------------------------------- |
| _… API is not enabled_               | Open the link in the message, click **Enable**, wait a few minutes. |
| _… has no access to …_               | Add the account or service-account email as a user (see above).     |
| _sign-in has expired or was revoked_ | Run `avc connect google` again; publish the consent screen.         |
| _access_denied_                      | Add your account as a test user on the OAuth consent screen.        |

## PageSpeed Insights

Works without a key at low volume (AVC then tests the home page only). Set `AVC_PSI=off` to skip PageSpeed Insights entirely. With a
free key it tests the home page and the most-linked pages, mobile and desktop.

1. In the same Google Cloud project, enable **PageSpeed Insights API**.
2. **Credentials → Create credentials → API key**. Restrict it to that API.
3. `export PSI_API_KEY=…`

## Bing Webmaster Tools

Bing's index feeds ChatGPT search and Microsoft Copilot.

1. Sign in at <https://www.bing.com/webmasters>, add your site (you can import it
   from Search Console) and verify it.
2. **Settings (gear) → API access → API key → Generate**.
3. `export BING_WEBMASTER_API_KEY=…`

AVC reads traffic, crawl stats, crawl issues and the URL-submission quota.

### IndexNow

IndexNow tells Bing (and Yandex, Seznam, Naver, Yep) about new or changed URLs at
once. Create a key (8–128 letters, digits or dashes, e.g. 32 random hex characters), upload a file named
`<key>.txt` containing only the key to the site root, and AVC can check it and
submit changed URLs.

## Server access logs (AI crawler visits)

Logs show which AI crawlers really visit, what they fetch, which errors they get,
and which important pages they never fetched. AVC verifies each claimed bot against
the operator's published IP ranges (cached for 7 days in `~/.avc/cache/ip-ranges`)
and, for Googlebot, Bingbot, Applebot and others that document it, reverse DNS.
Requests that fail the check are counted as spoofed.

Set paths or globs in your site config:

```json
{ "connections": { "logs": ["/var/log/nginx/access.log*", "~/exports/cloudflare/*.json.gz"] } }
```

Gzip files are read directly. Supported formats: Nginx/Apache _combined_ and
_vhost_combined_, Caddy JSON, Cloudflare Logpush, Vercel and Netlify log drains,
and most JSON-per-line exports with IP, path, status and user-agent fields.
JSON must be one object per line (NDJSON), not pretty-printed.

Where to find them:

- **Nginx**: `/var/log/nginx/access.log` (rotated: `access.log.1`, `access.log.2.gz`).
  The default `combined` format is fine. Behind a CDN or load balancer, log the
  real client IP (`real_ip_header` / `set_real_ip_from`), or verification will fail.
- **Apache**: `/var/log/apache2/access.log` (Debian/Ubuntu) or
  `/var/log/httpd/access_log` (RHEL). Use `CustomLog … combined`. Behind a proxy
  enable `mod_remoteip`.
- **Caddy**: add `log { output file /var/log/caddy/access.log format json }` to the site block.
- **Cloudflare**: Logpush (Enterprise) to R2/S3 with the `http_requests` dataset,
  fields `ClientIP, ClientRequestURI, ClientRequestUserAgent, EdgeResponseStatus,
EdgeStartTimestamp`. Download the files and point AVC at them.
- **Vercel**: Project → Settings → Log Drains (Pro and above), or export from
  Observability. Point AVC at the saved NDJSON. Runtime logs alone do not cover static files.
- **Netlify**: Log Drains (Enterprise) with _Traffic logs_, saved as NDJSON.
- **Shared hosting / cPanel**: _Metrics → Raw Access_, download the `.gz` files.

## WordPress

AVC uses the REST API with an Application Password (built into WordPress 5.6+).

1. In WordPress go to **Users → Profile → Application Passwords**, enter a name
   (e.g. "AI Visibility Checker") and click **Add New Application Password**.
   Use an Editor or Administrator account.
2. Set it in your site config, with the password in an environment variable:

   ```json
   { "connections": { "wordpress": { "url": "https://example.com", "user": "your-username" } } }
   ```

   ```bash
   export AVC_WP_APP_PASSWORD="abcd efgh ijkl mnop qrst uvwx"
   ```

The connection test reports the WordPress version, what the user may do and the
SEO plugin (Yoast, Rank Math, AIOSEO, SEOPress, The SEO Framework, Slim SEO).
If it says WordPress did not receive the login, your host strips the
`Authorization` header; add this to `.htaccess`:

```
SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1
```

Security plugins that block `/wp-json/` must allow it for the user.
