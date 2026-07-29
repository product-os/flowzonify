import { callerJobs, callerInput, inputRemoval, jobPassingInput } from '../context.js';
import { pairRange } from '../source.js';

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

			const removal = inputRemoval(found);
			if (removal.blocked) {
				return {
					status: 'blocked',
					note: `job \`${name}\` writes \`with:\` in flow style, so ${INPUT} cannot be removed from it safely. Migrate this workflow by hand.`,
				};
			}

			const [start, end] = pairRange(src, removal.target);
			edits.push({ start, end, text: '' });
		}

		return edits.length > 0 ? { status: 'applied', edits } : { status: 'skip' };
	},

	verify(doc) {
		const job = jobPassingInput(doc, INPUT);
		return job && `job \`${job}\` still passes ${INPUT}`;
	},
};
