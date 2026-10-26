import { readFile } from 'node:fs/promises';
import { Bulkit, type Fetch, VERSION as SDK_VERSION } from 'bulkit';
import { Config, type Credentials, isTestKey, profileName, resolveCredentials } from './config';
import { CliError, ExitCode, UsageError } from './errors';
import { Output } from './output';
import { Prompter } from './prompt';
import { envFlag, type Runtime } from './runtime';
import { VERSION } from './version';

/** Options defined on the root command, available to every subcommand. */
export interface GlobalOptions {
  json?: boolean | undefined;
  color?: boolean | undefined;
  input?: boolean | undefined;
  profile?: string | undefined;
  debug?: boolean | undefined;
}

/** What every command action works with. Built once per invocation. */
export class Context {
  readonly out: Output;
  readonly config: Config;
  readonly runtime: Runtime;
  readonly profile: string;
  readonly debug: boolean;
  readonly #noInput: boolean;
  readonly #prompter: Prompter;
  #credentials: Promise<Credentials> | undefined;
  #client: Promise<Bulkit> | undefined;

  constructor(runtime: Runtime, globals: GlobalOptions) {
    const { env } = runtime;
    this.runtime = runtime;
    this.out = new Output(runtime.stdout, runtime.stderr, {
      json: !!globals.json,
      color: globals.color !== false,
      env,
    });
    this.config = new Config(runtime.configDir);
    this.profile = profileName(globals.profile, env);
    this.debug = !!globals.debug || envFlag(env, 'BULKIT_DEBUG');
    this.#noInput =
      globals.input === false || envFlag(env, 'BULKIT_NO_INPUT') || envFlag(env, 'CI');
    this.#prompter = new Prompter(runtime.stdin, runtime.stderr);
  }

  /** Prompts need a person on both ends: input from a terminal, and a terminal to ask on. */
  get canPrompt(): boolean {
    return !this.#noInput && !!this.runtime.stdin.isTTY && !!this.runtime.stderr.isTTY;
  }

  get prompt(): Prompter {
    if (!this.canPrompt) throw new Error('Prompted without checking `canPrompt`.');
    return this.#prompter;
  }

  credentials(): Promise<Credentials> {
    this.#credentials ??= resolveCredentials(this.config, this.profile, this.runtime.env);
    return this.#credentials;
  }

  async isTestMode(): Promise<boolean> {
    return isTestKey((await this.credentials()).apiKey);
  }

  /** The API client for the active profile. Fails with exit code 3 when not logged in. */
  client(): Promise<Bulkit> {
    this.#client ??= this.credentials().then((c) => this.createClient(c.apiKey, c.baseUrl));
    return this.#client;
  }

  createClient(apiKey: string, baseUrl?: string): Bulkit {
    return new Bulkit({
      apiKey,
      baseURL: baseUrl,
      fetch: this.#fetch(),
      defaultHeaders: { 'User-Agent': `bulkit-cli/${VERSION} bulkit-node/${SDK_VERSION}` },
    });
  }

  /**
   * Asks before doing something to real accounts. `--yes` skips the question; without
   * a terminal to ask on, the command fails and says which flag to pass instead.
   *
   * `typed` raises the bar for what cannot be undone: the person types that value back.
   */
  async confirm(options: {
    message: string;
    yes: boolean | undefined;
    typed?: string;
  }): Promise<void> {
    if (options.yes) return;
    if (!this.canPrompt) {
      throw new UsageError(
        `Confirmation required: ${options.message}`,
        'Re-run with --yes to confirm without a prompt.',
      );
    }
    let confirmed: boolean;
    if (options.typed) {
      this.out.warn(options.message);
      const answer = await this.prompt.ask(
        `Type ${this.out.style('bold', options.typed)} to confirm: `,
      );
      confirmed = answer.trim() === options.typed;
    } else {
      confirmed = await this.prompt.confirm(options.message);
    }
    if (!confirmed) throw new CliError('Cancelled. Nothing was changed.');
  }

  /** Reads a file, or stdin for `-`. */
  async readInput(path: string, what: string): Promise<string> {
    if (path === '-') {
      if (this.runtime.stdin.isTTY) {
        this.out.info(`Reading ${what} from stdin. Press Ctrl-D when done.`);
      }
      return readAll(this.runtime.stdin);
    }
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      throw new UsageError(
        code === 'ENOENT'
          ? `File not found: ${path}`
          : `Could not read ${path}: ${(error as Error).message}`,
      );
    }
  }

  async readJson<T>(path: string, what: string): Promise<T> {
    const text = await this.readInput(path, what);
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      const source = path === '-' ? 'stdin' : path;
      throw new UsageError(`${what} in ${source} is not valid JSON: ${(error as Error).message}`);
    }
  }

  /** For requests outside the Bulkit API, such as downloading a file to upload. */
  fetchExternal(url: string, init?: RequestInit): Promise<Response> {
    const fetchImpl = this.#fetch() ?? globalThis.fetch.bind(globalThis);
    return fetchImpl(url, init);
  }

  /** `--debug` logs each request and response line to stderr, never the API key. */
  #fetch(): Fetch | undefined {
    const base = this.runtime.fetch;
    if (!this.debug) return base;
    const fetchImpl = base ?? globalThis.fetch.bind(globalThis);
    return async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method ?? 'GET';
      const started = performance.now();
      this.out.debug(`→ ${method} ${url}`);
      try {
        const response = await fetchImpl(input, init);
        const ms = Math.round(performance.now() - started);
        const id = response.headers.get('x-request-id');
        this.out.debug(
          `← ${response.status} ${method} ${url} (${ms}ms)${id ? ` request-id=${id}` : ''}`,
        );
        return response;
      } catch (error) {
        this.out.debug(`✗ ${method} ${url}: ${(error as Error).message}`);
        throw error;
      }
    };
  }
}

export async function readAll(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk.toString());
  return chunks.join('');
}

/** Exit code 3 with a hint, for a key that is clearly not a Bulkit key. */
export function invalidKeyError(): CliError {
  return new CliError('That does not look like a Bulkit API key.', {
    exitCode: ExitCode.Auth,
    hint: 'Keys start with bk_live_ or bk_test_. Create one in the app under Developers → API & Webhooks.',
  });
}
