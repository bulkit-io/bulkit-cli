import { Command, InvalidArgumentError, Option } from '@commander-js/extra-typings';
import type { WebhookDelivery, WebhookEndpoint, WebhookUpdateParams } from 'bulkit';
import { ExitCode, SilentExit, UsageError } from '../errors';
import { formatDate, positiveInt } from '../format';
import type { Output } from '../output';
import { type MakeContext, statusStyle } from './shared';

const EVENTS = [
  'post.published',
  'post.failed',
  'post.partially_failed',
  'channel.needs_reconnect',
] as const;
type EventType = (typeof EVENTS)[number];

function eventOption() {
  return new Option('-e, --event <event>', 'event to deliver (repeatable)')
    .choices(EVENTS)
    .argParser((value, previous: EventType[] = []) => {
      if (!(EVENTS as readonly string[]).includes(value)) {
        throw new InvalidArgumentError(`Allowed choices are ${EVENTS.join(', ')}.`);
      }
      return [...previous, value as EventType];
    });
}

export function webhooksCommand(context: MakeContext) {
  const webhooks = new Command('webhooks')
    .alias('webhook')
    .description('Manage endpoints that receive post and channel events');

  webhooks
    .command('list')
    .alias('ls')
    .description('List webhook endpoints')
    .action(async (_opts, cmd) => {
      const ctx = context(cmd);
      const list = await (await ctx.client()).webhooks.list();
      ctx.out.print(list, () =>
        ctx.out.table(
          list,
          [
            { header: 'ID', value: (w) => w.id },
            { header: 'URL', value: (w) => w.url, shrink: true },
            { header: 'EVENTS', value: (w) => w.events.join(', ') },
            { header: 'STATUS', value: (w) => w.status, style: statusStyle },
          ],
          'No webhook endpoints.',
        ),
      );
    });

  webhooks
    .command('get')
    .description('Show a webhook endpoint')
    .argument('<webhook-id>')
    .action(async (id, _opts, cmd) => {
      const ctx = context(cmd);
      const endpoint = await (await ctx.client()).webhooks.retrieve(id);
      ctx.out.print(endpoint, () => renderEndpoint(ctx.out, endpoint));
    });

  webhooks
    .command('create')
    .description('Register an endpoint, and print its signing secret')
    .requiredOption('--url <url>', 'HTTPS URL that receives the events')
    .addOption(eventOption())
    .option('--all-events', 'subscribe to every event')
    .addHelpText(
      'after',
      `
The signing secret is shown once. Store it now: no other command returns it.

Example:
  $ bulkit webhooks create --url https://example.com/hooks/bulkit --event post.failed`,
    )
    .action(async (opts, cmd) => {
      const ctx = context(cmd);
      const events = opts.allEvents ? [...EVENTS] : (opts.event ?? []);
      if (events.length === 0) throw new UsageError('Pass at least one --event, or --all-events.');
      const issued = await (await ctx.client()).webhooks.create({ url: opts.url, events });
      ctx.out.print(issued, () => {
        ctx.out.success(`Created webhook ${issued.endpoint.id}.`);
        ctx.out.fields([['Secret', issued.secret]]);
        ctx.out.warn('Store this secret now. It is not shown again.');
      });
    });

  webhooks
    .command('update')
    .description('Change an endpoint’s URL or events, or turn it on or off')
    .argument('<webhook-id>')
    .option('--url <url>', 'new URL')
    .addOption(eventOption())
    .addOption(
      new Option('--enable', 'turn it on, and clear its failure streak').conflicts('disable'),
    )
    .option('--disable', 'stop deliveries')
    .action(async (id, opts, cmd) => {
      const ctx = context(cmd);
      const params: WebhookUpdateParams = {
        url: opts.url,
        events: opts.event,
        enabled: opts.enable ? true : opts.disable ? false : undefined,
      };
      if (Object.values(params).every((v) => v === undefined)) {
        throw new UsageError('Nothing to change.', 'Pass --url, --event, --enable or --disable.');
      }
      const endpoint = await (await ctx.client()).webhooks.update(id, params);
      ctx.out.print(endpoint, () =>
        ctx.out.success(`Updated webhook ${endpoint.id} (${endpoint.status}).`),
      );
    });

  webhooks
    .command('delete')
    .alias('rm')
    .description('Delete a webhook endpoint')
    .argument('<webhook-id>')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (id, opts, cmd) => {
      const ctx = context(cmd);
      await ctx.confirm({
        message: `Delete webhook ${id}? Deliveries stop immediately.`,
        yes: opts.yes,
      });
      await (await ctx.client()).webhooks.delete(id);
      ctx.out.print({ id, deleted: true }, () => ctx.out.success(`Deleted webhook ${id}.`));
    });

  webhooks
    .command('test')
    .description('Send a signed webhook.test event to an endpoint now; exits 1 if it fails')
    .argument('<webhook-id>')
    .action(async (id, _opts, cmd) => {
      const ctx = context(cmd);
      const result = await (await ctx.client()).webhooks.test(id);
      ctx.out.print(result, () => {
        const status =
          result.responseStatus === null ? 'no response' : `HTTP ${result.responseStatus}`;
        if (result.ok) ctx.out.success(`Delivered (${status}, ${result.durationMs}ms).`);
        else ctx.out.warn(`Delivery failed (${status}${result.error ? `: ${result.error}` : ''}).`);
      });
      if (!result.ok) throw new SilentExit(ExitCode.Error);
    });

  webhooks
    .command('roll-secret')
    .description('Issue a new signing secret; the old one stops working immediately')
    .argument('<webhook-id>')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (id, opts, cmd) => {
      const ctx = context(cmd);
      await ctx.confirm({
        message: `Roll the secret for webhook ${id}? Your receiver rejects deliveries until it has the new one.`,
        yes: opts.yes,
      });
      const issued = await (await ctx.client()).webhooks.rollSecret(id);
      ctx.out.print(issued, () => {
        ctx.out.fields([['Secret', issued.secret]]);
        ctx.out.warn('Store this secret now. It is not shown again.');
      });
    });

  webhooks
    .command('deliveries')
    .description('List recent delivery attempts to an endpoint, newest first')
    .argument('<webhook-id>')
    .option('-L, --limit <n>', 'how many to show', positiveInt, 25)
    .option('--all', 'show every delivery (ignores --limit)')
    .action(async (id, opts, cmd) => {
      const ctx = context(cmd);
      const client = await ctx.client();
      const list: WebhookDelivery[] = [];
      for await (const delivery of client.webhooks.deliveries(id, {
        limit: Math.min(opts.limit, 100),
      })) {
        list.push(delivery);
        if (!opts.all && list.length >= opts.limit) break;
      }
      ctx.out.print(list, () => ctx.out.line(JSON.stringify(list, null, 2)));
    });

  return webhooks;
}

function renderEndpoint(out: Output, endpoint: WebhookEndpoint): void {
  const human = out.isInteractive;
  out.fields([
    ['ID', endpoint.id],
    ['URL', endpoint.url],
    ['Description', endpoint.description ?? undefined],
    ['Events', endpoint.events.join(', ')],
    ['Status', out.style(statusStyle(endpoint.status) ?? 'reset', endpoint.status)],
    ['Disabled because', endpoint.disabledReason ?? undefined],
    ['Secret', `…${endpoint.secretLast4}`],
    ['Created', formatDate(endpoint.createdAt, human)],
  ]);
}
