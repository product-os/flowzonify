import { test } from 'node:test';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORPUS = fileURLToPath(new URL('./corpus/', import.meta.url));

/** Run a single migration unit against a source string, exactly as the runner does. */
export { applyUnit as runUnit } from '../lib/migrate.js';

/** A throwaway repository containing the given files, cleaned up after the test. */
export function repo(files = {}, prefix = 'flowzonify-test-') {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	for (const [name, contents] of Object.entries(files)) {
		const path = join(dir, name);
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, contents);
	}
	test.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** A corpus fixture, by name. */
export function fixture(name) {
	return readFileSync(join(CORPUS, 'input', `${name}.yml`), 'utf8');
}

/**
 * Repository context a fixture needs, for the migrations that depend on more than
 * the workflow file. Keyed by fixture name; anything absent gets no context, which
 * those migrations must treat as "skip rather than guess".
 */
const FIXTURE_CONTEXT = {
	'custom-runs-on.yml': { customActions: ['test'] },
};

export function corpusFixtures() {
	return readdirSync(join(CORPUS, 'input'))
		.filter((entry) => entry.endsWith('.yml'))
		.map((entry) => ({
			name: entry,
			input: readFileSync(join(CORPUS, 'input', entry), 'utf8'),
			expectedPath: join(CORPUS, 'expected', entry),
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
