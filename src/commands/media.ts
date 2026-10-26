import { createWriteStream, openAsBlob } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { Command } from '@commander-js/extra-typings';
import type { MediaItem } from 'bulkit';
import type { Context } from '../context';
import { CliError, UsageError } from '../errors';
import { formatBytes, formatDate, plural } from '../format';
import type { MakeContext } from './shared';

/** Video above this size goes through a multipart upload session instead of one request. */
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.srt': 'application/x-subrip',
  '.vtt': 'text/vtt',
};

export function mediaCommand(context: MakeContext) {
  const media = new Command('media').description('Upload and manage files for your posts');

  media
    .command('list')
    .alias('ls')
    .description('List the workspace’s media library')
    .action(async (_opts, cmd) => {
      const ctx = context(cmd);
      const list = await (await ctx.client()).media.list();
      ctx.out.print(list, () => {
        const human = ctx.out.isInteractive;
        ctx.out.table(
          list,
          [
            { header: 'ID', value: (m) => m.id },
            { header: 'NAME', value: (m) => m.fileName, shrink: true },
            { header: 'TYPE', value: (m) => m.mimeType },
            { header: 'SIZE', value: (m) => formatBytes(m.size) },
            { header: 'UPLOADED', value: (m) => formatDate(m.createdAt, human) },
          ],
          'The media library is empty.',
        );
      });
    });

  media
    .command('upload')
    .description('Upload files or URLs, and print their ids for `posts create --media`')
    .argument('<sources...>', 'paths or http(s) URLs of images, videos, PDFs or subtitles')
    .option('--mime-type <type>', 'override the type guessed from the extension or server')
    .option(
      '--concurrency <n>',
      'parts uploaded at once for large videos',
      (v) => Number.parseInt(v, 10),
      4,
    )
    .addHelpText(
      'after',
      `
Large videos are uploaded in parts automatically. A URL is downloaded by the CLI, then
uploaded like a local file, so it only needs to be reachable from your machine.

Examples:
  $ bulkit media upload photo.jpg
  $ bulkit media upload https://cdn.example.com/launch.mp4
  $ id=$(bulkit media upload clip.mp4) && bulkit posts create -c tiktok -m "$id" --draft`,
    )
    .action(async (sources, opts, cmd) => {
      const ctx = context(cmd);
      const { out } = ctx;

      // Check every source before uploading any, so a typo in the last one wastes nothing.
      const plan = await Promise.all(sources.map((source) => planSource(source, opts.mimeType)));

      const client = await ctx.client();
      const uploaded: MediaItem[] = [];
      let tempDir: string | undefined;
      try {
        for (const [index, item] of plan.entries()) {
          let file: LocalFile;
          if (item.kind === 'url') {
            tempDir ??= await mkdtemp(join(tmpdir(), 'bulkit-'));
            file = await download(ctx, item.url, opts.mimeType, join(tempDir, String(index)));
          } else {
            file = item;
          }
          out.info(`Uploading ${file.fileName} (${formatBytes(file.size)})…`);
          const blob = await openAsBlob(file.path, { type: file.mimeType });
          const params = { fileName: file.fileName, mimeType: file.mimeType };
          const media =
            file.mimeType.startsWith('video/') && file.size > MULTIPART_THRESHOLD
              ? await client.media.uploadMultipart(blob, {
                  ...params,
                  concurrency: opts.concurrency,
                })
              : await client.media.upload(blob, params);
          uploaded.push(media);
        }
      } finally {
        if (tempDir) await rm(tempDir, { recursive: true, force: true });
      }

      out.print(uploaded, () => {
        for (const item of uploaded) out.line(item.id);
        out.success(`Uploaded ${plural(uploaded.length, 'file')}.`);
      });
    });

  media
    .command('delete')
    .alias('rm')
    .description('Delete a file from the media library')
    .argument('<media-id>')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (mediaId, opts, cmd) => {
      const ctx = context(cmd);
      await ctx.confirm({ message: `Delete media ${mediaId}?`, yes: opts.yes });
      await (await ctx.client()).media.delete(mediaId);
      ctx.out.print({ id: mediaId, deleted: true }, () =>
        ctx.out.success(`Deleted media ${mediaId}.`),
      );
    });

  return media;
}

interface LocalFile {
  kind: 'file';
  path: string;
  fileName: string;
  size: number;
  mimeType: string;
}

type Source = LocalFile | { kind: 'url'; url: URL };

async function planSource(source: string, mimeOverride: string | undefined): Promise<Source> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    const url = URL.canParse(source) ? new URL(source) : undefined;
    if (url?.protocol !== 'https:' && url?.protocol !== 'http:') {
      throw new UsageError(`Not an http(s) URL: ${source}`);
    }
    return { kind: 'url', url };
  }
  const info = await stat(source).catch(() => undefined);
  if (!info?.isFile()) throw new UsageError(`Not a file: ${source}`);
  const mimeType = mimeOverride ?? MIME_TYPES[extname(source).toLowerCase()];
  if (!mimeType) {
    throw new UsageError(
      `Cannot tell the type of ${source} from its extension.`,
      'Pass --mime-type.',
    );
  }
  return { kind: 'file', path: source, fileName: basename(source), size: info.size, mimeType };
}

/** Types a server sends when it does not know, which say nothing about the file. */
const GENERIC_TYPES = new Set(['application/octet-stream', 'binary/octet-stream']);

/** Streams a URL to `path` on disk, so a large video never sits in memory. */
async function download(
  ctx: Context,
  url: URL,
  mimeOverride: string | undefined,
  path: string,
): Promise<LocalFile> {
  ctx.out.info(`Downloading ${url.href}…`);
  let response: Response;
  try {
    response = await ctx.fetchExternal(url.href);
  } catch (error) {
    throw new CliError(`Could not download ${url.href}: ${(error as Error).message}`);
  }
  if (!response.ok || !response.body) {
    throw new CliError(`Could not download ${url.href}: HTTP ${response.status}.`);
  }

  const served = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (served === 'text/html' && !mimeOverride) {
    await response.body.cancel();
    throw new CliError(`${url.href} is a web page, not a file.`, {
      hint: 'Use a direct link to the image or video.',
    });
  }
  let fileName = fileNameFromUrl(url);
  const fromServer = served && !GENERIC_TYPES.has(served) ? served : undefined;
  const mimeType = mimeOverride ?? fromServer ?? MIME_TYPES[extname(fileName).toLowerCase()];
  if (!mimeType) {
    await response.body.cancel();
    throw new UsageError(`Cannot tell the type of ${url.href}.`, 'Pass --mime-type.');
  }
  if (!extname(fileName)) fileName += extensionFor(mimeType);

  await pipeline(Readable.fromWeb(response.body as WebReadableStream), createWriteStream(path));
  const { size } = await stat(path);
  return { kind: 'file', path, fileName, size, mimeType };
}

function fileNameFromUrl(url: URL): string {
  const last = url.pathname.split('/').pop() ?? '';
  try {
    return decodeURIComponent(last) || 'download';
  } catch {
    return last || 'download';
  }
}

function extensionFor(mimeType: string): string {
  return Object.entries(MIME_TYPES).find(([, type]) => type === mimeType)?.[0] ?? '';
}
