import { Command, CommanderError, type CommandUnknownOpts } from '@commander-js/extra-typings';
import { statsCommand, tagsCommand, usageCommand } from './commands/account';
import { authCommand } from './commands/auth';
import { channelsCommand } from './commands/channels';
import { commentsCommand } from './commands/comments';
import { completeCommand, completionCommand } from './commands/completion';
import { mediaCommand } from './commands/media';
import { platformsCommand } from './commands/platforms';
import { postsCommand } from './commands/posts';
import { webhooksCommand } from './commands/webhooks';
import { Context, type GlobalOptions } from './context';
import { commanderExitCode, describeError, type ExitCode, SilentExit } from './errors';
import { Output } from './output';
import type { Runtime } from './runtime';
import { UpdateCheck } from './update-check';
import { VERSION } from './version';

const DOCS_URL = 'https://docs.bulkit.io/docs/sdks/cli';
const ISSUES_URL = 'https://github.com/bulkit-io/bulkit-cli/issues';

export function buildProgram(runtime: Runtime): Command {
  const program = new Command('bulkit')
    .description('Schedule and publish social media posts from your terminal.')
    .version(VERSION, '-v, --version', 'print the version')
    .helpOption('-h, --help', 'show help for a command')
    .helpCommand('help [command]', 'show help for a command')
    .option('--json', 'print machine-readable JSON to stdout')
    .option(
      '--profile <name>',
      'use the API key saved under this profile (default: $BULKIT_PROFILE or "default")',
    )
    .option('--no-input', 'never prompt; fail instead when input or confirmation is needed')
    .option('--no-color', 'disable colored output')
    .option('--debug', 'log HTTP requests and show stack traces')
    .showSuggestionAfterError(true)
    .showHelpAfterError('(run with --help for usage)')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => runtime.stdout.write(s),
      writeErr: (s) => runtime.stderr.write(s),
    })
    .addHelpText(
      'after',
      `
Environment:
  BULKIT_API_KEY    API key to use instead of the saved one (CI, one-off commands)
  BULKIT_PROFILE    profile to use when --profile is not given
  NO_COLOR          disable colored output
  BULKIT_NO_UPDATE_NOTIFIER=1  never check for a newer version

Examples:
  $ bulkit auth login
  $ bulkit channels list
  $ bulkit posts create -c @acme -c linkedin -t "Shipping today." --at +2h
  $ bulkit posts list --status failed --json

Docs:   ${DOCS_URL}
Issues: ${ISSUES_URL}`,
    );

  const context = (command: CommandUnknownOpts) =>
    new Context(runtime, command.optsWithGlobals() as GlobalOptions);

  program.commandsGroup('Core commands:');
  program.addCommand(postsCommand(context));
  program.addCommand(channelsCommand(context));
  program.addCommand(mediaCommand(context));
  program.addCommand(commentsCommand(context));

  program.commandsGroup('Workspace commands:');
  program.addCommand(platformsCommand(context));
  program.addCommand(tagsCommand(context));
  program.addCommand(statsCommand(context));
  program.addCommand(usageCommand(context));
  program.addCommand(webhooksCommand(context));

  program.commandsGroup('Setup commands:');
  program.addCommand(authCommand(context));
  program.addCommand(completionCommand(context));
  program.addCommand(completeCommand(context), { hidden: true });

  // Every subcommand reports errors through us, writes through the runtime, and
  // offers "did you mean" for typos.
  for (const command of allCommands(program)) {
    command
      .helpOption('-h, --help', 'show help for a command')
      .exitOverride()
      .configureOutput(program.configureOutput())
      .showSuggestionAfterError(true)
      .showHelpAfterError('(run with --help for usage)');
  }
  return program;
}

/** Runs the CLI and resolves to the exit code. Never throws, never calls `process.exit`. */
export async function run(argv: readonly string[], runtime: Runtime): Promise<ExitCode> {
  const updates = UpdateCheck.enabled(runtime, argv) ? new UpdateCheck(runtime) : undefined;
  await updates?.start();

  const code = await execute(argv, runtime);

  const notice = await updates?.finish().catch(() => undefined);
  if (notice) runtime.stderr.write(`\n${notice}\n`);
  return code;
}

async function execute(argv: readonly string[], runtime: Runtime): Promise<ExitCode> {
  const program = buildProgram(runtime);
  // Bare `bulkit`: show help and succeed, like `gh`.
  if (argv.length === 0) {
    program.outputHelp();
    return 0;
  }
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (error) {
    // Commander has already printed its own message (and help) for parse errors.
    if (error instanceof CommanderError) return commanderExitCode(error);
    if (error instanceof SilentExit) return error.exitCode;

    const globals = program.opts() as GlobalOptions;
    const debug = !!globals.debug || argv.includes('--debug');
    const out = new Output(runtime.stdout, runtime.stderr, {
      json: !!globals.json || argv.includes('--json'),
      color: globals.color !== false && !argv.includes('--no-color'),
      env: runtime.env,
    });
    const report = describeError(error);
    const stack = (debug || report.unexpected) && error instanceof Error ? error.stack : undefined;
    out.error(report, stack);
    return report.exitCode;
  }
}

function* allCommands(command: CommandUnknownOpts): Generator<CommandUnknownOpts> {
  for (const sub of command.commands) {
    yield sub;
    yield* allCommands(sub);
  }
}
