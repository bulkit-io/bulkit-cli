import type { CommandUnknownOpts } from '@commander-js/extra-typings';
import type { Bulkit, Channel, Post, PostStatus } from 'bulkit';
import type { Context } from '../context';
import { CliError, UsageError } from '../errors';
import { formatDate, plural } from '../format';

export type MakeContext = (command: CommandUnknownOpts) => Context;

type Style = 'green' | 'yellow' | 'red' | 'cyan' | 'dim';

export function statusStyle(status: string): Style | undefined {
  switch (status) {
    case 'published':
    case 'enabled':
    case 'available':
    case 'ok':
      return 'green';
    case 'scheduled':
    case 'publishing':
      return 'cyan';
    case 'partially_published':
    case 'needs reconnect':
    case 'needs-reconnect':
      return 'yellow';
    case 'failed':
    case 'disabled':
      return 'red';
    case 'draft':
      return 'dim';
    default:
      return undefined;
  }
}

export function channelLabel(channel: Pick<Channel, 'platform' | 'name' | 'username'>): string {
  return channel.username
    ? `${channel.platform} @${channel.username}`
    : `${channel.platform} ${channel.name}`;
}

/**
 * Lets `--channel` take more than an opaque id: an id, a `@username`, a display name,
 * or a platform when the workspace has exactly one channel on it. Anything ambiguous
 * is refused rather than guessed, since the wrong channel means posting to the wrong
 * audience.
 */
export async function resolveChannels(client: Bulkit, refs: readonly string[]): Promise<Channel[]> {
  const channels = await client.channels.list();
  const resolved = refs.map((ref) => resolveChannel(channels, ref));
  const seen = new Set<string>();
  for (const channel of resolved) {
    if (seen.has(channel.id)) {
      throw new UsageError(`Channel ${channelLabel(channel)} was given more than once.`);
    }
    seen.add(channel.id);
  }
  return resolved;
}

function resolveChannel(channels: readonly Channel[], ref: string): Channel {
  const byId = channels.find((c) => c.id === ref);
  if (byId) return byId;

  const needle = ref.replace(/^@/, '').toLowerCase();
  const tiers = [
    channels.filter((c) => c.username?.toLowerCase() === needle),
    channels.filter((c) => c.name.toLowerCase() === needle),
    channels.filter((c) => c.platform === needle),
  ];
  for (const matches of tiers) {
    if (matches.length === 1 && matches[0]) return matches[0];
    if (matches.length > 1) {
      const list = matches.map((c) => `  ${c.id}  ${channelLabel(c)}`).join('\n');
      throw new UsageError(
        `"${ref}" matches ${matches.length} channels:\n${list}`,
        'Pass the channel id instead.',
      );
    }
  }
  throw new UsageError(
    `No channel matches "${ref}".`,
    'Run `bulkit channels list` to see your channels.',
  );
}

const IN_FLIGHT: readonly PostStatus[] = ['publishing'];

/**
 * Polls a submission until no channel is still publishing. Publishing is asynchronous:
 * a 2xx from create or publish only means the work was queued.
 */
export async function waitForPost(
  ctx: Context,
  postId: string,
  timeoutSeconds: number,
): Promise<Post> {
  const client = await ctx.client();
  const sleep = ctx.runtime.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutSeconds * 1000;
  let delay = 1000;
  ctx.out.info('Waiting for publishing to finish…');
  for (;;) {
    const post = await client.posts.retrieve(postId);
    const busy =
      IN_FLIGHT.includes(post.status) || post.channels.some((c) => IN_FLIGHT.includes(c.status));
    if (!busy) return post;
    if (Date.now() >= deadline) {
      throw new CliError(`Post ${postId} is still publishing after ${timeoutSeconds}s.`, {
        hint: `Check on it later with \`bulkit posts get ${postId}\`.`,
      });
    }
    await sleep(delay);
    delay = Math.min(delay * 1.5, 5000);
  }
}

export function isSuccessful(post: Post): boolean {
  return post.status !== 'failed' && post.status !== 'partially_published';
}

/** The first line of the first block, for one-line listings. */
export function postPreview(post: Post): string {
  const content = post.channels.find((c) => c.blocks[0]?.content)?.blocks[0]?.content ?? '';
  return content.split('\n')[0] ?? '';
}

export function renderPost(ctx: Context, post: Post): void {
  const { out } = ctx;
  const human = out.isInteractive;
  out.fields([
    ['ID', post.id],
    ['Status', out.style(statusStyle(post.status) ?? 'reset', post.status)],
    // Drafts carry a date too, but it is only a plan until the post is scheduled.
    [
      post.status === 'draft' ? 'Planned' : 'Scheduled',
      post.scheduledAt ? formatDate(post.scheduledAt, human) : undefined,
    ],
    ['Published', post.publishedAt ? formatDate(post.publishedAt, human) : undefined],
    ['Tags', post.tags.length ? post.tags.map((t) => t.name).join(', ') : undefined],
    ['Created', formatDate(post.createdAt, human)],
  ]);
  for (const channel of post.channels) {
    out.line();
    const status = out.style(statusStyle(channel.status) ?? 'reset', channel.status);
    out.heading(`${channel.platform ?? 'unknown'} ${out.style('dim', channel.channelId ?? '')}`);
    out.fields([
      ['Status', status],
      ['URL', channel.remoteUrl ?? undefined],
      ['Error', channel.error ? out.style('red', channel.error) : undefined],
      ['Title', channel.title ?? undefined],
    ]);
    channel.blocks.forEach((block, i) => {
      const label = channel.blocks.length > 1 ? `${i + 1}/${channel.blocks.length} ` : '';
      const media = block.media.length
        ? out.style('dim', ` [${plural(block.media.length, 'attachment')}]`)
        : '';
      out.line(`  ${label}${block.content.replace(/\n/g, '\n  ')}${media}`);
    });
  }
}
