#!/usr/bin/env node

// Checked before anything else is loaded, so an old Node gets this message and not a
// syntax error from a dependency.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`bulkit needs Node.js 22.12 or later; this is ${process.version}.\n`);
  process.exit(1);
}

// Ctrl-C exits at once with the conventional code. Nothing is left half-written: config
// writes are atomic, and an interrupted API call is either received or not.
process.on('SIGINT', () => {
  process.stderr.write('\n');
  process.exit(130);
});

// `bulkit posts list | head` closes stdout early. That is not an error.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

export {};

const { run } = await import('./cli');
const { nodeRuntime } = await import('./runtime');

// Set the code and let the event loop drain rather than calling `process.exit()`,
// which can cut off output still being written to a pipe.
process.exitCode = await run(process.argv.slice(2), nodeRuntime());
