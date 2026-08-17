import { test } from 'node:test';
import {
	readFileSync,
	readdirSync,
	mkdtempSync,
	mkdirSync,
	writeFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Context } from '../lib/migrate.ts';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

/** A throwaway repository containing the given files, cleaned up after the test. */
export function repo(
	files: Record<string, string> = {},
	prefix = 'flowzonify-test-',
): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	for (const [name, contents] of Object.entries(files)) {
		const path = join(dir, name);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, contents, { encoding: 'utf8' });
	}
	test.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** One fixture's input, by name. */
export function fixture(name: string): string {
	return readFileSync(join(FIXTURES, 'input', `${name}.yml`), 'utf8');
}

/**
 * Repository context a fixture needs, for the migrations that depend on more than
 * the workflow file. Keyed by fixture name; anything absent gets no context, which
 * those migrations must treat as "skip rather than guess".
 */
const FIXTURE_CONTEXT: Record<string, Context | undefined> = {
	'custom-runs-on.yml': { customActions: ['test'] },
	'unknown-inputs-and-keys.yml': {
		isNpmPackage: true,
		customActions: ['test'],
	},
};

export function fixturePairs() {
	return readdirSync(join(FIXTURES, 'input'))
		.filter((entry) => entry.endsWith('.yml'))
		.map((entry) => ({
			name: entry,
			input: readFileSync(join(FIXTURES, 'input', entry), 'utf8'),
			expectedPath: join(FIXTURES, 'expected', entry),
			context: FIXTURE_CONTEXT[entry] ?? {},
		}));
}

/** The caller workflow as flowzonify.sh used to generate it, before the trust boundary rework. */
export const LEGACY_CALLER = `name: Flowzone

on:
  pull_request:
    types: [opened, synchronize, closed]
    branches: [main, master]
  # allow external contributions to use secrets within trusted code
  pull_request_target:
    types: [opened, synchronize, closed]
    branches: [main, master]

jobs:
  flowzone:
    name: Flowzone
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    # prevent duplicate workflow executions for pull_request and pull_request_target
    if: |
      (
        github.event.pull_request.head.repo.full_name == github.repository &&
        github.event_name == 'pull_request'
      ) || (
        github.event.pull_request.head.repo.full_name != github.repository &&
        github.event_name == 'pull_request_target'
      )
    secrets: inherit
`;

/** A workflow that is not valid YAML: the stray key is indented past its parent. */
export const BROKEN_WORKFLOW = `jobs:
  flowzone:
    secrets: inherit
        stray: value
`;

/** A workflow that runs its own steps rather than calling flowzone. */
export const NON_CALLER = `on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

/** The routing condition as callers reflowed it onto one line per clause. */
export const REFLOWED_ROUTING_IF = `    if: |
      (github.event.pull_request.head.repo.full_name == github.repository && github.event_name == 'pull_request') ||
      (github.event.pull_request.head.repo.full_name != github.repository && github.event_name == 'pull_request_target')
`;

/** A caller whose routing condition was customised, which blocks the migration. */
export const BLOCKED_CALLER = LEGACY_CALLER.replace(
	'    if: |\n',
	"    if: |\n      github.actor != 'x' &&\n",
);

/** A minimal caller job, with whatever extra keys a test needs appended. */
export function caller(extra = '') {
	return `jobs:
  flowzone:
    uses: product-os/flowzone/.github/workflows/flowzone.yml@master
    secrets: inherit
${extra}`;
}
