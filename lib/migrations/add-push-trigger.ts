import { isCollection, isMap, stringify } from 'yaml';
import type { YAMLMap } from 'yaml';

import { indentAt, isBlockMap, pairFor, pairRange } from '../source.ts';
import type { Edit, SourcePair } from '../source.ts';
import type { Migration, UnitResult } from '../migrate.ts';

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

		const indent = indentAt(src, pullRequest.key.range[0]);
		const [, insertAt] = pairRange(src, pullRequest);
		const lead = src[insertAt - 1] === '\n' ? '' : '\n';

		// No comment goes with it. Prose written into a caller repository is prose no
		// later migration can revise, since the caller is free to edit it.
		const branches = branchesLine(
			branchNames(pullRequest),
			childIndent(src, pullRequest),
		);
		const text = `${lead}${indent}push:\n${branches}`;

		return {
			status: 'applied',
			edits: [{ start: insertAt, end: insertAt, text }],
		};
	},

	verify(doc) {
		const triggers = doc.get('on');
		if (!isMap(triggers) || !triggers.has('push')) {
			return 'the push trigger is missing';
		}
	},
} satisfies Migration;

/**
 * An existing push trigger only does the job if it actually fires on a push to
 * the branches the caller tests. GitHub fires `push` on a branch when there is no
 * `branches`/`tags` filter at all, or when a `branches` pattern matches — a
 * `tags` filter on its own means tag pushes only, and `branches-ignore` cannot be
 * combined with `branches`.
 */
function reconcile(
	src: string,
	existing: SourcePair,
	pullRequest: SourcePair,
): UnitResult {
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
		return { status: 'applied', edits: [addBranches(src, filters, wanted)] };
	}

	const declared = isCollection(branches.value)
		? branches.value.items.map((item) => String(item))
		: [];
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

function branchNames(pullRequest: SourcePair): string[] {
	const branches = pairFor(pullRequest.value, 'branches');
	return branches != null && isCollection(branches.value)
		? branches.value.items.map((item) => String(item))
		: ['main', 'master'];
}

/** Give an existing push trigger a branch filter, leaving its tag filter alone. */
function addBranches(
	src: string,
	filters: YAMLMap.Parsed,
	wanted: string[],
): Edit {
	const last = filters.items[filters.items.length - 1];
	const [, end] = pairRange(src, last);
	return {
		start: end,
		end,
		text: branchesLine(wanted, indentAt(src, last.key.range[0])),
	};
}

/** One line, no padding: the shape callers write the list in by hand. */
const FLOW_LIST = {
	collectionStyle: 'flow',
	flowCollectionPadding: false,
	lineWidth: 0,
} as const;

/**
 * The `branches:` line for a trigger. Composed from the parsed names rather than
 * copied out of the caller's own lines: copied source brings their comments with
 * it, and a comment about `pull_request` repeated under `push:` may not even be
 * true there. yaml renders the list, so a pattern such as `*` is quoted the way
 * YAML needs rather than the way a regex here guesses.
 */
function branchesLine(names: string[], indent: string): string {
	return `${indent}branches: ${stringify(names, FLOW_LIST)}`;
}

/**
 * The indentation for a line inside a trigger's block. Some callers indent by two
 * spaces and some by four, so measure the block's first line rather than assume.
 * A flow-style trigger has no line to measure, so fall back to two.
 */
function childIndent(src: string, trigger: SourcePair): string {
	const first = isBlockMap(trigger.value) ? trigger.value.items[0] : undefined;
	return first
		? indentAt(src, first.key.range[0])
		: `${indentAt(src, trigger.key.range[0])}  `;
}
