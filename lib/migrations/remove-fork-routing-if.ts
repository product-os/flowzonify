import { z } from 'zod';

import { callerJobs } from '../context.ts';
import { pairRange } from '../source.ts';
import { field } from '../schema.ts';
import type { Migration } from '../migrate.ts';

/**
 * The routing conditions callers actually wrote, once whitespace is removed. The
 * first covers every occurrence in the fleet, spelled across six lines or two;
 * the second is the compact equality used elsewhere in the org.
 *
 * Both filter a fork `pull_request` out — the long one because neither clause
 * matches, the compact one because `false == true` is false — which is exactly
 * what has to stop. Anything else that mentions the event is caller-authored and
 * gets a human.
 */
const CANONICAL_ROUTING: readonly string[] = [
	"(github.event.pull_request.head.repo.full_name==github.repository&&github.event_name=='pull_request')||" +
		"(github.event.pull_request.head.repo.full_name!=github.repository&&github.event_name=='pull_request_target')",
	"(github.event.pull_request.head.repo.full_name==github.repository)==(github.event_name=='pull_request')",
];

export default {
	id: 'remove-fork-routing-if',
	description:
		'Remove the condition that routed fork pull requests to pull_request_target; it now filters fork PRs out entirely.',

	apply(src, doc) {
		const edits = [];

		for (const { name, node } of callerJobs(doc)) {
			const condition = field(node, 'if', z.string());
			if (condition.pair == null) {
				continue;
			}

			const normalised = (condition.value ?? '').replace(/\s+/g, '');

			// The compact spelling never names pull_request_target, so recognising the
			// known conditions has to come before asking whether this one mentions it.
			if (!CANONICAL_ROUTING.includes(normalised)) {
				if (!normalised.includes('pull_request_target')) {
					continue;
				}
				return {
					status: 'blocked',
					note: `job \`${name}\` has a customised \`if:\` that references pull_request_target. Removing the trigger without it would filter out fork pull requests entirely, so migrate this workflow by hand.`,
				};
			}

			const [start, end] = pairRange(src, condition.pair);
			edits.push({ start, end, text: '' });
		}

		return edits.length > 0 ? { status: 'applied', edits } : { status: 'skip' };
	},

	verify(doc) {
		for (const { name, node } of callerJobs(doc)) {
			const condition = field(node, 'if', z.string()).value ?? '';
			// Not just a mention of the event: the compact spelling routes forks away
			// without ever naming it.
			if (
				CANONICAL_ROUTING.includes(condition.replace(/\s+/g, '')) ||
				condition.includes('pull_request_target')
			) {
				return `job \`${name}\` still routes fork pull requests away from the pull_request lane`;
			}
		}
	},
} satisfies Migration;
