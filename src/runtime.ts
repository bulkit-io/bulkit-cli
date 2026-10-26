import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Fetch } from 'bulkit';

export interface OutputStream {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

export interface InputStream extends AsyncIterable<string | Buffer> {
  isTTY?: boolean | undefined;
  setRawMode?: ((mode: boolean) => unknown) | undefined;
  setEncoding?: ((encoding: BufferEncoding) => unknown) | undefined;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  off(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  resume?: (() => unknown) | undefined;
  pause?: (() => unknown) | undefined;
}

export type Env = Record<string, string | undefined>;

/**
 * Everything the CLI touches outside itself. `bin.ts` wires in the real process;
 * tests pass in-memory streams, a fake `fetch` and a temporary config directory.
 */
export interface Runtime {
  stdout: OutputStream;
  stderr: OutputStream;
  stdin: InputStream;
  env: Env;
  /** Where `config.json` lives. */
  configDir: string;
  /** Replaces the global `fetch` for every request, including the update check. */
  fetch?: Fetch | undefined;
  platform?: NodeJS.Platform | undefined;
  /** Waits between polls (`--wait`). Tests make it instant. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** `$BULKIT_CONFIG_DIR`, else the platform's per-user config directory (XDG on Unix). */
export function defaultConfigDir(env: Env, platform: NodeJS.Platform = process.platform): string {
  if (env.BULKIT_CONFIG_DIR) return env.BULKIT_CONFIG_DIR;
  if (platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'bulkit');
  }
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bulkit');
}

export function nodeRuntime(): Runtime {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    configDir: defaultConfigDir(process.env),
    platform: process.platform,
  };
}

/** True for a non-empty value other than `0` / `false`. */
export function envFlag(env: Env, name: string): boolean {
  const value = env[name]?.trim().toLowerCase();
  return !!value && value !== '0' && value !== 'false';
}
