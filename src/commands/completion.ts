import {
  Argument,
  Command,
  type CommandUnknownOpts,
  type Option,
} from '@commander-js/extra-typings';
import type { MakeContext } from './shared';

const SHELLS = ['bash', 'zsh', 'fish'] as const;
type Shell = (typeof SHELLS)[number];

/**
 * `bulkit completion <shell>` prints a small script; the script asks the hidden
 * `bulkit __complete` command for candidates on every Tab. Completions therefore come
 * from the command tree itself and cannot drift from it, as in `gh` and other cobra CLIs.
 */
export function completionCommand(context: MakeContext) {
  return new Command('completion')
    .description('Print a shell completion script')
    .addArgument(new Argument('<shell>', 'bash, zsh or fish').choices(SHELLS))
    .addHelpText(
      'after',
      `
Load it from your shell's startup file:
  bash  $ echo 'eval "$(bulkit completion bash)"' >> ~/.bashrc
  zsh   $ echo 'eval "$(bulkit completion zsh)"' >> ~/.zshrc     # after compinit
  fish  $ bulkit completion fish > ~/.config/fish/completions/bulkit.fish

Then open a new shell.`,
    )
    .action((shell, _opts, cmd) => {
      context(cmd).out.line(SCRIPTS[shell as Shell].trim());
    });
}

export function completeCommand(context: MakeContext) {
  return new Command('__complete')
    .description('Print completion candidates for the given words (used by completion scripts)')
    .argument('[words...]')
    .helpOption(false)
    .action((words, _opts, cmd) => {
      const root = cmd.parent;
      if (!root) return;
      const out = context(cmd).out;
      for (const [value, description] of complete(root, words)) {
        out.line(description ? `${value}\t${description}` : value);
      }
    });
}

type Candidate = [value: string, description: string];

/**
 * Candidates for the last word of `words` (the one being typed, possibly empty), given
 * the words before it. No candidates tells the shell to fall back to file names.
 */
export function complete(root: CommandUnknownOpts, words: readonly string[]): Candidate[] {
  const current = words.at(-1) ?? '';
  const before = words.slice(0, -1);
  let command = root;
  let positional = 0;

  for (let i = 0; i < before.length; i++) {
    const word = before[i] as string;
    if (word === '--') return [];
    if (word.startsWith('-')) {
      // `--at +2h` consumes the next word; `--at=+2h` does not.
      const option = findOption(root, command, word);
      if (option && takesValue(option) && !word.includes('=')) {
        if (i === before.length - 1) return choices(option.argChoices, current);
        i++;
      }
      continue;
    }
    const sub = command.commands.find((c) => c.name() === word || c.aliases().includes(word));
    if (sub && positional === 0) command = sub;
    else positional++;
  }

  const help = command.createHelp();
  if (current.startsWith('-')) {
    const options = [...help.visibleOptions(command)];
    if (command !== root) options.push(...root.createHelp().visibleOptions(root));
    return options
      .flatMap((o): Candidate[] => {
        const names = [o.long, o.short].filter((n): n is string => !!n);
        return names.map((name) => [name, o.description]);
      })
      .filter(([name]) => name.startsWith(current));
  }

  if (positional === 0) {
    const subs = help.visibleCommands(command).filter((c) => c.name() !== 'help');
    if (subs.length > 0) {
      return subs
        .map((c): Candidate => [c.name(), c.description()])
        .filter(([name]) => name.startsWith(current));
    }
  }
  const argument = command.registeredArguments[positional] ?? command.registeredArguments.at(-1);
  return choices(argument?.argChoices, current);
}

function findOption(
  root: CommandUnknownOpts,
  command: CommandUnknownOpts,
  word: string,
): Option | undefined {
  const flag = word.split('=')[0];
  const matches = (o: Option) => o.long === flag || o.short === flag;
  return command.options.find(matches) ?? root.options.find(matches);
}

function takesValue(option: Option): boolean {
  return option.required || option.optional;
}

function choices(values: readonly string[] | undefined, prefix: string): Candidate[] {
  return (values ?? []).filter((v) => v.startsWith(prefix)).map((v) => [v, '']);
}

const SCRIPTS: Record<Shell, string> = {
  bash: `
# bash completion for bulkit
_bulkit() {
  local cur=\${COMP_WORDS[COMP_CWORD]}
  # Slice before changing IFS: bash 3.2 (macOS) joins a quoted slice with a custom IFS.
  local words=("\${COMP_WORDS[@]:1:COMP_CWORD}")
  local IFS=$'\\n'
  COMPREPLY=($(compgen -W "$(bulkit __complete -- "\${words[@]}" 2>/dev/null | cut -f1)" -- "$cur"))
}
complete -o default -F _bulkit bulkit
`,
  zsh: `
#compdef bulkit
# zsh completion for bulkit
_bulkit() {
  local -a lines items
  local line
  lines=("\${(@f)$(bulkit __complete -- "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
  for line in $lines; do
    [[ -z $line ]] && continue
    if [[ $line == *$'\\t'* ]]; then
      items+=("\${line%%$'\\t'*}:\${\${line#*$'\\t'}//:/\\\\:}")
    else
      items+=("$line")
    fi
  done
  if (( \${#items} )); then
    _describe -t bulkit bulkit items
  else
    _files
  fi
}
if [[ $funcstack[1] == _bulkit ]]; then
  _bulkit "$@"
else
  compdef _bulkit bulkit
fi
`,
  fish: `
# fish completion for bulkit
function __bulkit_complete
    set -l words (commandline -opc) (commandline -ct)
    set -l candidates (bulkit __complete -- $words[2..-1] 2>/dev/null)
    if test (count $candidates) -eq 0
        __fish_complete_path (commandline -ct)
    else
        printf '%s\\n' $candidates
    end
end
complete -c bulkit -f -a '(__bulkit_complete)'
`,
};
