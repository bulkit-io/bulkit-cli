import { styleText } from 'node:util';
import type { ErrorReport } from './errors';
import { type Env, envFlag, type OutputStream } from './runtime';

type Style = Parameters<typeof styleText>[0];

export interface OutputOptions {
  json: boolean;
  /** `false` when `--no-color` was passed. */
  color: boolean;
  env: Env;
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Applied after padding, so escape codes never skew the layout. */
  style?: ((value: string, row: T) => Style | undefined) | undefined;
  /** This column gives up width first when the table is wider than the terminal. */
  shrink?: boolean | undefined;
}

/**
 * The single place that writes to the terminal.
 *
 * - Data goes to stdout; progress, warnings and errors go to stderr, so piping
 *   stdout always yields clean data.
 * - `--json` prints the API's own objects to stdout, unchanged and stable.
 * - Human output is for people and may change between releases. When stdout is
 *   not a terminal, tables become headerless tab-separated lines, like `gh`.
 */
export class Output {
  readonly json: boolean;
  readonly #stdout: OutputStream;
  readonly #stderr: OutputStream;
  readonly #colorOut: boolean;
  readonly #colorErr: boolean;

  constructor(stdout: OutputStream, stderr: OutputStream, options: OutputOptions) {
    this.json = options.json;
    this.#stdout = stdout;
    this.#stderr = stderr;
    this.#colorOut = colorEnabled(stdout, options);
    this.#colorErr = colorEnabled(stderr, options);
  }

  /** Whether stdout is a terminal a person is reading. */
  get isInteractive(): boolean {
    return !!this.#stdout.isTTY;
  }

  /** Prints `data` as JSON with `--json`, and through `human` otherwise. */
  print<T>(data: T, human: (data: T) => void): void {
    if (this.json) this.#writeJson(data);
    else human(data);
  }

  line(text = ''): void {
    this.#stdout.write(`${text}\n`);
  }

  table<T>(rows: readonly T[], columns: readonly Column<T>[], empty = 'Nothing to show.'): void {
    if (rows.length === 0) {
      // Say so on stderr: an empty stdout is what a script expects from an empty list.
      this.info(empty);
      return;
    }
    const cells = rows.map((row) => columns.map((c) => oneLine(c.value(row))));
    if (!this.isInteractive) {
      for (const line of cells) this.line(line.join('\t'));
      return;
    }

    const widths = columns.map((c, i) =>
      Math.max(c.header.length, ...cells.map((line) => (line[i] ?? '').length)),
    );
    fitToWidth(widths, columns, this.#stdout.columns ?? 120);

    const gap = '  ';
    this.line(
      columns
        .map((c, i) => this.#style(this.#colorOut, 'bold', pad(c.header, widths[i] ?? 0)))
        .join(gap)
        .trimEnd(),
    );
    rows.forEach((row, r) => {
      const text = columns.map((column, i) => {
        const raw = cells[r]?.[i] ?? '';
        const width = widths[i] ?? 0;
        const cell = pad(truncate(raw, width), width);
        const style = column.style?.(raw, row);
        return style ? this.#style(this.#colorOut, style, cell) : cell;
      });
      this.line(text.join(gap).trimEnd());
    });
  }

  /** `Label  value` pairs, aligned. Pairs with an undefined value are skipped. */
  fields(pairs: ReadonlyArray<readonly [string, string | undefined]>): void {
    const shown = pairs.filter((p): p is readonly [string, string] => p[1] !== undefined);
    const width = Math.max(0, ...shown.map(([label]) => label.length));
    for (const [label, value] of shown) {
      this.line(`${this.#style(this.#colorOut, 'dim', pad(`${label}:`, width + 1))}  ${value}`);
    }
  }

  heading(text: string): void {
    this.line(this.#style(this.#colorOut, 'bold', text));
  }

  /** Styles text bound for stdout. */
  style(style: Style, text: string): string {
    return this.#style(this.#colorOut, style, text);
  }

  success(message: string): void {
    if (this.json) return;
    this.#stderr.write(`${this.#style(this.#colorErr, 'green', '✓')} ${message}\n`);
  }

  info(message: string): void {
    if (this.json) return;
    this.#stderr.write(`${message}\n`);
  }

  /** Shown even with `--json`: it goes to stderr and is something the caller must know. */
  warn(message: string): void {
    this.#stderr.write(`${this.#style(this.#colorErr, 'yellow', '!')} ${message}\n`);
  }

  debug(message: string): void {
    this.#stderr.write(`${this.#style(this.#colorErr, 'dim', message)}\n`);
  }

  error(report: ErrorReport, stack?: string): void {
    if (this.json) {
      this.#stderr.write(
        `${JSON.stringify({ error: { ...report.json, hint: report.hint, exitCode: report.exitCode } })}\n`,
      );
      return;
    }
    const lines = [`${this.#style(this.#colorErr, 'red', 'Error:')} ${report.message}`];
    for (const detail of report.details ?? []) lines.push(`  ${detail}`);
    if (report.hint) lines.push(this.#style(this.#colorErr, 'dim', report.hint));
    if (stack) lines.push('', this.#style(this.#colorErr, 'dim', stack));
    this.#stderr.write(`${lines.join('\n')}\n`);
  }

  #writeJson(data: unknown): void {
    this.#stdout.write(`${JSON.stringify(data ?? null, null, 2)}\n`);
  }

  #style(enabled: boolean, style: Style, text: string): string {
    return enabled ? styleText(style, text, { validateStream: false }) : text;
  }
}

/** https://no-color.org, `TERM=dumb`, `--no-color`; `FORCE_COLOR` wins over a pipe. */
function colorEnabled(stream: OutputStream, { color, env }: OutputOptions): boolean {
  if (!color || env.NO_COLOR || env.TERM === 'dumb') return false;
  if (env.FORCE_COLOR !== undefined) return envFlag(env, 'FORCE_COLOR') || env.FORCE_COLOR === '';
  return !!stream.isTTY;
}

function fitToWidth<T>(widths: number[], columns: readonly Column<T>[], max: number): void {
  const total = () => widths.reduce((a, b) => a + b, 0) + 2 * (widths.length - 1);
  const shrinkable = columns.flatMap((c, i) => (c.shrink ? [i] : []));
  for (const i of shrinkable) {
    const over = total() - max;
    if (over <= 0) return;
    widths[i] = Math.max(columns[i]?.header.length ?? 0, 10, (widths[i] ?? 0) - over);
  }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

export function truncate(text: string, width: number): string {
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}
