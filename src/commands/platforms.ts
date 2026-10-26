import { Command } from '@commander-js/extra-typings';
import { UsageError } from '../errors';
import type { MakeContext } from './shared';

export function platformsCommand(context: MakeContext) {
  const platforms = new Command('platforms')
    .alias('platform')
    .description('Show what each platform accepts: lengths, media, threads');

  platforms
    .command('list')
    .alias('ls')
    .description('List platforms and their limits')
    .action(async (_opts, cmd) => {
      const ctx = context(cmd);
      const list = await (await ctx.client()).platforms.list();
      ctx.out.print(list, () =>
        ctx.out.table(list, [
          { header: 'ID', value: (p) => p.id },
          { header: 'NAME', value: (p) => p.name },
          { header: 'MAX CHARS', value: (p) => String(p.limits.maxCharacters) },
          { header: 'MAX MEDIA', value: (p) => String(p.limits.maxMedia) },
          {
            header: 'THREAD',
            value: (p) => (p.limits.maxBlocks > 1 ? `up to ${p.limits.maxBlocks}` : 'no'),
          },
          { header: 'MEDIA REQUIRED', value: (p) => (p.limits.requiresMedia ? 'yes' : 'no') },
        ]),
      );
    });

  platforms
    .command('get')
    .description('Show every rule for one platform')
    .argument('<platform>', 'platform id, e.g. x, linkedin, instagram')
    .action(async (id, _opts, cmd) => {
      const ctx = context(cmd);
      const list = await (await ctx.client()).platforms.list();
      const platform = list.find((p) => p.id === id.toLowerCase());
      if (!platform) {
        throw new UsageError(
          `Unknown platform "${id}".`,
          `Known platforms: ${list.map((p) => p.id).join(', ')}.`,
        );
      }
      ctx.out.print(platform, () => {
        const { out } = ctx;
        const { limits } = platform;
        out.fields([
          ['Platform', `${platform.name} (${platform.id})`],
          ['Max characters', String(limits.maxCharacters)],
          ['Max media', String(limits.maxMedia)],
          [
            'Thread',
            limits.maxBlocks > 1 ? `up to ${limits.maxBlocks} ${platform.continuationNoun}s` : 'no',
          ],
          ['Media required', limits.requiresMedia ? 'yes' : 'no'],
          ['Alt text', limits.supportsAltText ? 'yes' : 'no'],
          [
            'Title',
            limits.title
              ? `${limits.title.label}, up to ${limits.title.maxCharacters} chars`
              : undefined,
          ],
          ['Accepted media', limits.acceptedMimeTypes.join(', ') || undefined],
          ['Post types', platform.postTypes.map((t) => t.key).join(', ') || undefined],
        ]);
        if (limits.options.length) {
          out.line();
          out.table(limits.options, [
            { header: 'OPTION', value: (o) => o.key },
            { header: 'TYPE', value: (o) => o.type },
            { header: 'REQUIRED', value: (o) => (o.required ? 'yes' : 'no') },
            { header: 'DESCRIPTION', value: (o) => o.help ?? o.label, shrink: true },
          ]);
        }
      });
    });

  return platforms;
}
