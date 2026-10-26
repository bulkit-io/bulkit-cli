// Keeps src/version.ts in step with package.json after `changeset version`.
import { readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
writeFileSync(
  new URL('../src/version.ts', import.meta.url),
  `export const VERSION = '${version}';\n`,
);
console.log(`src/version.ts -> ${version}`);
