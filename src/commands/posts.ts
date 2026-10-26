import { Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import type { Post, PostCreateParams, PostListParams, PostReviseParams } from 'bulkit';
import type { Context } from '../context';
import { CliError, ExitCode, SilentExit, UsageError } from '../errors';
import { collect, dateTime, formatDate, plural, positiveInt } from '../format';
import {
  channelLabel,
  isSuccessful,
  type MakeContext,
  postPreview,
  renderPost,
  resolveChannels,
  statusStyle,
  waitForPost,
} from './shared';

const LIST_STATUSES = ['draft', 'scheduled', 'publishing', 'published', 'failed'] as const;
const DEFAULT_WAIT_SECONDS = 300;

export function postsCommand(context: MakeContext) {
  const posts = new Command('posts')
    .alias('post')
    .description('Create, schedule, publish and manage posts');

  posts
    .command('list')
    .alias('ls')
    .description('List posts, newest first')
    .addOption(
      new Option('-s, --status <status>', 'only posts with this status (repeatable)')
        .choices(LIST_STATUSES)
        .argParser((value, previous: string[] = []) => {
          if (!(LIST_STATUSES as readonly string[]).includes(value)) {
            throw new InvalidArgumentError(`Allowed choices are ${LIST_STATUSES.join(', ')}.`);
          }
          return [...previous, value];
        }),
    )
    .option('--tag <id>', 'only posts with this tag (repeatable)', collect)
    .addOption(
      new Option('--from <datetime>', 'only posts at or after this time').argParser((v) =>
        dateTime(v),
      ),
    )
    .addOption(
      new Option('--to <datetime>', 'only posts before this time').argParser((v) => dateTime(v)),
    )
    .option('-L, --limit <n>', 'how many posts to show', positiveInt, 25)
    .option('--all', 'show every matching post (ignores --limit)')
    .addHelpText(
      'after',
      `
Examples:
  $ bulkit posts list --status scheduled
  $ bulkit posts list --status failed --all --json`,
    )
    .action(async (opts, cmd) => {
      const ctx = context(cmd);
      const client = await ctx.client();
      const params: PostListParams = {
        status: opts.status as PostListParams['status'],
        tag: opts.tag,
        from: opts.from,
        to: opts.to,
        limit: opts.all ? 100 : Math.min(opts.limit, 100),
      };
      const list: Post[] = [];
      for await (const post of client.posts.list(params)) {
        list.push(post);
        if (!opts.all && list.length >= opts.limit) break;
      }
      ctx.out.print(list, () => {
        const human = ctx.out.isInteractive;
        ctx.out.table(
          list,
          [
            { header: 'ID', value: (p) => p.id },
            { header: 'STATUS', value: (p) => p.status, style: statusStyle },
            {
              header: 'WHEN',
              value: (p) => formatDate(p.publishedAt ?? p.scheduledAt ?? p.createdAt, human),
            },
            {
              header: 'CHANNELS',
              value: (p) => p.channels.map((c) => c.platform ?? '?').join(', '),
            },
            { header: 'TEXT', value: postPreview, shrink: true },
          ],
          'No posts match.',
        );
      });
    });

  posts
    .command('get')
    .alias('view')
    .description('Show a post and where each channel stands')
    .argument('<post-id>')
    .option('-w, --wait', 'wait until publishing finishes; exits 1 if any channel failed')
    .option('--timeout <seconds>', 'how long --wait waits', positiveInt, DEFAULT_WAIT_SECONDS)
    .action(async (postId, opts, cmd) => {
      const ctx = context(cmd);
      const post = opts.wait
        ? await waitForPost(ctx, postId, opts.timeout)
        : await (await ctx.client()).posts.retrieve(postId);
      ctx.out.print(post, () => renderPost(ctx, post));
      if (opts.wait && !isSuccessful(post)) throw new SilentExit(ExitCode.Error);
    });

  posts
    .command('create')
    .alias('new')
    .description('Create a post for one or more channels: a draft, scheduled, or now')
    .option(
      '-c, --channel <channel>',
      'target channel: id, @username, name or platform (repeatable)',
      collect,
    )
    .option(
      '-t, --text <text>',
      'the post text; repeat it to write a thread, one block per --text',
      collect,
    )
    .option('--text-file <path>', 'read the post text from a file, or - for stdin')
    .option(
      '-m, --media <media-id>',
      'attach uploaded media to the first block (repeatable)',
      collect,
    )
    .option('--title <title>', 'title, on platforms that have one (YouTube, Reddit, Pinterest, …)')
    .option('--tag <tag-id>', 'label the post with a workspace tag (repeatable)', collect)
    .option(
      '-f, --file <path>',
      'the whole request body as JSON, or - for stdin (per-channel text, options)',
    )
    .addOption(new Option('--draft', 'save as a draft (the default)').conflicts(['now', 'at']))
    .addOption(
      new Option('--at <datetime>', 'schedule it: ISO 8601 or an offset like +2h')
        .argParser((v) => dateTime(v))
        .conflicts('now'),
    )
    .option('--now', 'publish immediately, to real accounts')
    .option(
      '-w, --wait',
      'with --now: wait until publishing finishes; exits 1 if any channel failed',
    )
    .option('--timeout <seconds>', 'how long --wait waits', positiveInt, DEFAULT_WAIT_SECONDS)
    .option('--dry-run', 'print the request body instead of sending it')
    .option(
      '--idempotency-key <key>',
      'reuse the same key to retry safely without creating a duplicate',
    )
    .option('-y, --yes', 'do not ask for confirmation before publishing')
    .addHelpText(
      'after',
      `
One post can target many channels: pass --channel several times rather than
running the command once per channel. Every channel gets the same text; to tailor
it per channel, or to set platform options, write the body as JSON and use --file.

Publishing is asynchronous. --now returns once the post is queued; add --wait to
see how it went, or check later with \`bulkit posts get <id>\`.

Examples:
  $ bulkit posts create -c @acme -c linkedin -t "Shipping today." --at +2h
  $ bulkit posts create -c x -t "1/ A thread" -t "2/ continues here" --now --wait
  $ bulkit posts create -c x --text-file notes.md --draft
  $ bulkit posts create --file post.json --at 2026-11-01T09:00
  $ bulkit posts create -c x -t "Hello" --dry-run`,
    )
    .action(async (opts, cmd) => {
      const ctx = context(cmd);
      const { out } = ctx;
      const client = await ctx.client();

      const flags: ContentFlags = {
        channel: opts.channel ?? [],
        text: opts.text ?? [],
        textFile: opts.textFile,
        media: opts.media ?? [],
        title: opts.title,
      };
      const body = opts.file
        ? await bodyFromFile(ctx, flags, opts.file)
        : await bodyFromFlags(ctx, flags);
      body.intent = opts.now
        ? 'now'
        : opts.at
          ? 'schedule'
          : opts.draft
            ? 'draft'
            : (body.intent ?? 'draft');
      if (opts.at) body.scheduledAt = opts.at;
      if (opts.tag) body.tagIds = [...new Set([...(body.tagIds ?? []), ...opts.tag])];
      validateTiming(body, opts.wait);

      if (opts.dryRun) {
        out.line(JSON.stringify(body, null, 2));
        out.info('Dry run: nothing was sent.');
        return;
      }

      if (body.intent === 'now' && !(await ctx.isTestMode())) {
        await ctx.confirm({
          message: `Publish now to ${plural(body.channels.length, 'channel')}? This posts to real accounts.`,
          yes: opts.yes,
        });
      }

      const created = await client.posts.create(body, { idempotencyKey: opts.idempotencyKey });
      await reportPublished(ctx, created, {
        goesOut: body.intent !== 'draft',
        wait: !!opts.wait && body.intent === 'now',
        timeout: opts.timeout,
      });
    });

  posts
    .command('update')
    .alias('edit')
    .description('Replace a post that has not been published yet')
    .argument('<post-id>')
    .requiredOption('-f, --file <path>', 'the new request body as JSON, or - for stdin')
    .option('-y, --yes', 'do not ask for confirmation')
    .addHelpText(
      'after',
      `
The body replaces the whole post, in the same shape as \`posts create --file\`.
Once a post has been published, use \`bulkit posts revise\` instead.

Example:
  $ bulkit posts get pst_123 --json > post.json   # edit it, then:
  $ bulkit posts update pst_123 --file post.json`,
    )
    .action(async (postId, opts, cmd) => {
      const ctx = context(cmd);
      const body = await ctx.readJson<PostCreateParams>(opts.file, 'The post');
      if (!Array.isArray(body.channels))
        throw new UsageError('The post body needs a "channels" array.');
      await ctx.confirm({
        message: `Replace post ${postId} with the contents of ${opts.file}?`,
        yes: opts.yes,
      });
      const post = await (await ctx.client()).posts.update(postId, body);
      ctx.out.print(post, () => ctx.out.success(`Updated post ${post.id} (${post.status}).`));
    });

  posts
    .command('publish')
    .description('Publish a draft or scheduled post now, or retry a failed one')
    .argument('<post-id>')
    .option('-w, --wait', 'wait until publishing finishes; exits 1 if any channel failed')
    .option('--timeout <seconds>', 'how long --wait waits', positiveInt, DEFAULT_WAIT_SECONDS)
    .option('-y, --yes', 'do not ask for confirmation')
    .addHelpText(
      'after',
      '\nChannels that already published are skipped, so retrying a partial failure is safe.',
    )
    .action(async (postId, opts, cmd) => {
      const ctx = context(cmd);
      const client = await ctx.client();
      if (!(await ctx.isTestMode())) {
        const post = await client.posts.retrieve(postId);
        const pending = post.channels.filter((c) => c.status !== 'published');
        await ctx.confirm({
          message: `Publish post ${postId} now to ${plural(pending.length, 'channel')} (${pending.map((c) => c.platform ?? 'unknown').join(', ')})?`,
          yes: opts.yes,
        });
      }
      const post = await client.posts.publish(postId);
      await reportPublished(ctx, post, {
        goesOut: true,
        wait: !!opts.wait,
        timeout: opts.timeout,
      });
    });

  posts
    .command('revise')
    .description('Rewrite the text of a published post in place, where the platform allows it')
    .argument('<post-id>')
    .requiredOption(
      '-f, --file <path>',
      'the revision as JSON ({ "channels": [...] }), or - for stdin',
    )
    .option('-y, --yes', 'do not ask for confirmation')
    .addHelpText(
      'after',
      `
List every channel of the post, with the same number of blocks as were published.
Only the wording can change. Channels that cannot be edited are reported back.`,
    )
    .action(async (postId, opts, cmd) => {
      const ctx = context(cmd);
      const body = await ctx.readJson<PostReviseParams>(opts.file, 'The revision');
      await ctx.confirm({ message: `Rewrite the live copies of post ${postId}?`, yes: opts.yes });
      const result = await (await ctx.client()).posts.revise(postId, body);
      ctx.out.print(result, () => {
        for (const c of result.revised) ctx.out.success(`Revised on ${c.platform ?? c.channelId}.`);
        for (const c of result.unchanged) {
          ctx.out.warn(
            `Not changed on ${c.platform ?? c.channelId}${c.reason ? `: ${c.reason}` : ''}.`,
          );
        }
      });
    });

  posts
    .command('retract')
    .description('PERMANENTLY delete a published post from the platforms')
    .argument('<post-id>')
    .option('-y, --yes', 'do not ask for confirmation')
    .addHelpText(
      'after',
      `
This deletes the live copies, with their likes and replies, and cannot be undone.
Not every platform allows it: anything left up is listed, and the command exits 1.
To forget a post in Bulkit but leave it live, use \`bulkit posts delete\`.`,
    )
    .action(async (postId, opts, cmd) => {
      const ctx = context(cmd);
      const client = await ctx.client();
      const testMode = await ctx.isTestMode();
      if (!opts.yes) {
        const post = await client.posts.retrieve(postId);
        const live = post.channels.filter((c) => c.remoteUrl || c.status === 'published');
        const where = live.map((c) => c.platform ?? c.channelId).join(', ') || 'no channels';
        await ctx.confirm({
          message: `This permanently deletes post ${postId} from ${where}, with its likes and replies.`,
          yes: false,
          typed: testMode ? undefined : postId,
        });
      }
      const result = await client.posts.retract(postId);
      ctx.out.print(result, () => {
        for (const c of result.removed)
          ctx.out.success(`Removed from ${c.platform ?? c.channelId}.`);
        for (const c of result.remaining) {
          ctx.out.warn(
            `Still live on ${c.platform ?? c.channelId}${c.reason ? `: ${c.reason}` : ''}.`,
          );
        }
      });
      if (result.remaining.length) throw new SilentExit(ExitCode.Error);
    });

  posts
    .command('delete')
    .alias('rm')
    .description('Delete Bulkit’s record of a post (published copies stay live)')
    .argument('<post-id>')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (postId, opts, cmd) => {
      const ctx = context(cmd);
      await ctx.confirm({
        message: `Delete post ${postId} from Bulkit? Anything already published stays live (use \`posts retract\` to take it down).`,
        yes: opts.yes,
      });
      await (await ctx.client()).posts.delete(postId);
      ctx.out.print({ id: postId, deleted: true }, () =>
        ctx.out.success(`Deleted post ${postId}.`),
      );
    });

  posts
    .command('metrics')
    .description('Show a published post’s engagement over time, per channel')
    .argument('<post-id>')
    .action(async (postId, _opts, cmd) => {
      const ctx = context(cmd);
      const metrics = await (await ctx.client()).posts.metrics(postId);
      ctx.out.print(metrics, () => ctx.out.line(JSON.stringify(metrics, null, 2)));
    });

  return posts;
}

interface ContentFlags {
  channel: string[];
  text: string[];
  textFile?: string | undefined;
  media: string[];
  title?: string | undefined;
}

async function bodyFromFile(
  ctx: Context,
  opts: ContentFlags,
  file: string,
): Promise<PostCreateParams> {
  if (opts.channel.length || opts.text.length || opts.textFile || opts.media.length || opts.title) {
    throw new UsageError(
      '--file already describes the channels and content.',
      'Drop --channel, --text, --text-file, --media and --title, or drop --file.',
    );
  }
  const body = await ctx.readJson<PostCreateParams>(file, 'The post');
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray(body.channels) ||
    body.channels.length === 0
  ) {
    throw new UsageError(
      'The post body needs a non-empty "channels" array.',
      'See `bulkit posts create --help`.',
    );
  }
  return body;
}

async function bodyFromFlags(ctx: Context, opts: ContentFlags): Promise<PostCreateParams> {
  if (opts.channel.length === 0) {
    throw new UsageError(
      'Pass at least one --channel.',
      'Run `bulkit channels list` to see your channels.',
    );
  }
  if (opts.textFile && opts.text.length)
    throw new UsageError('Use either --text or --text-file, not both.');

  const texts = opts.textFile
    ? [(await ctx.readInput(opts.textFile, 'the post text')).replace(/\s+$/, '')]
    : opts.text;
  if (texts.every((t) => !t.trim()) && opts.media.length === 0) {
    throw new UsageError('The post is empty. Pass --text, --text-file or --media.');
  }
  const blocks = (texts.length ? texts : ['']).map((content, i) => ({
    content,
    ...(i === 0 && opts.media.length ? { mediaIds: opts.media } : {}),
  }));

  const channels = await resolveChannels(await ctx.client(), opts.channel);
  for (const channel of channels) {
    if (channel.needsReconnect) {
      ctx.out.warn(
        `${channelLabel(channel)} needs reconnecting in the app, or publishing to it will fail.`,
      );
    }
  }
  return {
    intent: 'draft',
    channels: channels.map((channel) => ({
      channelId: channel.id,
      ...(opts.title ? { title: opts.title } : {}),
      blocks,
    })),
  };
}

function validateTiming(body: PostCreateParams, wait: boolean | undefined): void {
  if (body.intent === 'schedule') {
    if (!body.scheduledAt) throw new UsageError('A scheduled post needs a time: pass --at.');
    if (Date.parse(body.scheduledAt) <= Date.now()) {
      throw new UsageError(
        `${body.scheduledAt} is in the past.`,
        'Use --now to publish immediately.',
      );
    }
  } else if (body.intent !== 'now' && body.intent !== 'draft') {
    throw new UsageError(
      `Unknown intent "${String(body.intent)}": expected draft, schedule or now.`,
    );
  }
  if (wait && body.intent !== 'now') throw new UsageError('--wait only applies with --now.');
}

/** What create and publish say once the API has accepted the post. */
async function reportPublished(
  ctx: Context,
  post: Post,
  options: { goesOut: boolean; wait: boolean; timeout: number },
) {
  const { out } = ctx;
  // A test key validates a publish or schedule and keeps the post a draft: nothing to wait for.
  if (options.goesOut && post.status === 'draft' && (await ctx.isTestMode())) {
    out.print(post, () => {
      out.line(post.id);
      out.success(`Validated ${post.id} for ${plural(post.channels.length, 'channel')}.`);
      out.info('Test mode: nothing was published or scheduled. The post stays a draft.');
    });
    return;
  }
  const final = options.wait ? await waitForPost(ctx, post.id, options.timeout) : post;
  out.print(final, () => {
    // The id alone on stdout, so `id=$(bulkit posts create …)` just works.
    out.line(final.id);
    const where = plural(final.channels.length, 'channel');
    switch (final.status) {
      case 'draft':
        out.success(`Saved draft ${final.id} for ${where}.`);
        break;
      case 'scheduled':
        out.success(
          `Scheduled ${final.id} for ${formatDate(final.scheduledAt, true)} on ${where}.`,
        );
        break;
      case 'publishing':
        out.success(`Queued ${final.id} for publishing on ${where}.`);
        out.info(
          `Publishing happens in the background. Follow it with \`bulkit posts get ${final.id} --wait\`.`,
        );
        break;
      case 'published':
        out.success(`Published ${final.id} on ${where}.`);
        for (const c of final.channels)
          if (c.remoteUrl) out.info(`  ${c.platform}: ${c.remoteUrl}`);
        break;
      default:
        for (const c of final.channels) {
          if (c.status === 'published') out.success(`${c.platform}: ${c.remoteUrl ?? 'published'}`);
          else out.warn(`${c.platform}: ${c.status}${c.error ? ` — ${c.error}` : ''}`);
        }
        out.info(`Retry the failed channels with \`bulkit posts publish ${final.id}\`.`);
    }
  });
  if (options.wait && !isSuccessful(final)) {
    if (ctx.out.json) throw new SilentExit(ExitCode.Error);
    throw new CliError(`Post ${final.id} did not publish everywhere (${final.status}).`);
  }
}
