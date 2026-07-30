import {
	callerJobs,
	callerInput,
	inputRemoval,
	jobPassingInput,
} from '../context.ts';
import { pairRange } from '../source.ts';
import type { Migration } from '../migrate.ts';

const INPUT = 'restrict_custom_actions';

export default {
	id: 'remove-restrict-custom-actions',
	description: `Remove the deprecated ${INPUT} input; fork pull requests run without secrets, so flowzone ignores it.`,

	apply(src, doc) {
		const edits = [];

		for (const { name, node } of callerJobs(doc)) {
			const found = callerInput(node, INPUT);
			if (!found) {
				continue;
			}

			const target = inputRemoval(found);
			if (target == null) {
				return {
					status: 'blocked',
					note: `job \`${name}\` writes \`with:\` in flow style, so ${INPUT} cannot be removed from it safely. Migrate this workflow by hand.`,
				};
			}

			const [start, end] = pairRange(src, target);
			edits.push({ start, end, text: '' });
		}

		return edits.length > 0 ? { status: 'applied', edits } : { status: 'skip' };
	},

	verify(doc) {
		const job = jobPassingInput(doc, INPUT);
		return job && `job \`${job}\` still passes ${INPUT}`;
	},
} satisfies Migration;
