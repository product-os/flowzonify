import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A missing binary cannot appear mid-run, so probe for it once per name. */
const missing = new Set();

/**
 * Lint a workflow with actionlint, if it is installed.
 *
 * actionlint is deliberately optional: a maintainer running `npx flowzonify`
 * should not need a Go binary on their PATH. CI and the bulk migration runner
 * install it, so the strict check happens where it can be guaranteed.
 */
export function lintWorkflow(source, { bin = 'actionlint' } = {}) {
	if (missing.has(bin)) {
		return { available: false, ok: true, output: '' };
	}

	const dir = mkdtempSync(join(tmpdir(), 'flowzonify-'));

	try {
		const workflows = join(dir, '.github', 'workflows');
		mkdirSync(workflows, { recursive: true });

		const file = join(workflows, 'flowzone.yml');
		writeFileSync(file, source);

		// No shell: the binary name and its arguments are passed as an argv array.
		const result = spawnSync(bin, ['-no-color', file], { encoding: 'utf8' });

		if (result.error?.code === 'ENOENT') {
			missing.add(bin);
			return { available: false, ok: true, output: '' };
		}

		return {
			available: true,
			ok: result.status === 0,
			output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Lint a migration rather than a file: report only the diagnostics the migration
 * introduced.
 *
 * Callers' workflows are not all actionlint-clean to begin with — `with: {}`,
 * self-hosted runner labels actionlint does not know, shellcheck notes in
 * unrelated steps. Failing a good migration over a problem it did not cause
 * would strand those repositories on the old configuration for no reason.
 */
export function lintRegressions(before, after, options) {
	const migrated = lintWorkflow(after, options);

	// A clean result has no diagnostics to attribute, so the `before` lint — a
	// whole extra process spawn, which dwarfs the linting itself — cannot change
	// the answer.
	if (!migrated.available || migrated.ok) {
		return { available: migrated.available, ok: true, output: '' };
	}

	const existing = countDiagnostics(lintWorkflow(before, options).output);
	const introduced = [];

	for (const diagnostic of diagnostics(migrated.output)) {
		const seen = existing.get(diagnostic) ?? 0;
		if (seen > 0) {
			existing.set(diagnostic, seen - 1);
		} else {
			introduced.push(diagnostic);
		}
	}

	return { available: true, ok: introduced.length === 0, output: introduced.join('\n') };
}

/**
 * The message and rule of each diagnostic, without its position — line numbers
 * shift as the migration adds and removes lines, so comparing them with
 * positions attached would report every surviving diagnostic as a new one.
 */
function diagnostics(output) {
	return output
		.split('\n')
		.map((line) => /^.*?:\d+:\d+: (.*)$/.exec(line)?.[1])
		.filter(Boolean);
}

function countDiagnostics(output) {
	const counts = new Map();
	for (const diagnostic of diagnostics(output)) {
		counts.set(diagnostic, (counts.get(diagnostic) ?? 0) + 1);
	}
	return counts;
}
