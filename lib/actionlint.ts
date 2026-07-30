import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface LintResult {
	available: boolean;
	ok: boolean;
	output: string;
}

export interface LintOptions {
	bin?: string;
}

/** The result when actionlint did not run: nothing to report, nothing failed. */
export const LINT_SKIPPED: LintResult = {
	available: false,
	ok: true,
	output: '',
};

/** A missing binary cannot appear mid-run, so probe for it once per name. */
const missing = new Set<string>();

/**
 * Long enough that a slow machine linting one small file never trips it, short
 * enough that a fleet-wide run cannot be parked forever by one hung process.
 */
const TIMEOUT_MS = 30_000;

/**
 * Lint a workflow with actionlint, if it is installed.
 *
 * actionlint is deliberately optional: a maintainer running `npx flowzonify`
 * should not need a Go binary on their PATH. CI and the bulk migration runner
 * install it, so the strict check happens where it can be guaranteed.
 */
export function lintWorkflow(
	source: string,
	{ bin = 'actionlint' }: LintOptions = {},
): LintResult {
	if (missing.has(bin)) {
		return LINT_SKIPPED;
	}

	const dir = mkdtempSync(join(tmpdir(), 'flowzonify-'));

	try {
		const workflows = join(dir, '.github', 'workflows');
		mkdirSync(workflows, { recursive: true });

		const file = join(workflows, 'flowzone.yml');
		writeFileSync(file, source, { encoding: 'utf8' });

		// No shell: the binary name and its arguments are passed as an argv array.
		const result = spawnSync(bin, ['-no-color', file], {
			encoding: 'utf8',
			timeout: TIMEOUT_MS,
		});

		if (result.error != null) {
			if ('code' in result.error && result.error.code === 'ENOENT') {
				missing.add(bin);
				return LINT_SKIPPED;
			}
			// A timeout or a failed spawn is a problem with the linter rather than with
			// the workflow, so say so instead of letting it read as a clean lint.
			return {
				available: true,
				ok: false,
				output: `${bin}: ${result.error.message}`,
			};
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
export function lintRegressions(
	before: string,
	after: string,
	options?: LintOptions,
): LintResult {
	const migrated = lintWorkflow(after, options);

	// A clean result has no diagnostics to attribute, so the `before` lint — a
	// whole extra process spawn, which dwarfs the linting itself — cannot change
	// the answer.
	if (!migrated.available || migrated.ok) {
		return { available: migrated.available, ok: true, output: '' };
	}

	const found = diagnostics(migrated.output);

	// The linter failed while saying nothing this code recognises, so its failure
	// cannot be attributed to the migration or to the input. Refusing is the safe
	// reading: were actionlint's output to change shape, treating "nothing parsed" as
	// "nothing introduced" would quietly turn this whole gate into a no-op.
	if (found.length === 0) {
		return {
			available: true,
			ok: false,
			output:
				migrated.output || 'the linter failed without reporting a diagnostic',
		};
	}

	const existing = countDiagnostics(lintWorkflow(before, options).output);
	const introduced: string[] = [];

	for (const diagnostic of found) {
		const seen = existing.get(diagnostic) ?? 0;
		if (seen > 0) {
			existing.set(diagnostic, seen - 1);
		} else {
			introduced.push(diagnostic);
		}
	}

	return {
		available: true,
		ok: introduced.length === 0,
		output: introduced.join('\n'),
	};
}

/**
 * The message and rule of each diagnostic, without its position — line numbers
 * shift as the migration adds and removes lines, so comparing them with
 * positions attached would report every surviving diagnostic as a new one.
 *
 * actionlint writes one diagnostic as `path:line:col: message [rule]`, followed by
 * an indented excerpt of the offending source. Matching on the `:line:col:` prefix
 * therefore keeps the message and its `[rule]` suffix, and drops the excerpt lines,
 * which carry no such prefix.
 */
function diagnostics(output: string): string[] {
	return output
		.split('\n')
		.map((line) => /^.*?:\d+:\d+: (.*)$/.exec(line)?.[1])
		.filter((message) => message != null);
}

function countDiagnostics(output: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const diagnostic of diagnostics(output)) {
		counts.set(diagnostic, (counts.get(diagnostic) ?? 0) + 1);
	}
	return counts;
}
