import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decide } from '../../action/outcome.ts';
import type { OutcomeInput } from '../../action/outcome.ts';

/** The inputs of a run that migrated and opened a pull request, unless overridden. */
function input(overrides: Partial<OutcomeInput> = {}): OutcomeInput {
	return {
		status: 'migrated',
		cpr: {
			outcome: 'success',
			operation: 'created',
			prNumber: '12',
			url: 'https://github.com/product-os/example/pull/12',
		},
		onBlocked: 'warn',
		onFailure: 'warn',
		...overrides,
	};
}

test('a run that opened a pull request reports it and does not fail', () => {
	const decision = decide(input());

	assert.equal(decision.failed, false);
	assert.deepEqual(decision.messages, []);
	assert.equal(decision.outputs.status, 'migrated');
	assert.equal(decision.outputs['pull-request-number'], '12');
	assert.equal(decision.outputs['pull-request-operation'], 'created');
	assert.match(decision.summary, /pull\/12/);
});

test('a run that found nothing to do says so and does not fail', () => {
	const decision = decide(
		input({ status: 'unchanged', cpr: { outcome: 'skipped' } }),
	);

	assert.equal(decision.failed, false);
	assert.deepEqual(decision.messages, []);
	assert.equal(decision.outputs.status, 'unchanged');
});

test('a run the gate declined is completely silent', () => {
	// The whole point of the inert default: when the caller has no token that can write
	// workflows, this must not warn in every repository on every push.
	const decision = decide(
		input({ status: 'skipped', cpr: { outcome: 'skipped' } }),
	);

	assert.equal(decision.failed, false);
	assert.deepEqual(decision.messages, []);
	assert.equal(decision.outputs.status, 'skipped');
});

const BLOCKED = {
	status: 'blocked' as const,
	cpr: { outcome: 'skipped' as const },
	blocked: [
		{ id: 'remove-fork-routing-if', note: 'the condition was customised' },
	],
};

test('a blocked workflow fails the job when asked to', () => {
	const decision = decide(input({ ...BLOCKED, onBlocked: 'fail' }));

	assert.equal(decision.failed, true);
	assert.equal(decision.outputs.status, 'blocked');
	assert.match(decision.messages.join('\n'), /the condition was customised/);
});

test('a blocked workflow warns without failing by default', () => {
	// Both directions matter: warn has to stay green *and* still say something, or a
	// repository that needs a hand-edit goes unnoticed.
	const decision = decide(input({ ...BLOCKED, onBlocked: 'warn' }));

	assert.equal(decision.failed, false);
	assert.match(decision.messages.join('\n'), /remove-fork-routing-if/);
});

test('a blocked workflow can be silenced entirely', () => {
	const decision = decide(input({ ...BLOCKED, onBlocked: 'skip' }));

	assert.equal(decision.failed, false);
	assert.deepEqual(decision.messages, []);
	// The status still tells the truth; the mode only chooses how loudly to say it.
	assert.equal(decision.outputs.status, 'blocked');
});

const REFUSED = {
	status: 'migrated' as const,
	cpr: { outcome: 'failure' as const },
};

test('a refused push fails the job when asked to', () => {
	const decision = decide(input({ ...REFUSED, onFailure: 'fail' }));

	assert.equal(decision.failed, true);
	assert.equal(decision.outputs.status, 'refused');
});

test('a refused push warns without failing by default', () => {
	const decision = decide(input({ ...REFUSED, onFailure: 'warn' }));

	assert.equal(decision.failed, false);
	assert.notEqual(decision.messages.length, 0);
});

test('a refused push can be silenced entirely', () => {
	const decision = decide(input({ ...REFUSED, onFailure: 'skip' }));

	assert.equal(decision.failed, false);
	assert.deepEqual(decision.messages, []);
	assert.equal(decision.outputs.status, 'refused');
});

test('a refused push names the likely cause and where to find the real one', () => {
	// The action cannot tell why the push failed — no API reports an installation
	// token's own permissions, and create-pull-request's error reaches us as a boolean.
	// So it must say what it suspects and point at the step that knows.
	const decision = decide(input({ ...REFUSED, onFailure: 'warn' }));
	const said = decision.messages.join('\n');

	assert.match(said, /workflows/);
	assert.match(said, /create-pull-request/);
});

test('the blocked and failure dials are independent', () => {
	// A blocked workflow needs a human; a refused push needs a permission. Silencing
	// one must not silence the other.
	const decision = decide(
		input({ ...BLOCKED, onBlocked: 'skip', onFailure: 'fail' }),
	);

	assert.equal(decision.failed, false);
	assert.deepEqual(decision.messages, []);
});
