import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CliError, ExitCode } from './errors';
import type { Env } from './runtime';

export const DEFAULT_PROFILE = 'default';
const CONFIG_VERSION = 1;

export interface Profile {
  apiKey: string;
  /** Only set for a proxy or a local API; the SDK's default otherwise. */
  baseUrl?: string | undefined;
}

export interface ConfigFile {
  version: typeof CONFIG_VERSION;
  profiles: Record<string, Profile>;
}

export interface Credentials {
  apiKey: string;
  baseUrl: string | undefined;
  profile: string;
  /** Where the key came from, so `auth status` can say why it is being used. */
  source: 'env' | 'config';
}

/**
 * The user's config file. Holds API keys, so it is written owner-only (0600, in a
 * 0700 directory) and atomically: a crash mid-write never leaves a half-written file.
 */
export class Config {
  readonly path: string;
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
    this.path = join(dir, 'config.json');
  }

  async read(): Promise<ConfigFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig();
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new CliError(`Your config file is not valid JSON: ${this.path}`, {
        hint: 'Fix it by hand, or delete it and run `bulkit auth login` again.',
      });
    }
    if (!isConfigFile(parsed)) {
      throw new CliError(`Your config file has an unexpected shape: ${this.path}`, {
        hint: 'It may come from a newer version of the CLI. Upgrade, or delete it and log in again.',
      });
    }
    return parsed;
  }

  async write(config: ConfigFile): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async getProfile(name: string): Promise<Profile | undefined> {
    return (await this.read()).profiles[name];
  }

  async setProfile(name: string, profile: Profile): Promise<void> {
    const config = await this.read();
    config.profiles[name] = profile;
    await this.write(config);
  }

  /** Returns false when there was no such profile. */
  async removeProfile(name: string): Promise<boolean> {
    const config = await this.read();
    if (!(name in config.profiles)) return false;
    delete config.profiles[name];
    await this.write(config);
    return true;
  }
}

/** Precedence: `--profile`, then `$BULKIT_PROFILE`, then `default`. */
export function profileName(flag: string | undefined, env: Env): string {
  return flag || env.BULKIT_PROFILE || DEFAULT_PROFILE;
}

/**
 * `$BULKIT_API_KEY` wins over the config file, as `GH_TOKEN` does for `gh`: it is how
 * CI and one-off commands supply a key without touching what is stored.
 */
export async function resolveCredentials(
  config: Config,
  profile: string,
  env: Env,
): Promise<Credentials> {
  const envKey = env.BULKIT_API_KEY?.trim();
  if (envKey) {
    return { apiKey: envKey, baseUrl: undefined, profile, source: 'env' };
  }
  const stored = await config.getProfile(profile);
  if (stored) {
    return { apiKey: stored.apiKey, baseUrl: stored.baseUrl, profile, source: 'config' };
  }
  const which = profile === DEFAULT_PROFILE ? '' : ` --profile ${profile}`;
  throw new CliError('You are not logged in.', {
    exitCode: ExitCode.Auth,
    hint: `Run \`bulkit auth login${which}\`, or set the BULKIT_API_KEY environment variable.`,
  });
}

const API_KEY_PATTERN = /^bk_(live|test)_[A-Za-z0-9_-]+$/;

export function isApiKey(value: string): boolean {
  return API_KEY_PATTERN.test(value);
}

export function isTestKey(apiKey: string): boolean {
  return apiKey.startsWith('bk_test_');
}

/** `bk_live_…a1b2`: enough to tell keys apart, never enough to use one. */
export function maskKey(apiKey: string): string {
  const prefix = apiKey.match(/^bk_(live|test)_/)?.[0] ?? '';
  return `${prefix}…${apiKey.slice(-4)}`;
}

function emptyConfig(): ConfigFile {
  return { version: CONFIG_VERSION, profiles: {} };
}

function isConfigFile(value: unknown): value is ConfigFile {
  if (!value || typeof value !== 'object') return false;
  const { version, profiles } = value as Record<string, unknown>;
  if (version !== CONFIG_VERSION || !profiles || typeof profiles !== 'object') return false;
  return Object.values(profiles).every(
    (p) => !!p && typeof p === 'object' && typeof (p as Profile).apiKey === 'string',
  );
}
