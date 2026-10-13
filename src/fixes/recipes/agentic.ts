/**
 * Agentic-web recipes: A2A agent card, MCP server card, OAuth discovery, markdown content
 * negotiation, WebMCP form attributes, API catalogue and agentic commerce.
 */
import {
  generateAgentCard,
  generateMcpServerCard,
  generateProtectedResourceMetadata,
  inferBrandName,
} from '../generate.js';
import { byStack, headersFix, staticFile, templateFile } from '../stacks.js';
import type { Recipe, RecipeInput, StackFix } from '../types.js';

function brandFor(input: RecipeInput) {
  const name = input.brand?.name ?? inferBrandName({ site: input.origin, pages: input.pages });
  return { ...input.brand, name, url: input.origin };
}

/** The probe path from the issue when the check reported one. */
function probePath(input: RecipeInput, fallback: string): string {
  for (const i of input.issues) {
    const u = (i.data?.url as string | undefined) ?? i.url;
    if (u && /\/\.well-known\//.test(u)) return new URL(u).pathname.replace(/^\//, '');
  }
  return fallback;
}

const onlyIfReal =
  'Publish this only if the endpoint exists. A card that points to nothing is worse than no card: agents will try it and fail.';

const a2a: Recipe = {
  id: 'a2a-agent-card',
  patterns: [/^agentic\.a2a/, /agent-card/],
  impact: 'low',
  effort: 'days',
  build(input) {
    const path = probePath(input, '.well-known/agent-card.json');
    const card = generateAgentCard(brandFor(input));
    const f = staticFile(input, path, JSON.stringify(card, null, 2), 'json');
    return {
      ...f,
      title: 'Publish an A2A agent card (if you run an agent)',
      steps: [
        onlyIfReal,
        'If you run (or plan) an A2A agent for enquiries, bookings or support, set `url` to its JSON-RPC endpoint and describe its real skills.',
        'If you do not run one, you can ignore this check: it only matters for sites that offer an agent.',
        ...f.steps,
      ],
    };
  },
};

const mcpCard: Recipe = {
  id: 'mcp-server-card',
  patterns: [/^agentic\.mcp/, /server-card|mcp-card/],
  impact: 'low',
  effort: 'days',
  build(input) {
    const path = probePath(input, '.well-known/mcp/server-card.json');
    const card = generateMcpServerCard(brandFor(input));
    const f = staticFile(input, path, JSON.stringify(card, null, 2), 'json');
    return {
      ...f,
      title: 'Describe your MCP server in a server card (if you run one)',
      steps: [
        onlyIfReal,
        'Set `remotes[0].url` to the real MCP endpoint and list its tools. If the server needs sign-in, publish OAuth protected-resource metadata too.',
        ...f.steps,
      ],
    };
  },
};

const oauth: Recipe = {
  id: 'oauth-discovery',
  patterns: [/^agentic\..*(oauth|protected-resource|authorization-server|openid)/],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const meta = generateProtectedResourceMetadata(input.origin, 'https://auth.example.com');
    const f = staticFile(
      input,
      '.well-known/oauth-protected-resource',
      JSON.stringify(meta, null, 2),
      'json',
    );
    return {
      ...f,
      title: 'Publish OAuth discovery metadata for your API / MCP server',
      steps: [
        'Agents discover how to sign in from `/.well-known/oauth-protected-resource` (RFC 9728) on the resource, and `/.well-known/oauth-authorization-server` (RFC 8414) on the authorisation server.',
        'Replace `authorization_servers` with your real issuer (Auth0, Clerk, WorkOS, Cognito… publish the server metadata for you), and return a `WWW-Authenticate` header with `resource_metadata` on 401s.',
        ...f.steps,
      ],
    };
  },
};

function markdownNegotiation(input: RecipeInput): StackFix {
  return byStack(input, {
    'nextjs-app': () => ({
      steps: [
        'Add a route that returns a page as markdown (e.g. `app/md/[...path]/route.ts` reading your content source), then rewrite requests that prefer markdown to it in `middleware.ts` (`proxy.ts` on Next.js 16).',
        'Send `Vary: Accept` on both versions so caches keep them apart.',
      ],
      files: ['middleware.ts (or proxy.ts)', 'app/md/[...path]/route.ts'],
      snippet: {
        language: 'ts',
        code: `// middleware.ts (proxy.ts on Next.js 16)
import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  const accept = req.headers.get('accept') ?? '';
  if (accept.includes('text/markdown')) {
    const url = req.nextUrl.clone();
    url.pathname = '/md' + (url.pathname === '/' ? '/index' : url.pathname);
    return NextResponse.rewrite(url);
  }
}

export const config = { matcher: ['/((?!_next|api|md|.*\\\\..*).*)'] };`,
      },
    }),
    wordpress: () => ({
      steps: [
        'Use a plugin that serves posts as markdown on `Accept: text/markdown` (search the plugin directory for "markdown for agents"), or the Cloudflare Worker below.',
      ],
      files: ['WordPress plugin or Cloudflare Worker'],
    }),
    unknown: () => ({
      steps: [
        'Build markdown copies of your pages (e.g. `/about.md`) at build time, then return them when the request has `Accept: text/markdown`. A Cloudflare Worker can do this in front of any stack (below).',
      ],
      files: ['Cloudflare Worker', 'build step that writes *.md'],
      snippet: {
        language: 'javascript',
        code: `export default {
  async fetch(request) {
    const accept = request.headers.get('accept') || '';
    const url = new URL(request.url);
    if (accept.includes('text/markdown') && !url.pathname.endsWith('.md')) {
      const mdUrl = new URL(url);
      mdUrl.pathname = (url.pathname.replace(/\\/$/, '') || '/index') + '.md';
      const md = await fetch(mdUrl, { headers: { accept: 'text/markdown' } });
      if (md.ok) {
        const res = new Response(md.body, md);
        res.headers.set('content-type', 'text/markdown; charset=utf-8');
        res.headers.set('vary', 'Accept');
        return res;
      }
    }
    const orig = await fetch(request);
    const res = new Response(orig.body, orig);
    res.headers.append('vary', 'Accept');
    return res;
  },
};`,
      },
    }),
  });
}

const markdown: Recipe = {
  id: 'markdown-negotiation',
  patterns: [/^agentic\..*(markdown|content-negotiation|accept)/],
  impact: 'low',
  effort: 'hours',
  build(input) {
    return {
      title: 'Serve markdown to agents that ask for it',
      ...markdownNegotiation(input),
      acceptance: [
        `\`curl -H "Accept: text/markdown" ${input.origin}/\` returns markdown with content-type text/markdown`,
        'Browsers still get HTML',
      ],
    };
  },
};

const webmcp: Recipe = {
  id: 'webmcp-forms',
  patterns: [/^agentic\..*(webmcp|form|toolname)/],
  impact: 'low',
  effort: 'hours',
  build(input) {
    return {
      title: 'Describe your key forms for browser agents (WebMCP)',
      steps: [
        'WebMCP (a W3C community proposal) lets a page declare its forms as tools that browser agents can call. The declarative form adds `toolname` and `tooldescription` attributes to a `<form>`.',
        'Start with the forms that matter (contact, quote, booking, search). Every input needs a `name` and a `<label>`.',
        'Browsers without WebMCP ignore the attributes, so this is safe to add.',
        `Forms flagged:\n${input.urls
          .slice(0, 10)
          .map((u) => `- ${u}`)
          .join('\n')}`,
      ],
      files: [templateFile(input)],
      snippet: {
        language: 'html',
        code: `<form action="/contact" method="post" toolname="contact_sales" tooldescription="Send a message to the sales team. Returns a confirmation.">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required />
  <label for="message">Message</label>
  <textarea id="message" name="message" required></textarea>
  <button type="submit">Send</button>
</form>`,
      },
    };
  },
};

const apiCatalog: Recipe = {
  id: 'api-catalog',
  patterns: [/^agentic\..*(api-catalog|openapi|linkset)/],
  impact: 'low',
  effort: 'hours',
  build(input) {
    const body = JSON.stringify(
      {
        linkset: [
          {
            anchor: `${input.origin}/api`,
            'service-desc': [
              { href: `${input.origin}/openapi.json`, type: 'application/openapi+json' },
            ],
            'service-doc': [{ href: `${input.origin}/docs/api`, type: 'text/html' }],
          },
        ],
      },
      null,
      2,
    );
    const f = staticFile(input, '.well-known/api-catalog', body, 'json');
    return {
      ...f,
      title: 'Publish an API catalogue',
      steps: [
        'If you have a public API, list it at `/.well-known/api-catalog` (RFC 9727, `application/linkset+json`) pointing at the OpenAPI document and docs.',
        ...f.steps,
      ],
    };
  },
};

const agentHeaders: Recipe = {
  id: 'agentic-link-headers',
  patterns: [/^agentic\..*(link-header|discovery-header)/],
  impact: 'low',
  effort: 'minutes',
  build(input) {
    const f = headersFix(
      input,
      { Link: '</llms.txt>; rel="describedby"; type="text/plain"' },
      { path: '/' },
    );
    return { ...f, title: input.def.title };
  },
};

const commerce: Recipe = {
  id: 'agentic-commerce',
  patterns: ['agentic-commerce.*'],
  impact: 'low',
  effort: 'days',
  tier: 'manual',
  build(input) {
    return {
      title: input.def.title,
      steps: [
        input.def.fix,
        input.stack.id === 'shopify'
          ? 'On Shopify, agentic checkout is handled by Shopify’s own integrations: check the sales channels and apps available for your plan rather than building it.'
          : 'Decide whether agent-led purchases fit your business before building; this needs product data, checkout and payment integration work.',
      ],
      files: ['product feed', 'checkout'],
    };
  },
};

const agenticGeneric: Recipe = {
  id: 'agentic-generic',
  patterns: ['agentic.*'],
  impact: 'low',
  effort: 'hours',
  build(input) {
    return { title: input.def.title, steps: [input.def.fix], files: [templateFile(input)] };
  },
};

export const recipes: Recipe[] = [
  a2a,
  mcpCard,
  oauth,
  markdown,
  webmcp,
  apiCatalog,
  agentHeaders,
  commerce,
  agenticGeneric,
];
