# Bulkit CLI

[![npm](https://img.shields.io/npm/v/bulkit-cli.svg)](https://www.npmjs.com/package/bulkit-cli)
[![Docs](https://img.shields.io/badge/docs-docs.bulkit.io-blue)](https://docs.bulkit.io/docs/sdks/cli?utm_source=npm&utm_medium=readme&utm_campaign=cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

**Schedule and publish to X, LinkedIn, Instagram, Facebook, Threads, TikTok, YouTube, Pinterest,
Reddit, Bluesky and Vimeo from your terminal, your scripts and your CI.**

```sh
bulkit posts create -c @acme -c linkedin -t "Shipping today." --at +2h
```

Built on the official [`bulkit`](https://www.npmjs.com/package/bulkit) Node.js SDK.
[Documentation](https://docs.bulkit.io/docs/sdks/cli?utm_source=npm&utm_medium=readme&utm_campaign=cli) ·
[Command reference](https://docs.bulkit.io/docs/sdks/cli-reference?utm_source=npm&utm_medium=readme&utm_campaign=cli)

## Install

```sh
npm install -g bulkit-cli
# or run it without installing:
npx bulkit-cli --help
```

Requires Node.js 22.12 or later.

## Log in

Create an API key in the [Bulkit app](https://app.bulkit.io) under **Developers → API &
Webhooks**, then:

```sh
bulkit auth login            # paste the key when asked (input is hidden)
bulkit auth status           # check which key is in use, and that it works
```

> **Start with a test key.** A `bk_test_…` key validates every request like a live key but
> never publishes and is never billed. With a test key, the CLI also skips its "are you
> sure?" prompts.

In CI or scripts, either pipe the key in or set it in the environment:

```sh
bulkit auth login --with-key < key.txt
BULKIT_API_KEY=bk_live_… bulkit posts list
```

Keys are saved in `~/.config/bulkit/config.json` (`%APPDATA%\bulkit` on Windows), readable
only by you. Use `--profile <name>` (or `BULKIT_PROFILE`) to keep keys for several workspaces.

## Usage

```sh
# What can I post to, and what does each platform accept?
bulkit channels list
bulkit platforms get instagram

# One post, several channels. Channels can be given by id, @username, name, or platform.
bulkit posts create -c @acme -c linkedin -t "Shipping today." --at 2026-11-01T09:00

# A thread: one --text per block.
bulkit posts create -c x -t "1/ Big news" -t "2/ Here is why" --draft

# Media: upload a file or a URL, then attach by id.
id=$(bulkit media upload launch.mp4)
id=$(bulkit media upload https://cdn.example.com/launch.png)
bulkit posts create -c tiktok -m "$id" -t "Launch day" --now --wait

# Different text per channel, or platform options: describe the post as JSON.
bulkit posts create --file post.json --at +1d

# Follow up.
bulkit posts list --status failed
bulkit posts publish pst_123          # retry; channels that already published are skipped
bulkit comments list pst_123 -c x
```

Run `bulkit --help`, or `bulkit <command> --help`, for every command and flag, or see the
[command reference](https://docs.bulkit.io/docs/sdks/cli-reference?utm_source=npm&utm_medium=readme&utm_campaign=cli).

| Command     | What it does                                                         |
| ----------- | -------------------------------------------------------------------- |
| `posts`     | `list`, `get`, `create`, `update`, `publish`, `revise`, `retract`, `delete`, `metrics` |
| `channels`  | `list`, `get`: connected accounts and what each allows               |
| `media`     | `list`, `upload` (files or URLs; large videos upload in parts), `delete` |
| `comments`  | `list`, `reply`                                                      |
| `platforms` | `list`, `get`: live limits for each platform                         |
| `tags`      | `list`                                                               |
| `stats`     | totals for a window; `stats insights` for what performs best         |
| `usage`     | this period's usage against your plan                                |
| `webhooks`  | `list`, `get`, `create`, `update`, `delete`, `test`, `roll-secret`, `deliveries` |
| `auth`      | `login`, `logout`, `status`                                          |
| `completion`| print a shell completion script                                      |

### Shell completion

Tab completes commands, flags and fixed values such as `--status`, with descriptions in zsh
and fish. Add one line to your shell's startup file, then open a new shell:

```sh
echo 'eval "$(bulkit completion bash)"' >> ~/.bashrc
echo 'eval "$(bulkit completion zsh)"' >> ~/.zshrc      # after compinit
bulkit completion fish > ~/.config/fish/completions/bulkit.fish
```

### Uploading from a URL

`bulkit media upload` takes `https://` URLs as well as paths. The CLI downloads the file to a
temporary directory and uploads it like a local one, so the URL only needs to be reachable
from your machine. The type comes from `--mime-type`, the server's `Content-Type`, or the
extension, in that order; a link that returns a web page is refused.

Quote URLs that contain `&` or `?`, or your shell will cut them short:

```sh
bulkit media upload 'https://cdn.example.com/photo.jpg?width=1200&quality=85'
```

### Publishing is asynchronous

`--now` and `posts publish` return as soon as the post is queued. Add `--wait` to block until
every channel has finished. The command then exits `1` if any channel failed. You can also
check later with `bulkit posts get <id> --wait`.

### Safety

Everything here acts on real accounts. With a live key, the CLI asks before anything public
or destructive: publishing now, replying to a comment, deleting things. `posts retract` deletes
published copies permanently, so it asks you to type the post id. Pass `--yes` to confirm
without a prompt. Without a terminal (CI, pipes, `--no-input`), the CLI never prompts: it
fails and tells you to add `--yes`.

`posts create --dry-run` prints the request body without sending it. Pass the same
`--idempotency-key` to make a retried `create` safe across runs: the API will not create a
duplicate.

## Scripting

- **`--json`** prints the API's objects unchanged on stdout. Use it in scripts: the human
  output may change between releases, and the JSON will not.
- When stdout is not a terminal, tables print as headerless, tab-separated rows, so `cut`
  and `awk` work.
- `posts create` and `media upload` print only ids on stdout. Messages go to stderr, so
  `id=$(bulkit posts create …)` works.
- Errors go to stderr. With `--json`, they are a JSON object too:
  `{"error": {"message", "code", "status", "requestId", "hint", "exitCode"}}`.

### Exit codes

| Code  | Meaning                                                                    |
| ----- | -------------------------------------------------------------------------- |
| `0`   | Success                                                                    |
| `1`   | Failed: an API error, a post that failed to publish, a cancelled prompt    |
| `2`   | Usage error: unknown command or flag, bad value, missing `--yes`           |
| `3`   | Not logged in, or the API key was rejected or lacks the scope              |
| `4`   | Not found                                                                  |
| `5`   | Plan quota exhausted for this period (see `bulkit usage`)                  |
| `130` | Interrupted (Ctrl-C)                                                       |

## Environment

| Variable                      | Effect                                                     |
| ----------------------------- | ---------------------------------------------------------- |
| `BULKIT_API_KEY`              | API key to use, overriding the saved one                   |
| `BULKIT_PROFILE`              | Profile to use when `--profile` is not given               |
| `BULKIT_BASE_URL`             | Send requests to another host (a proxy or mock server)     |
| `BULKIT_CONFIG_DIR`           | Where to keep `config.json`                                |
| `BULKIT_DEBUG=1`              | Same as `--debug`: log each request, show stack traces     |
| `BULKIT_NO_INPUT=1`, `CI`     | Same as `--no-input`: never prompt                         |
| `BULKIT_NO_UPDATE_NOTIFIER=1` | Never check npm for a newer version (checked once a day otherwise) |
| `NO_COLOR`, `FORCE_COLOR`     | Turn colors off or on                                      |

## Development

```sh
pnpm install
pnpm dev                 # rebuild on change
node dist/bin.js --help
pnpm check               # lint, typecheck, test, build, package lint
```

Releases use [Changesets](https://github.com/changesets/changesets): run `pnpm changeset`
and describe the change; merging the release PR publishes to npm.

## License

MIT
