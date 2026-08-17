/**
 * The commit message and pull request body the action asks create-pull-request to
 * use, derived from flowzonify's own `--json` report.
 *
 * Kept free of dependencies on purpose: this runs from `$GITHUB_ACTION_PATH`, which
 * the runner checks out without installing anything, so `yaml` is not available even
 * though the package depends on it.
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Type-only imports, so the shapes stay defined in one place. Node's type stripping
// erases these, which is what keeps `action/` free of the `yaml` dependency that a
// value import from `lib/` would drag in.
import type { ReportEntry } from '../lib/migrate.ts';
import type { FileResult } from '../lib/run.ts';

/** The `--json` report `flowzonify migrate` prints. */
export interface MigrateReport {
	status: FileResult['status'];
	files: FileResult[];
}

/**
 * The migrations that changed the workflow. An `advisory` verdict splices its edits
 * too, so counting only `applied` would under-report what the commit contains.
 */
function changedUnits(report: MigrateReport): ReportEntry[] {
	return report.files.flatMap((file) =>
		file.report.filter(
			(entry) => entry.status === 'applied' || entry.status === 'advisory',
		),
	);
}

export interface MessageOptions {
	report: MigrateReport;
	/** Descriptions by migration id, from `parseList`. */
	descriptions: Record<string, string>;
	subject: string;
	repoYml?: string;
}

/**
 * The commit message: the subject, what each migration did, and the versionist footer.
 *
 * A pure function of the report on purpose. create-pull-request rewrites the branch
 * whenever the commit differs, so anything varying between runs on the same input —
 * a timestamp, a run URL — force-pushes and notifies every time.
 */
export function commitMessage({
	report,
	descriptions,
	subject,
	repoYml,
}: MessageOptions): string {
	const did = changedUnits(report).map(
		// The id rather than "undefined", for the reader, if a description goes missing.
		(entry) => `- ${descriptions[entry.id] ?? entry.id}`,
	);
	const trailer = footer({
		repoYml,
		subject,
		// The CLI reports this per file, and the action migrates one. `some` rather than
		// `every` so a report that does not say leaves the footer in place.
		versioningDisabled: report.files.some(
			(file) => file.versioningDisabled === true,
		),
	});

	return (
		[subject, did.join('\n'), trailer]
			.filter((part) => part != null && part !== '')
			.join('\n\n') + '\n'
	);
}

export interface BodyOptions {
	report: MigrateReport;
	descriptions: Record<string, string>;
}

/**
 * The pull request body. Whoever reviews this has probably never heard of flowzonify,
 * so it says what opened the pull request and what each migration did, then anything
 * the migrations wanted said.
 *
 * Byte-stable for the same report, like the commit message, so that re-running the
 * action does not edit the body and notify everybody watching.
 */
export function pullRequestBody({ report, descriptions }: BodyOptions): string {
	const units = changedUnits(report);

	const followUps = units
		.filter((entry) => entry.status === 'advisory' && entry.note != null)
		.map((entry) => `**Follow-up** — \`${entry.id}\`: ${entry.note}`);

	// The CLI says when it could not run actionlint rather than quietly downgrading its
	// checks. A reviewer deciding whether to trust this diff needs the same caveat, in
	// the same words.
	const unchecked = report.files.some(
		(file) => file.changed && file.lintChecked === 'unavailable',
	)
		? 'actionlint is not installed, so the migrated workflow was not fully checked.'
		: undefined;

	return (
		[
			'Opened by [flowzonify](https://github.com/product-os/flowzonify), which keeps this\n' +
				"repository's flowzone caller workflow up to date with flowzone itself.",
			units
				.map((entry) => `- ${descriptions[entry.id] ?? entry.id}`)
				.join('\n'),
			...followUps,
			unchecked,
		]
			.filter((part) => part != null && part !== '')
			.join('\n\n') + '\n'
	);
}

/**
 * The repository type `repo.yml` declares, normalised.
 *
 * Repositories in the wild spell these with spaces (`yocto-based OS image`), while
 * `REPO_TYPES` in `lib/run.ts` carries balena-versionist's hyphenated directory names
 * (`yocto-based-OS-image`). Both have to reach the same value, since the footer
 * convention is chosen from it.
 */
export function repoType(repoYml?: string): string | undefined {
	// Anchored at column 0: a nested `type:` belongs to whatever contains it, such as
	// an upstream declaration, and is not this repository's type.
	const declared = repoYml?.match(/^type:[ \t]*(.*)$/m)?.[1];
	if (declared == null) {
		return undefined;
	}

	const value = declared
		.replace(/#.*$/, '')
		.trim()
		.replace(/^['"]|['"]$/g, '')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');

	return value === '' ? undefined : value;
}

/**
 * The descriptions from `flowzonify --list`, by migration id.
 *
 * The `--json` report names the migrations that applied but not what they do, and the
 * descriptions exist to be read by whoever reviews the pull request. The listing is
 * `id`, then its description indented on the next line, then a blank line.
 */
export function parseList(text: string): Record<string, string> {
	const descriptions: Record<string, string> = {};
	const lines = text.split('\n');

	for (const [index, line] of lines.entries()) {
		// An id is flush left; anything indented belongs to the id above it.
		if (line === '' || /^\s/.test(line)) {
			continue;
		}
		const description = lines[index + 1]?.trim();
		if (description != null && description !== '') {
			descriptions[line.trim()] = description;
		}
	}

	return descriptions;
}

/**
 * What the action should do next. `blocked` is the CLI's own verdict — the workflow
 * needs a hand-edit and nothing was written — and only `migrated` is worth opening a
 * pull request about.
 */
export function statusOf(
	report: MigrateReport,
): 'blocked' | 'migrated' | 'unchanged' {
	// The action checks the CLI's exit code before running this, so an error here should
	// be unreachable. Refusing beats reporting a workflow that could not be read as
	// "up to date", which is what treating it as unchanged would do.
	const failed = report.files.find((file) => file.status === 'error');
	if (failed != null) {
		throw new Error(
			`${failed.path}: ${failed.error ?? 'could not be migrated'}`,
		);
	}

	if (report.files.some((file) => file.status === 'blocked')) {
		return 'blocked';
	}

	return report.files.some((file) => file.changed) ? 'migrated' : 'unchanged';
}

/**
 * The one repository type whose versionist strategy reads `Changelog-entry:` rather
 * than `Change-type:`. Verified against balena-raspberrypi, whose recent commits carry
 * Changelog-entry exclusively; meta-balena, a `yocto layer`, carries Change-type. So
 * this is narrower than "anything yocto".
 */
const CHANGELOG_ENTRY_TYPE = 'yocto-based-os-image';

/**
 * A workflow change is the smallest thing versionist has a word for, and there is no
 * case where migrating a caller is anything else — so this is a constant rather than an
 * input somebody has to think about.
 */
const CHANGE_TYPE = 'patch';

export interface FooterOptions {
	/** Contents of the repository's `repo.yml`, absent when it has none. */
	repoYml?: string;
	subject: string;
	/** Whether the caller turns flowzone's versioning off, when that is known. */
	versioningDisabled?: boolean;
}

/**
 * The versionist footer for this repository, or nothing when nothing would read it.
 *
 * Both footers are versionist's, so a caller passing `disable_versioning` gets neither:
 * a footer nothing reads says something untrue about the commit. Anything short of a
 * definite yes leaves the footer in place, which is the safe direction — a redundant
 * footer is inert, a missing one fails the caller's own versioning job.
 *
 * A device-type repository's changelog entry is prose, so it reuses the commit subject;
 * everywhere else the footer is a bare change type.
 */
export function footer({
	repoYml,
	subject,
	versioningDisabled,
}: FooterOptions): string | undefined {
	if (versioningDisabled === true) {
		return undefined;
	}

	return repoType(repoYml) === CHANGELOG_ENTRY_TYPE
		? `Changelog-entry: ${subject}`
		: `Change-type: ${CHANGE_TYPE}`;
}

function required(name: string): string {
	const value = process.env[name];
	if (value == null || value === '') {
		throw new Error(`${name} is not set`);
	}
	return value;
}

/** A file's contents, or nothing when it does not exist. */
function readIfPresent(path?: string): string | undefined {
	try {
		return path == null ? undefined : readFileSync(path, 'utf8');
	} catch {
		return undefined;
	}
}

/**
 * Append step outputs. A multi-line value needs the heredoc form, with a delimiter the
 * value cannot contain — hence a fresh uuid rather than a fixed marker, which a commit
 * message could otherwise carry and break the file with.
 */
function setOutputs(outputs: Record<string, string>): void {
	const lines = Object.entries(outputs).map(([name, value]) => {
		if (!value.includes('\n')) {
			return `${name}=${value}`;
		}
		const delimiter = randomUUID();
		return `${name}<<${delimiter}\n${value}\n${delimiter}`;
	});

	appendFileSync(required('GITHUB_OUTPUT'), `${lines.join('\n')}\n`, 'utf8');
}

function main(): void {
	const report = JSON.parse(
		readFileSync(required('FLOWZONIFY_REPORT'), 'utf8'),
	) as MigrateReport;
	const descriptions = parseList(
		readFileSync(required('FLOWZONIFY_LIST'), 'utf8'),
	);

	const status = statusOf(report);
	const outputs: Record<string, string> = { status };

	if (status === 'migrated') {
		const subject = required('FLOWZONIFY_SUBJECT');
		writeFileSync(
			required('FLOWZONIFY_BODY_PATH'),
			pullRequestBody({ report, descriptions }),
			'utf8',
		);
		outputs['commit-message'] = commitMessage({
			report,
			descriptions,
			subject,
			repoYml: readIfPresent(process.env.FLOWZONIFY_REPO_YML),
		});
		outputs.title = subject;
	}

	setOutputs(outputs);
}

// Only when run as the action's step, so the tests can import the functions above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
