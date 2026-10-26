import { CliError, ExitCode } from './errors';
import type { InputStream, OutputStream } from './runtime';

/**
 * Minimal prompts on stderr, so they never end up in piped stdout. Callers must check
 * `canPrompt` first: a prompt is only ever a convenience, and every one of them has a
 * flag that does the same thing non-interactively.
 */
export class Prompter {
  readonly #stdin: InputStream;
  readonly #stderr: OutputStream;

  constructor(stdin: InputStream, stderr: OutputStream) {
    this.#stdin = stdin;
    this.#stderr = stderr;
  }

  /** Reads one line, echoing what is typed. */
  async ask(question: string): Promise<string> {
    return this.#read(question, false);
  }

  /** Reads one line without echoing it, for secrets. */
  async secret(question: string): Promise<string> {
    return this.#read(question, true);
  }

  async confirm(question: string): Promise<boolean> {
    const answer = (await this.ask(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  }

  /**
   * Reads raw keystrokes rather than using `readline`, so that a hidden prompt really
   * echoes nothing and Ctrl-C behaves the same whether or not input is hidden.
   */
  #read(question: string, hidden: boolean): Promise<string> {
    const stdin = this.#stdin;
    const stderr = this.#stderr;
    stderr.write(question);
    stdin.setEncoding?.('utf8');
    stdin.setRawMode?.(true);
    stdin.resume?.();

    return new Promise<string>((resolve, reject) => {
      let value = '';
      const finish = (error?: Error) => {
        stdin.off('data', onData);
        stdin.setRawMode?.(false);
        stdin.pause?.();
        stderr.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk: string | Buffer) => {
        for (const char of chunk.toString()) {
          if (char === '\u0003')
            return finish(new CliError('Interrupted.', { exitCode: ExitCode.Interrupted }));
          if (char === '\u0004' && value === '') return finish(new CliError('Cancelled.'));
          if (char === '\r' || char === '\n') return finish();
          if (char === '\u007f' || char === '\b') {
            if (value.length > 0) {
              value = value.slice(0, -1);
              if (!hidden) stderr.write('\b \b');
            }
            continue;
          }
          if (char < ' ') continue;
          value += char;
          if (!hidden) stderr.write(char);
        }
      };
      stdin.on('data', onData);
    });
  }
}
