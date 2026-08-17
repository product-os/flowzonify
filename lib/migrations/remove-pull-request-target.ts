import { isMap } from 'yaml';

import { isBlockMap, pairFor, pairRange } from '../source.ts';
import { field, triggerNames, Triggers } from '../schema.ts';
import type { Migration } from '../migrate.ts';

export default {
	id: 'remove-pull-request-target',
	removesTriggers: ['pull_request_target'],
	description:
		'Remove the pull_request_target trigger; flowzone rejects the event and fork PRs now run on pull_request.',

	apply(src, doc) {
		const on = field(doc.contents, 'on', Triggers);
		const triggers = on.pair?.value;

		// Membership rather than a substring search over the stringified node, which
		// would also match the event's name appearing inside somebody's filter list.
		if (!isBlockMap(triggers)) {
			return triggerNames(on.value).includes('pull_request_target')
				? {
						status: 'blocked',
						note: '`on:` is not a block mapping, so the pull_request_target trigger cannot be removed safely. Migrate this workflow by hand.',
					}
				: { status: 'skip' };
		}

		const target = pairFor(triggers, 'pull_request_target');
		if (!target) {
			return { status: 'skip' };
		}

		if (!triggers.has('pull_request')) {
			return {
				status: 'blocked',
				note: 'pull_request_target is the only pull request trigger; removing it would leave the repository with no pull request CI. Add a `pull_request` trigger first.',
			};
		}

		const [start, end] = pairRange(src, target);
		return { status: 'applied', edits: [{ start, end, text: '' }] };
	},

	verify(doc) {
		const triggers = doc.get('on');
		if (isMap(triggers) && triggers.has('pull_request_target')) {
			return 'the pull_request_target trigger is still declared';
		}
	},
} satisfies Migration;
