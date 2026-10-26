import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { envFlag, type Runtime } from './runtime';
import { VERSION } from './version';

const REGISTRY_URL = 'https://registry.npmjs.org/bulkit-cli/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The most an invocation ever waits for the check, and only once a day. */
const GRACE_MS = 300;

interface State {
  checkedAt: number;
  latest: string;
}

/**
 * A once-a-day "new version available" notice, like `gh` and `npm`. Never in CI, never
 * when stderr is not a terminal, never with `--json`, and `BULKIT_NO_UPDATE_NOTIFIER=1`
 * turns it off. It never fails a command and never delays one by more than GRACE_MS.
 */
export class UpdateCheck {
  readonly #runtime: Runtime;
  readonly #path: string;
  readonly #abort = new AbortController();
  #pending: Promise<State | undefined> = Promise.resolve(undefined);
  #cached: State | undefined;

  constructor(runtime: Runtime) {
    this.#runtime = runtime;
    this.#path = join(runtime.configDir, 'update-check.json');
  }

  static enabled(runtime: Runtime, argv: readonly string[]): boolean {
    const { env } = runtime;
    return (
      !!runtime.stderr.isTTY &&
      !envFlag(env, 'CI') &&
      !envFlag(env, 'BULKIT_NO_UPDATE_NOTIFIER') &&
      !argv.includes('--json')
    );
  }

  /** Reads the cached result and, if it is stale, refreshes it in the background. */
  async start(): Promise<void> {
    this.#cached = await readFile(this.#path, 'utf8')
      .then((text) => JSON.parse(text) as State)
      .catch(() => undefined);
    if (this.#cached && Date.now() - this.#cached.checkedAt < CHECK_INTERVAL_MS) return;
    this.#pending = this.#refresh().catch(() => undefined);
  }

  /** The notice to print after the command, if there is a newer version. */
  async finish(): Promise<string | undefined> {
    const timer = new Promise<undefined>((resolve) => {
      setTimeout(() => resolve(undefined), GRACE_MS).unref();
    });
    const fresh = await Promise.race([this.#pending, timer]);
    this.#abort.abort();
    const latest = (fresh ?? this.#cached)?.latest;
    if (!latest || !isNewer(latest, VERSION)) return undefined;
    return `A new version of the Bulkit CLI is available: ${VERSION} → ${latest}\nUpdate with: npm install -g bulkit-cli@latest`;
  }

  async #refresh(): Promise<State | undefined> {
    const fetchImpl = this.#runtime.fetch ?? globalThis.fetch;
    const response = await fetchImpl(REGISTRY_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(5000)]),
    });
    if (!response.ok) return undefined;
    const { version } = (await response.json()) as { version?: unknown };
    if (typeof version !== 'string') return undefined;
    const state = { checkedAt: Date.now(), latest: version };
    await mkdir(this.#runtime.configDir, { recursive: true, mode: 0o700 });
    await writeFile(this.#path, JSON.stringify(state), { mode: 0o600 });
    return state;
  }
}

/** Compares `x.y.z` release versions; anything with a pre-release tag is never "newer". */
export function isNewer(candidate: string, current: string): boolean {
  if (candidate.includes('-')) return false;
  const a = candidate.split('.').map(Number);
  const b = current.split('-')[0]?.split('.').map(Number) ?? [];
  for (let i = 0; i < 3; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x !== y) return x > y;
  }
  return false;
}
