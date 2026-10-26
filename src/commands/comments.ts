import { Command } from '@commander-js/extra-typings';
import type { Comment } from 'bulkit';
import { UsageError } from '../errors';
import { formatDate, positiveInt } from '../format';
import { type MakeContext, resolveChannels } from './shared';

export function commentsCommand(context: MakeContext) {
  const comments = new Command('comments')
    .alias('comment')
    .description('Read and answer comments on published posts');

  comments
    .command('list')
    .alias('ls')
    .description('List comments on one channel’s copy of a post')
    .argument('<post-id>')
    .requiredOption(
      '-c, --channel <channel>',
      'which channel’s copy: id, @username, name or platform',
    )
    .option('-L, --limit <n>', 'how many comments to show', positiveInt, 50)
    .option('--all', 'show every comment (ignores --limit)')
    .action(async (postId, opts, cmd) => {
      const ctx = context(cmd);
      const client = await ctx.client();
      const [channel] = await resolveChannels(client, [opts.channel]);
      if (!channel) return;
      const list: Comment[] = [];
      for await (const comment of client.posts.comments.list(postId, { channelId: channel.id })) {
        list.push(comment);
        if (!opts.all && list.length >= opts.limit) break;
      }
      ctx.out.print(list, () => {
        const human = ctx.out.isInteractive;
        const rows = list.flatMap((c) => [c, ...c.replies.map((r) => ({ ...r, isReply: true }))]);
        ctx.out.table(
          rows,
          [
            { header: 'ID', value: (c) => c.id },
            {
              header: 'AUTHOR',
              value: (c) =>
                `${'isReply' in c ? '↳ ' : ''}${c.authorHandle ? `@${c.authorHandle}` : c.authorName}`,
            },
            { header: 'WHEN', value: (c) => formatDate(c.createdAt, human) },
            { header: 'TEXT', value: (c) => c.text, shrink: true },
          ],
          'No comments yet.',
        );
      });
    });

  comments
    .command('reply')
    .description('Reply publicly to a comment')
    .argument('<post-id>')
    .argument('<comment-id>')
    .requiredOption('-c, --channel <channel>', 'which channel’s copy the comment is on')
    .requiredOption('-t, --text <text>', 'the reply')
    .option('-y, --yes', 'do not ask for confirmation')
    .addHelpText('after', '\nThe reply is public the moment it is posted.')
    .action(async (postId, commentId, opts, cmd) => {
      const ctx = context(cmd);
      if (!opts.text.trim()) throw new UsageError('The reply is empty.');
      const client = await ctx.client();
      const [channel] = await resolveChannels(client, [opts.channel]);
      if (!channel) return;
      if (!(await ctx.isTestMode())) {
        ctx.out.info(
          `Reply to ${commentId} on ${channel.platform}:\n\n  ${opts.text.replace(/\n/g, '\n  ')}\n`,
        );
        await ctx.confirm({ message: 'Post this reply publicly?', yes: opts.yes });
      }
      const reply = await client.posts.comments.reply(postId, commentId, {
        channelId: channel.id,
        text: opts.text,
      });
      ctx.out.print(reply, () => {
        ctx.out.line(reply.url ?? reply.id);
        ctx.out.success('Reply posted.');
      });
    });

  return comments;
}
