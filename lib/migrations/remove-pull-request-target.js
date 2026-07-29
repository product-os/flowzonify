import { isMap } from 'yaml';

import { isBlockMap, pairFor, pairRange } from '../source.js';

export default {
	id: 'remove-pull-request-target',
	removesTriggers: ['pull_request_target'],
	description:
		'Remove the pull_request_target trigger; flowzone rejects the event and fork PRs now run on pull_request.',

	apply(src, doc) {
		const triggers = doc.get('on');

		if (!isBlockMap(triggers)) {
			return String(triggers).includes('pull_request_target')
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
};
