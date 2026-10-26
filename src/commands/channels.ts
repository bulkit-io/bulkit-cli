import { Command } from '@commander-js/extra-typings';
import type { Channel } from 'bulkit';
import { formatDate } from '../format';
import { type MakeContext, resolveChannels, statusStyle } from './shared';

export function channelsCommand(context: MakeContext) {
  const channels = new Command('channels')
    .alias('channel')
    .description('List the social accounts this workspace can post to');

  channels
    .command('list')
    .alias('ls')
    .description('List connected channels')
    .action(async (_opts, cmd) => {
      const ctx = context(cmd);
      const list = await (await ctx.client()).channels.list();
      ctx.out.print(list, () => {
        const human = ctx.out.isInteractive;
        ctx.out.table(
          list,
          [
            { header: 'ID', value: (c) => c.id },
            { header: 'PLATFORM', value: (c) => c.platform },
            { header: 'NAME', value: (c) => c.name, shrink: true },
            { header: 'USERNAME', value: (c) => (c.username ? `@${c.username}` : '-') },
            { header: 'STATUS', value: channelStatus, style: statusStyle },
            { header: 'CONNECTED', value: (c) => formatDate(c.connectedAt, human) },
          ],
          'No channels connected. Connect accounts in the Bulkit app first.',
        );
        const stale = list.filter((c) => c.needsReconnect).length;
        if (stale) {
          ctx.out.warn(`${stale} channel(s) need reconnecting in the app before they can publish.`);
        }
      });
    });

  channels
    .command('get')
    .description('Show one channel and what it allows')
    .argument('<channel>', 'channel id, @username, name, or platform')
    .action(async (ref, _opts, cmd) => {
      const ctx = context(cmd);
      const client = await ctx.client();
      const [channel] = await resolveChannels(client, [ref]);
      if (!channel) return;
      const [capabilities, platforms] = await Promise.all([
        client.channels.capabilities(channel.id),
        client.platforms.list(),
      ]);
      const remoteEdit = platforms.find((p) => p.id === channel.platform)?.limits.remoteEdit;
      ctx.out.print({ ...channel, capabilities }, () => {
        const { out } = ctx;
        out.fields([
          ['ID', channel.id],
          ['Platform', channel.platform],
          ['Name', channel.name],
          ['Username', channel.username ? `@${channel.username}` : undefined],
          [
            'Status',
            out.style(statusStyle(channelStatus(channel)) ?? 'reset', channelStatus(channel)),
          ],
          ['Retract', channel.manageStatus],
          // Editing needs both the connection's permission and a platform that edits at all.
          [
            'Edit live post',
            !remoteEdit
              ? `not supported by ${channel.platform}`
              : channel.manageStatus === 'available'
                ? `available (${remoteEdit.fields.join(', ')})`
                : channel.manageStatus,
          ],
          ['Comments', channel.commentsStatus],
          ['Metrics', channel.metricsStatus],
          ['Connected', formatDate(channel.connectedAt, out.isInteractive)],
        ]);
        if (capabilities.options.length) {
          out.line();
          out.heading('Account-specific options');
          out.line(JSON.stringify(capabilities.options, null, 2));
        }
      });
    });

  return channels;
}

function channelStatus(channel: Channel): string {
  return channel.needsReconnect ? 'needs reconnect' : 'ok';
}
