#!/usr/bin/env node
// `wikistow`: the agent CLI. Runs on its own, with no desktop app, daemon or
// local server (wikistow.md, Architecture).
import { run } from './cli.ts';
import { nodeIo } from './node-io.ts';

process.exitCode = await run(process.argv.slice(2), nodeIo());
