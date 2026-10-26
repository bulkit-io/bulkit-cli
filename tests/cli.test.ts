import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { channels, cli, LIVE_KEY, post, TEST_KEY, tempConfigDir, usage } from './helpers';

const auth = { env: { BULKIT_API_KEY: TEST_KEY } };
const live = { env: { BULKIT_API_KEY: LIVE_KEY } };

describe('basics', () => {
  it('prints help and exits 0 with no arguments', async () => {
    const r = await cli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Usage: bulkit');
    expect(r.stdout).toContain('Core commands:');
  });

  it('prints the version', async () => {
    const r = await cli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exits 2 and suggests a fix for an unknown command', async () => {
    const r = await cli(['post', 'lst']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Did you mean one of list');
  });

  it('exits 2 for an invalid option value', async () => {
    const r = await cli(['posts', 'list', '--limit', 'zero'], auth);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('positive integer');
  });

  it('exits 2 when a group is called without a subcommand', async () => {
    const r = await cli(['posts']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Usage: bulkit posts');
  });
});

describe('auth', () => {
  it('fails with exit 3 and a hint when not logged in', async () => {
    const r = await cli(['channels', 'list']);
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('You are not logged in.');
    expect(r.stderr).toContain('bulkit auth login');
    expect(r.requests).toHaveLength(0);
  });

  it('logs in from stdin, validates the key, and stores it owner-only', async () => {
    const r = await cli(['auth', 'login', '--with-key'], {
      stdin: `${TEST_KEY}\n`,
      routes: { 'GET /usage': { body: usage } },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Logged in to profile "default" with a test key');
    expect(r.requests[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);

    const path = join(r.configDir, 'config.json');
    const config = JSON.parse(await readFile(path, 'utf8'));
    expect(config).toEqual({ version: 1, profiles: { default: { apiKey: TEST_KEY } } });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600);

    // The saved key is then used by other commands.
    const next = await cli(['channels', 'list', '--json'], {
      configDir: r.configDir,
      routes: { 'GET /channels': { body: channels } },
    });
    expect(next.code).toBe(0);
    expect(next.requests[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
  });

  it('refuses a malformed key without calling the API or saving anything', async () => {
    const r = await cli(['auth', 'login', '--with-key'], { stdin: 'sk_nope' });
    expect(r.code).toBe(3);
    expect(r.requests).toHaveLength(0);
    await expect(stat(join(r.configDir, 'config.json'))).rejects.toThrow();
  });

  it('does not save a key the API rejects', async () => {
    const r = await cli(['auth', 'login', '--with-key'], {
      stdin: TEST_KEY,
      routes: {
        'GET /usage': {
          status: 401,
          body: { error: { code: 'invalid_api_key', message: 'Invalid API key.' } },
        },
      },
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('Invalid API key.');
    await expect(stat(join(r.configDir, 'config.json'))).rejects.toThrow();
  });

  it('asks for --with-key instead of prompting when there is no terminal', async () => {
    const r = await cli(['auth', 'login']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--with-key');
  });

  it('keeps profiles apart', async () => {
    const dir = await tempConfigDir();
    const routes = { 'GET /usage': { body: usage } };
    await cli(['auth', 'login', '--with-key', '--profile', 'acme'], {
      stdin: LIVE_KEY,
      routes,
      configDir: dir,
    });
    const missing = await cli(['usage'], { configDir: dir, routes });
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain('auth login');
    const found = await cli(['usage', '--profile', 'acme'], { configDir: dir, routes });
    expect(found.code).toBe(0);
    const viaEnv = await cli(['usage'], {
      configDir: dir,
      routes,
      env: { BULKIT_PROFILE: 'acme' },
    });
    expect(viaEnv.code).toBe(0);
  });

  it('reports status as JSON with the key masked', async () => {
    const r = await cli(['auth', 'status', '--json'], {
      ...auth,
      routes: { 'GET /usage': { body: usage } },
    });
    expect(r.code).toBe(0);
    const status = JSON.parse(r.stdout);
    expect(status).toMatchObject({ profile: 'default', source: 'env', mode: 'test', plan: 'pro' });
    expect(status.key).toBe('bk_test_…3456');
    expect(r.stdout).not.toContain(TEST_KEY);
  });

  it('logs out idempotently', async () => {
    const r = await cli(['auth', 'logout']);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('was not logged in');
  });

  it('explains a corrupt config file', async () => {
    const dir = await tempConfigDir();
    await writeFile(join(dir, 'config.json'), '{nope');
    const r = await cli(['usage'], { configDir: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('not valid JSON');
  });
});

describe('output', () => {
  const routes = { 'GET /channels': { body: channels } };

  it('prints the API objects unchanged with --json', async () => {
    const r = await cli(['channels', 'list', '--json'], { ...auth, routes });
    expect(JSON.parse(r.stdout)).toEqual(channels);
    expect(r.stderr).toBe('');
  });

  it('prints headerless tab-separated rows when stdout is not a terminal', async () => {
    const r = await cli(['channels', 'list'], { ...auth, routes });
    const [first] = r.stdout.trim().split('\n');
    expect(first?.split('\t').slice(0, 4)).toEqual(['chn_x', 'x', 'Acme', '@acme']);
    expect(r.stdout).not.toContain('PLATFORM');
    expect(r.stdout).not.toContain('\u001b[');
  });

  it('prints an aligned table with headers on a terminal', async () => {
    const r = await cli(['channels', 'list'], {
      ...auth,
      routes,
      tty: true,
      env: { BULKIT_API_KEY: TEST_KEY, NO_COLOR: '1' },
    });
    expect(r.stdout.split('\n')[0]).toMatch(/^ID\s+PLATFORM\s+NAME/);
    expect(r.stdout).not.toContain('\u001b[');
  });

  it('identifies itself in the User-Agent', async () => {
    const r = await cli(['channels', 'list'], { ...auth, routes });
    expect(r.requests[0]?.headers.get('user-agent')).toMatch(/^bulkit-cli\/\S+ bulkit-node\/\S+$/);
  });

  it('logs requests to stderr with --debug, never the key', async () => {
    const r = await cli(['channels', 'list', '--debug'], { ...auth, routes });
    expect(r.stderr).toContain('→ GET https://api.bulkit.io/public/v1/channels');
    expect(r.stderr).toContain('← 200');
    expect(r.stderr).not.toContain(TEST_KEY);
  });
});

describe('API errors', () => {
  const failing = (status: number, error: object) => ({
    ...auth,
    routes: { 'GET /posts/pst_1': { status, body: { error: { requestId: 'req_abc', ...error } } } },
  });

  it('maps 404 to exit 4 and shows the request id', async () => {
    const r = await cli(
      ['posts', 'get', 'pst_1'],
      failing(404, { code: 'not_found', message: 'Post not found.' }),
    );
    expect(r.code).toBe(4);
    expect(r.stderr).toContain('Error: Post not found.');
    expect(r.stderr).toContain('Request ID: req_abc');
  });

  it('maps 402 to exit 5 with a pointer to usage', async () => {
    const r = await cli(
      ['posts', 'get', 'pst_1'],
      failing(402, { code: 'quota_exceeded', message: 'Quota exceeded.' }),
    );
    expect(r.code).toBe(5);
    expect(r.stderr).toContain('bulkit usage');
  });

  it('lists field errors, and emits them as JSON with --json', async () => {
    const opts = failing(400, {
      code: 'validation_failed',
      message: 'Invalid request.',
      details: [{ field: 'channels[0].blocks', message: 'must not be empty' }],
    });
    const human = await cli(['posts', 'get', 'pst_1'], opts);
    expect(human.code).toBe(1);
    expect(human.stderr).toContain('channels[0].blocks: must not be empty');

    const machine = await cli(['posts', 'get', 'pst_1', '--json'], opts);
    expect(machine.stdout).toBe('');
    const { error } = JSON.parse(machine.stderr);
    expect(error).toMatchObject({
      status: 400,
      code: 'validation_failed',
      requestId: 'req_abc',
      exitCode: 1,
    });
  });
});

describe('posts create', () => {
  const created = (req: { body: unknown }) => {
    const body = req.body as { intent: string; scheduledAt?: string };
    const status =
      body.intent === 'now' ? 'publishing' : body.intent === 'schedule' ? 'scheduled' : 'draft';
    return {
      status: 201,
      body: post({ id: 'pst_new', status: status as never, scheduledAt: body.scheduledAt ?? null }),
    };
  };
  const routes = { 'GET /channels': { body: channels }, 'POST /posts': created };

  it('resolves channels by @username, name and platform, and drafts by default', async () => {
    const r = await cli(['posts', 'create', '-c', '@acme', '-c', 'Acme Inc', '-t', 'Hello'], {
      ...auth,
      routes,
    });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('pst_new');
    const sent = r.requests.find((q) => q.method === 'POST');
    expect(sent?.body).toEqual({
      intent: 'draft',
      channels: [
        { channelId: 'chn_x', blocks: [{ content: 'Hello' }] },
        { channelId: 'chn_li', blocks: [{ content: 'Hello' }] },
      ],
    });
    expect(sent?.headers.get('idempotency-key')).toBeTruthy();
  });

  it('builds a thread from repeated --text and attaches media to the first block', async () => {
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'one', '-t', 'two', '-m', 'med_1'], {
      ...auth,
      routes,
    });
    expect(r.code).toBe(0);
    const sent = r.requests.find((q) => q.method === 'POST')?.body as {
      channels: { blocks: unknown[] }[];
    };
    expect(sent.channels[0]?.blocks).toEqual([
      { content: 'one', mediaIds: ['med_1'] },
      { content: 'two' },
    ]);
  });

  it('refuses an ambiguous channel instead of guessing', async () => {
    const r = await cli(['posts', 'create', '-c', 'instagram', '-t', 'Hi'], { ...auth, routes });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('matches 2 channels');
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
  });

  it('schedules relative to now', async () => {
    const before = Date.now();
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--at', '+2h'], {
      ...auth,
      routes,
    });
    expect(r.code).toBe(0);
    const sent = r.requests.find((q) => q.method === 'POST')?.body as {
      intent: string;
      scheduledAt: string;
    };
    expect(sent.intent).toBe('schedule');
    const at = Date.parse(sent.scheduledAt) - before;
    expect(at).toBeGreaterThanOrEqual(2 * 3_600_000 - 1000);
    expect(at).toBeLessThan(2 * 3_600_000 + 60_000);
  });

  it('rejects a time in the past before sending anything', async () => {
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--at', '2020-01-01T09:00Z'], {
      ...auth,
      routes,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('in the past');
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
  });

  it('rejects --now together with --at', async () => {
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--now', '--at', '+1h'], {
      ...auth,
      routes,
    });
    expect(r.code).toBe(2);
  });

  it('prints the body and sends nothing with --dry-run', async () => {
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--dry-run'], {
      ...auth,
      routes,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      intent: 'draft',
      channels: [{ channelId: 'chn_x' }],
    });
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);
  });

  it('requires --yes to publish now with a live key when it cannot prompt', async () => {
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--now'], { ...live, routes });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--yes');
    expect(r.requests.some((q) => q.method === 'POST')).toBe(false);

    const yes = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--now', '--yes'], {
      ...live,
      routes,
    });
    expect(yes.code).toBe(0);
  });

  it('asks on a terminal, and does nothing when the answer is no', async () => {
    const no = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--now'], {
      ...live,
      routes,
      tty: true,
      stdin: 'n\n',
    });
    expect(no.code).toBe(1);
    expect(no.stderr).toContain('Cancelled');
    expect(no.requests.some((q) => q.method === 'POST')).toBe(false);

    const yes = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--now'], {
      ...live,
      routes,
      tty: true,
      stdin: 'y\n',
    });
    expect(yes.code).toBe(0);
    expect(yes.requests.some((q) => q.method === 'POST')).toBe(true);
  });

  it('never prompts with --no-input, even on a terminal', async () => {
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--now', '--no-input'], {
      ...live,
      routes,
      tty: true,
      stdin: 'y\n',
    });
    expect(r.code).toBe(2);
  });

  it('publishes without confirmation in test mode', async () => {
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--now'], { ...auth, routes });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Queued pst_new');
  });

  it('waits for the outcome with --wait and exits 1 if a channel failed', async () => {
    let polls = 0;
    const waiting = (final: 'published' | 'failed') => ({
      ...auth,
      routes: {
        ...routes,
        'GET /posts/pst_new': () => {
          polls++;
          return { body: post({ id: 'pst_new', status: polls < 3 ? 'publishing' : final }) };
        },
      },
    });

    const ok = await cli(
      ['posts', 'create', '-c', 'x', '-t', 'Hi', '--now', '--wait'],
      waiting('published'),
    );
    expect(ok.code).toBe(0);
    expect(polls).toBe(3);
    expect(ok.stderr).toContain('Published pst_new');

    polls = 0;
    const failed = await cli(
      ['posts', 'create', '-c', 'x', '-t', 'Hi', '--now', '--wait', '--json'],
      waiting('failed'),
    );
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout).status).toBe('failed');
  });

  it('reads a full body from stdin with --file -', async () => {
    const body = {
      intent: 'draft',
      channels: [{ channelId: 'chn_x', blocks: [{ content: 'From JSON' }] }],
    };
    const r = await cli(['posts', 'create', '--file', '-', '--at', '+1d', '--tag', 'tag_1'], {
      ...auth,
      routes,
      stdin: JSON.stringify(body),
    });
    expect(r.code).toBe(0);
    const sent = r.requests.find((q) => q.method === 'POST')?.body as Record<string, unknown>;
    expect(sent).toMatchObject({ intent: 'schedule', tagIds: ['tag_1'], channels: body.channels });
    // --file is used as-is: no channel lookup.
    expect(r.requests.some((q) => q.path === '/channels')).toBe(false);
  });

  it('rejects --file combined with content flags', async () => {
    const r = await cli(['posts', 'create', '--file', 'post.json', '-t', 'Hi'], {
      ...auth,
      routes,
    });
    expect(r.code).toBe(2);
  });
});

describe('posts retract', () => {
  it('requires typing the post id on a terminal with a live key', async () => {
    const routes = {
      'GET /posts/pst_1': { body: post({ status: 'published' }) },
      'POST /posts/pst_1/retract': {
        body: { removed: [{ channelId: 'chn_x', platform: 'x', reason: null }], remaining: [] },
      },
    };
    const wrong = await cli(['posts', 'retract', 'pst_1'], {
      ...live,
      routes,
      tty: true,
      stdin: 'y\n',
    });
    expect(wrong.code).toBe(1);
    expect(wrong.requests.some((q) => q.method === 'POST')).toBe(false);

    const right = await cli(['posts', 'retract', 'pst_1'], {
      ...live,
      routes,
      tty: true,
      stdin: 'pst_1\n',
    });
    expect(right.code).toBe(0);
    expect(right.stderr).toContain('Removed from x');
  });

  it('exits 1 when copies remain live', async () => {
    const r = await cli(['posts', 'retract', 'pst_1', '--yes'], {
      ...live,
      routes: {
        'POST /posts/pst_1/retract': {
          body: {
            removed: [],
            remaining: [{ channelId: 'chn_x', platform: 'x', reason: 'unsupported' }],
          },
        },
      },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Still live on x: unsupported');
  });
});

describe('posts list', () => {
  it('passes filters through and stops at --limit across pages', async () => {
    const r = await cli(
      ['posts', 'list', '--status', 'failed', '--status', 'draft', '-L', '3', '--json'],
      {
        ...auth,
        routes: {
          'GET /posts': (req) => {
            const cursor = req.query.get('cursor');
            const page = cursor
              ? [post({ id: 'pst_3' }), post({ id: 'pst_4' })]
              : [post({ id: 'pst_1' }), post({ id: 'pst_2' })];
            return { body: { data: page, nextCursor: cursor ? null : 'c2' } };
          },
        },
      },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).map((p: { id: string }) => p.id)).toEqual([
      'pst_1',
      'pst_2',
      'pst_3',
    ]);
    expect(r.requests[0]?.query.getAll('status')).toEqual(['failed', 'draft']);
  });

  it('rejects an unknown status', async () => {
    const r = await cli(['posts', 'list', '--status', 'nope'], auth);
    expect(r.code).toBe(2);
  });
});

describe('media upload', () => {
  const uploadedFile = (requests: { path: string; body: unknown }[]) => {
    const upload = requests.find((q) => q.path === '/media');
    return (upload?.body as FormData | undefined)?.get('file') as File;
  };
  const mediaItem = {
    id: 'med_1',
    fileName: 'launch.png',
    mimeType: 'image/png',
    size: 4,
    createdAt: '2026-10-26T00:00:00.000Z',
  };
  const png = () =>
    new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
      headers: { 'content-type': 'image/png' },
    });

  it('downloads a URL and uploads it under its own name and type', async () => {
    const r = await cli(['media', 'upload', 'https://cdn.example.com/img/launch.png'], {
      ...auth,
      routes: { 'GET /img/launch.png': { response: png() }, 'POST /media': { body: mediaItem } },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('med_1\n');
    const file = uploadedFile(r.requests);
    expect(file.name).toBe('launch.png');
    expect(file.type).toBe('image/png');
    expect(file.size).toBe(4);
  });

  it('names an extensionless URL from the type the server sent', async () => {
    const r = await cli(['media', 'upload', 'https://cdn.example.com/abc123'], {
      ...auth,
      routes: { 'GET /abc123': { response: png() }, 'POST /media': { body: mediaItem } },
    });
    expect(r.code).toBe(0);
    const file = uploadedFile(r.requests);
    expect(file.name).toBe('abc123.png');
  });

  it('refuses a web page instead of uploading HTML', async () => {
    const page = new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
    const r = await cli(['media', 'upload', 'https://example.com/photo'], {
      ...auth,
      routes: { 'GET /photo': { response: page } },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/web page, not a file/);
    expect(r.requests.some((q) => q.path === '/media')).toBe(false);
  });

  it('fails clearly when the download fails', async () => {
    const r = await cli(['media', 'upload', 'https://cdn.example.com/gone.png'], auth);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Could not download .*HTTP 404/);
  });

  it('checks every source before uploading any', async () => {
    const r = await cli(
      ['media', 'upload', 'https://cdn.example.com/a.png', 'ftp://x/y.png'],
      auth,
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/Not an http\(s\) URL/);
    expect(r.requests).toHaveLength(0);
  });
});

describe('completion', () => {
  const complete = (...words: string[]) => cli(['__complete', '--', ...words]);

  it('prints a script for each shell', async () => {
    for (const shell of ['bash', 'zsh', 'fish']) {
      const r = await cli(['completion', shell]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('bulkit __complete --');
    }
    expect((await cli(['completion', 'powershell'])).code).toBe(2);
  });

  it('completes commands with descriptions, without hidden ones', async () => {
    const r = await complete('');
    expect(r.stdout).toMatch(/^posts\t/m);
    expect(r.stdout).toMatch(/^completion\t/m);
    expect(r.stdout).not.toContain('__complete');
    expect((await complete('posts', 'cr')).stdout).toMatch(/^create\t[^\n]+\n$/);
  });

  it('completes options, including global ones, past option values', async () => {
    const r = await complete('posts', 'create', '-c', 'x', '--d');
    const names = r.stdout.split('\n').map((l) => l.split('\t')[0]);
    expect(names).toEqual(expect.arrayContaining(['--draft', '--dry-run', '--debug']));
  });

  it('completes choices, and nothing (files) for free-form values', async () => {
    expect((await complete('posts', 'list', '--status', 'pub')).stdout).toBe(
      'publishing\npublished\n',
    );
    expect((await complete('completion', 'f')).stdout).toBe('fish\n');
    expect((await complete('media', 'upload', '')).stdout).toBe('');
    expect((await complete('posts', 'create', '--at', '')).stdout).toBe('');
  });
});

describe('test mode', () => {
  it('says a post was validated, not published, and does not wait', async () => {
    const r = await cli(['posts', 'create', '-c', 'x', '-t', 'Hi', '--now', '--wait'], {
      ...auth,
      routes: {
        'GET /channels': { body: channels },
        'POST /posts': { body: post({ status: 'draft' }) },
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('pst_1\n');
    expect(r.stderr).toMatch(/Test mode: nothing was published or scheduled/);
    expect(r.requests.filter((q) => q.method === 'GET' && q.path === '/posts/pst_1')).toHaveLength(
      0,
    );
  });
});

describe('channels get', () => {
  it('separates retracting from editing, which the platform may not allow', async () => {
    const r = await cli(['channels', 'get', '@acme'], {
      ...auth,
      routes: {
        'GET /channels': { body: channels },
        'GET /channels/chn_x/capabilities': { body: { channelId: 'chn_x', options: [] } },
        'GET /platforms': { body: [{ id: 'x', limits: { remoteEdit: null } }] },
      },
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Retract:\s+available/);
    expect(r.stdout).toMatch(/Edit live post:\s+not supported by x/);
  });
});
