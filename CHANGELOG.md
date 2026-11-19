# bulkit-cli

## 0.2.0

### Minor Changes

- d46bc22: `media list` reads the media library a page at a time, newest first, because `GET /media` is now paged. It shows the newest 25 by default: `--limit <n>` changes that, `--all` lists every file, and the CLI says so when `--limit` left files out. Needs `bulkit` 0.2.0.

## 0.1.0

### Minor Changes

- 6cf20da: First release of the Bulkit CLI: log in, list channels and platforms, create, schedule, publish, retract and manage posts, upload media from files or URLs, answer comments, read stats and usage, manage webhooks, and complete commands in bash, zsh and fish, with `--json` output and stable exit codes for scripts.
