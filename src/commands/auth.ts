import { Command, Option } from '@commander-js/extra-typings';
import { PermissionDeniedError } from 'bulkit';
import { isApiKey, isTestKey, maskKey } from '../config';
import { invalidKeyError, readAll } from '../context';
import { UsageError } from '../errors';
import type { MakeContext } from './shared';

export function authCommand(context: MakeContext) {
  const auth = new Command('auth').description('Log in, log out and check which key is in use');

  auth
    .command('login')
    .description('Save an API key on this machine')
    .option('--with-key', 'read the key from stdin instead of prompting for it')
    .addOption(new Option('--base-url <url>', 'send requests to another API host').hideHelp())
    .addHelpText(
      'after',
      `
Create a key in the Bulkit app under Developers → API & Webhooks. Start with a
bk_test_ key: it validates exactly like a live key but never publishes or bills.

The key is stored in your config directory, readable only by you. Use --profile
to keep several keys (e.g. one per workspace) side by side.

Examples:
  $ bulkit auth login
  $ bulkit auth login --with-key < key.txt
  $ bulkit auth login --profile acme`,
    )
    .action(async (opts, cmd) => {
      const ctx = context(cmd);
      const { out } = ctx;

      let key: string;
      if (opts.withKey) {
        key = (await readAll(ctx.runtime.stdin)).trim();
      } else if (ctx.canPrompt) {
        out.info('Paste an API key from the Bulkit app (Developers → API & Webhooks).');
        key = (await ctx.prompt.secret('API key: ')).trim();
      } else {
        throw new UsageError(
          'No API key given, and there is no terminal to prompt on.',
          'Pipe the key in: `bulkit auth login --with-key < key.txt`.',
        );
      }
      if (!isApiKey(key)) throw invalidKeyError();

      // Check the key before saving it, so a typo fails here and not on the next command.
      const client = ctx.createClient(key, opts.baseUrl);
      let plan: string | undefined;
      try {
        plan = (await client.usage.retrieve()).plan;
      } catch (error) {
        if (!(error instanceof PermissionDeniedError)) throw error;
        out.warn('This key is valid but cannot read usage, so some commands may be refused.');
      }

      await ctx.config.setProfile(ctx.profile, { apiKey: key, baseUrl: opts.baseUrl });
      const mode = isTestKey(key) ? 'test' : 'live';
      out.print(
        { profile: ctx.profile, mode, plan: plan ?? null, configPath: ctx.config.path },
        () => {
          out.success(
            `Logged in to profile "${ctx.profile}" with a ${mode} key (${maskKey(key)}).`,
          );
          if (mode === 'test')
            out.info('Test mode: requests are validated but nothing is published.');
        },
      );
      if (ctx.runtime.env.BULKIT_API_KEY) {
        out.warn(
          'BULKIT_API_KEY is set in your environment and takes precedence over the saved key.',
        );
      }
    });

  auth
    .command('logout')
    .description('Remove the saved API key from this machine')
    .action(async (_opts, cmd) => {
      const ctx = context(cmd);
      const removed = await ctx.config.removeProfile(ctx.profile);
      ctx.out.print({ profile: ctx.profile, removed }, () => {
        if (removed) ctx.out.success(`Logged out of profile "${ctx.profile}".`);
        else ctx.out.info(`Profile "${ctx.profile}" was not logged in.`);
      });
      if (ctx.runtime.env.BULKIT_API_KEY) {
        ctx.out.warn('BULKIT_API_KEY is still set in your environment, so commands keep using it.');
      }
    });

  auth
    .command('status')
    .description('Show which API key is in use, and check that it works')
    .action(async (_opts, cmd) => {
      const ctx = context(cmd);
      const { out } = ctx;
      const credentials = await ctx.credentials();
      const client = await ctx.client();
      const usage = await client.usage.retrieve();
      const mode = isTestKey(credentials.apiKey) ? 'test' : 'live';
      const status = {
        profile: credentials.profile,
        source: credentials.source,
        key: maskKey(credentials.apiKey),
        mode,
        plan: usage.plan,
        baseUrl: client.baseURL,
        configPath: ctx.config.path,
      };
      out.print(status, () => {
        out.success('Logged in, and the API accepted the key.');
        out.fields([
          ['Profile', status.profile],
          ['Key', `${status.key} (${mode})`],
          [
            'From',
            credentials.source === 'env' ? 'BULKIT_API_KEY environment variable' : ctx.config.path,
          ],
          ['Plan', status.plan],
          ['API', status.baseUrl],
        ]);
      });
    });

  return auth;
}
