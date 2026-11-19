---
'bulkit-cli': minor
---

`media list` reads the media library a page at a time, newest first, because `GET /media` is now paged. It shows the newest 25 by default: `--limit <n>` changes that, `--all` lists every file, and the CLI says so when `--limit` left files out. Needs `bulkit` 0.2.0.
