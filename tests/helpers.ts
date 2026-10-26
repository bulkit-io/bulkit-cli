import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Channel, Post } from 'bulkit';
import { afterEach } from 'vitest';
import { run } from '../src/cli';
import type { Env, InputStream, Runtime } from '../src/runtime';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

/** `response` is returned as is, for non-JSON replies such as a file download. */
export type RouteResult = { status?: number; body?: unknown; response?: Response };
export type Handler = (req: RecordedRequest) => RouteResult | undefined;

export interface RunOptions {
  /** Keyed by `METHOD /path` (without the `/public/v1` prefix). */
  routes?: Record<string, Handler | RouteResult>;
  env?: Env;
  stdin?: string;
  /** Pretend stdout/stderr/stdin are terminals. */
  tty?: boolean;
  configDir?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  requests: RecordedRequest[];
  configDir: string;
}

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tempConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'bulkit-cli-test-'));
  tempDirs.push(dir);
  return dir;
}

/** Runs the CLI in-process against a fake API, capturing everything it writes. */
export async function cli(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  const configDir = options.configDir ?? (await tempConfigDir());
  let stdout = '';
  let stderr = '';
  const requests: RecordedRequest[] = [];
  const tty = !!options.tty;

  const stdin = Readable.from(
    options.stdin === undefined ? [] : [options.stdin],
  ) as unknown as InputStream;
  stdin.isTTY = tty;

  const runtime: Runtime = {
    stdout: { write: (s: string) => (stdout += s), isTTY: tty, columns: 200 },
    stderr: { write: (s: string) => (stderr += s), isTTY: tty, columns: 200 },
    stdin,
    env: { BULKIT_NO_UPDATE_NOTIFIER: '1', ...options.env },
    configDir,
    sleep: async () => {},
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const path = url.pathname.replace(/^\/public\/v1/, '');
      const method = init?.method ?? 'GET';
      const raw = init?.body;
      const body = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const req = {
        method,
        path,
        query: url.searchParams,
        headers: new Headers(init?.headers),
        body,
      };
      requests.push(req);
      const route = options.routes?.[`${method} ${path}`];
      const result = typeof route === 'function' ? route(req) : route;
      if (!result) {
        return json(404, {
          error: { code: 'not_found', message: `No route for ${method} ${path}` },
        });
      }
      return result.response ?? json(result.status ?? 200, result.body);
    },
  };

  const code = await run(argv, runtime);
  return { code, stdout, stderr, requests, configDir };
}

function json(status: number, body: unknown): Response {
  if (status === 204 || body === undefined)
    return new Response(null, { status: status === 200 ? 204 : status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test' },
  });
}

export const TEST_KEY = 'bk_test_abcdef123456';
export const LIVE_KEY = 'bk_live_abcdef123456';

export const usage = {
  plan: 'pro',
  periodStart: '2026-10-01T00:00:00.000Z',
  periodEnd: '2026-11-01T00:00:00.000Z',
  posts: { created: { used: 3, limit: 100 }, published: 2 },
  channels: { used: 2, limit: 10 },
  storage: { bytesUsed: 1024, bytesLimit: null },
};

export function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'chn_x',
    platform: 'x',
    name: 'Acme',
    username: 'acme',
    needsReconnect: false,
    metricsStatus: 'reporting',
    manageStatus: 'available',
    continuationStatus: 'available',
    commentsStatus: 'available',
    connectedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

export const channels: Channel[] = [
  channel(),
  channel({ id: 'chn_li', platform: 'linkedin', name: 'Acme Inc', username: null }),
  channel({ id: 'chn_ig1', platform: 'instagram', name: 'Acme IG', username: 'acme.ig' }),
  channel({ id: 'chn_ig2', platform: 'instagram', name: 'Acme Shop', username: 'acme.shop' }),
];

export function post(overrides: Partial<Post> = {}): Post {
  return {
    id: 'pst_1',
    status: 'draft',
    scheduledAt: null,
    publishedAt: null,
    channels: [
      {
        channelId: 'chn_x',
        platform: 'x',
        status: 'draft',
        error: null,
        publishedAt: null,
        remoteUrl: null,
        options: {},
        blocks: [{ content: 'Hello', media: [], mediaUserTags: {}, remoteUrl: null }],
      },
    ],
    tags: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    ...overrides,
  };
}
