import { Command, Option } from '@commander-js/extra-typings';
import type { Platform } from 'bulkit';
import { UsageError } from '../errors';
import { collect, dateTime, formatBytes, formatDate, formatQuota } from '../format';
import type { MakeContext } from './shared';

export function tagsCommand(context: MakeContext) {
  const tags = new Command('tags')
    .alias('tag')
    .description('List the workspace’s tags (internal labels, never published)');

  tags
    .command('list')
    .alias('ls')
    .description('List tags')
    .action(async (_opts, cmd) => {
      const ctx = context(cmd);
      const list = await (await ctx.client()).tags.list();
      ctx.out.print(list, () =>
        ctx.out.table(
          list,
          [
            { header: 'ID', value: (t) => t.id },
            { header: 'NAME', value: (t) => t.name },
            { header: 'POSTS', value: (t) => String(t.postCount) },
          ],
          'No tags yet. Create them in the Bulkit app.',
        ),
      );
    });

  return tags;
}

export function usageCommand(context: MakeContext) {
  return new Command('usage')
    .description('Show this billing period’s usage against your plan’s limits')
    .action(async (_opts, cmd) => {
      const ctx = context(cmd);
      const usage = await (await ctx.client()).usage.retrieve();
      ctx.out.print(usage, () => {
        const human = ctx.out.isInteractive;
        ctx.out.fields([
          ['Plan', usage.plan],
          [
            'Period',
            `${formatDate(usage.periodStart, human)} → ${formatDate(usage.periodEnd, human)}`,
          ],
          ['Posts created', formatQuota(usage.posts.created.used, usage.posts.created.limit)],
          ['Posts published', String(usage.posts.published)],
          ['Channels', formatQuota(usage.channels.used, usage.channels.limit)],
          [
            'Storage',
            usage.storage.bytesLimit === null
              ? `${formatBytes(usage.storage.bytesUsed)} (unlimited)`
              : `${formatBytes(usage.storage.bytesUsed)} / ${formatBytes(usage.storage.bytesLimit)}`,
          ],
        ]);
      });
    });
}

export function statsCommand(context: MakeContext) {
  const from = () =>
    new Option('--from <datetime>', 'start of the window (default: 30 days before --to)').argParser(
      (v) => dateTime(v),
    );
  const to = () =>
    new Option('--to <datetime>', 'end of the window (default: now)').argParser((v) => dateTime(v));
  const timezone = () =>
    new Option('--timezone <zone>', 'IANA time zone for days and hours (default: yours)');

  const stats = new Command('stats')
    .description('Show publishing and engagement totals for a time window')
    .addOption(from())
    .addOption(to())
    .addOption(timezone())
    .addHelpText(
      'after',
      `
Examples:
  $ bulkit stats
  $ bulkit stats --from 2026-10-01T00:00 --to 2026-11-01T00:00 --json
  $ bulkit stats insights --timezone Europe/Paris`,
    )
    .action(async (opts, cmd) => {
      const ctx = context(cmd);
      const data = await (await ctx.client()).stats.retrieve(windowParams(opts));
      ctx.out.print(data, () => {
        const { out } = ctx;
        const human = out.isInteractive;
        out.fields([
          [
            'Window',
            `${formatDate(data.from, human)} → ${formatDate(data.to, human)} (${data.timezone})`,
          ],
          ['Published', String(data.totals.published)],
          ['Failed', String(data.totals.failed)],
          ['Scheduled', String(data.queue.scheduled)],
          ['Drafts', String(data.queue.drafts)],
          ...Object.entries(data.engagement.values).map(([k, v]) => [label(k), String(v)] as const),
        ]);
        if (data.channels.length) {
          out.line();
          out.table(data.channels, [
            { header: 'CHANNEL', value: (c) => c.channelId ?? '-' },
            { header: 'PLATFORM', value: (c) => c.platform ?? '-' },
            { header: 'PUBLISHED', value: (c) => String(c.published) },
            { header: 'FAILED', value: (c) => String(c.failed) },
          ]);
        }
      });
    });

  stats
    .command('insights')
    .description('Show when, where and in what format posts perform best')
    .addOption(from())
    .addOption(to())
    .addOption(timezone())
    .option('--platform <id>', 'only these platforms (repeatable)', collect)
    .option('--channel <id>', 'only these channels (repeatable)', collect)
    .option('--tag <id>', 'only posts with these tags (repeatable)', collect)
    .action(async (opts, cmd) => {
      const ctx = context(cmd);
      const data = await (await ctx.client()).stats.insights({
        ...windowParams(opts),
        platform: opts.platform as Platform['id'][] | undefined,
        channel: opts.channel,
        tag: opts.tag,
      });
      // Insights are deeply nested groupings; JSON is the clearest way to read them.
      ctx.out.print(data, () => ctx.out.line(JSON.stringify(data, null, 2)));
    });

  return stats;
}

function windowParams(opts: { from?: string; to?: string; timezone?: string }) {
  const to = opts.to ?? new Date().toISOString();
  const from = opts.from ?? new Date(Date.parse(to) - 30 * 86_400_000).toISOString();
  if (Date.parse(from) >= Date.parse(to)) throw new UsageError('--from must be before --to.');
  const timezone = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { from, to, timezone };
}

/** `videoViews` → `Video views`. */
function label(key: string): string {
  const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
