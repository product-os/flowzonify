import { isMap } from 'yaml';

import { indentAt, isBlockMap, pairFor, pairRange } from '../source.js';

/**
 * Deliberately does not describe the trigger as optional: it is what fork
 * contributions publish from today, and internal branches move onto it later.
 */
export const PUSH_TRIGGER_COMMENT = [
	'# Fork contributions are rebuilt and published from the push to the default',
	'# branch after merge.',
];

export default {
	id: 'add-push-trigger',
	description:
		'Add the push trigger on the default branches, where fork contributions are rebuilt and published after merge.',

	apply(src, doc) {
		const triggers = doc.get('on');

		if (!isBlockMap(triggers)) {
			return {
				status: 'blocked',
				note: '`on:` is not a block mapping, so the push trigger cannot be added safely. Migrate this workflow by hand.',
			};
		}

		const pullRequest = pairFor(triggers, 'pull_request');
		if (!pullRequest) {
			return {
				status: 'blocked',
				note: 'there is no `pull_request` trigger to mirror, so the push trigger cannot be branch-matched automatically. Migrate this workflow by hand.',
			};
		}

		const existing = pairFor(triggers, 'push');
		if (existing) {
			return reconcile(src, existing, pullRequest);
		}

		if (cannotCopyBranches(pullRequest)) {
			return { status: 'blocked', note: FLOW_BRANCHES_NOTE };
		}

		const indent = indentAt(src, pullRequest.key.range[0]);
		const [, insertAt] = pairRange(src, pullRequest);
		const lead = src[insertAt - 1] === '\n' ? '' : '\n';

		const text =
			lead +
			PUSH_TRIGGER_COMMENT.map((line) => `${indent}${line}\n`).join('') +
			`${indent}push:\n` +
			branchesBlock(src, pullRequest, indent);

		return { status: 'applied', edits: [{ start: insertAt, end: insertAt, text }] };
	},

	verify(doc) {
		const triggers = doc.get('on');
		if (!isMap(triggers) || !triggers.has('push')) {
			return 'the push trigger is missing';
		}
	},
};

/**
 * An existing push trigger only does the job if it actually fires on a push to
 * the branches the caller tests. GitHub fires `push` on a branch when there is no
 * `branches`/`tags` filter at all, or when a `branches` pattern matches — a
 * `tags` filter on its own means tag pushes only, and `branches-ignore` cannot be
 * combined with `branches`.
 */
function reconcile(src, existing, pullRequest) {
	const filters = existing.value;
	const wanted = branchNames(pullRequest);

	if (!isMap(filters)) {
		return { status: 'skip' };
	}
	if (filters.has('branches-ignore')) {
		return {
			status: 'blocked',
			note: 'the push trigger uses `branches-ignore`, which cannot be combined with `branches`, so its default-branch coverage cannot be settled automatically. Migrate this workflow by hand.',
		};
	}

	const branches = pairFor(filters, 'branches');
	if (!branches) {
		// No branch filter and no tag filter fires on every branch already.
		if (!filters.has('tags')) {
			return { status: 'skip' };
		}
		if (!isBlockMap(filters)) {
			return {
				status: 'blocked',
				note: 'the push trigger is written in flow style, so a branches filter cannot be spliced into it. Migrate this workflow by hand.',
			};
		}
		if (cannotCopyBranches(pullRequest)) {
			return { status: 'blocked', note: FLOW_BRANCHES_NOTE };
		}
		return { status: 'applied', edits: [addBranches(src, existing, pullRequest)] };
	}

	const declared = branches.value?.items?.map((item) => String(item)) ?? [];
	if (declared.some((pattern) => pattern === '*' || pattern === '**')) {
		return { status: 'skip' };
	}

	const missing = wanted.filter((branch) => !declared.includes(branch));
	if (missing.length === 0) {
		return { status: 'skip' };
	}

	return {
		status: 'blocked',
		note: `the push trigger does not cover ${missing.map((b) => `\`${b}\``).join(', ')}, which the pull_request trigger tests, so fork contributions merged there would never publish. Add them to the push \`branches\` list by hand.`,
	};
}

const FLOW_BRANCHES_NOTE =
	'the pull_request trigger is written in flow style, so its branches list cannot be copied into a push trigger. Migrate this workflow by hand.';

/** branchesBlock copies the caller's branches lines verbatim, which needs them on lines of their own. */
function cannotCopyBranches(pullRequest) {
	return !isBlockMap(pullRequest.value) && pairFor(pullRequest.value, 'branches') != null;
}

function branchNames(pullRequest) {
	const branches = pairFor(pullRequest.value, 'branches');
	return branches?.value?.items?.map((item) => String(item)) ?? ['main', 'master'];
}

/** Give an existing push trigger a branch filter, leaving its tag filter alone. */
function addBranches(src, push, pullRequest) {
	const [, end] = pairRange(src, push.value.items.at(-1));
	// branchesBlock indents relative to the trigger key, as it does when inserting
	// a whole push block, so pass the trigger's indent rather than its children's.
	return { start: end, end, text: branchesBlock(src, pullRequest, indentAt(src, push.key.range[0])) };
}

/**
 * Reuse the caller's own `branches:` lines verbatim rather than re-rendering them.
 * Callers write the list in both flow and block style, and re-rendering one as the
 * other produces a diff on a line the migration has no business touching.
 */
function branchesBlock(src, pullRequest, indent) {
	const branches = pairFor(pullRequest.value, 'branches');

	if (!branches) {
		return `${indent}  branches: [main, master]\n`;
	}

	const [start, end] = pairRange(src, branches);
	const copied = src.slice(start, end);
	return copied.endsWith('\n') ? copied : `${copied}\n`;
}
