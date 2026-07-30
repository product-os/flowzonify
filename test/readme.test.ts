import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { MIGRATIONS } from '../lib/migrations/index.ts';

const README = readFileSync(
	fileURLToPath(new URL('../README.md', import.meta.url)),
	'utf8',
);

const MIGRATIONS_SECTION =
	README.split('\n## Migrations\n')[1]?.split('\n## ')[0] ?? '';

const documented = MIGRATIONS_SECTION.split('\n')
	.map((line) => line.match(/^\| `([a-z0-9-]+)` \|/)?.[1])
	.filter((id) => id != null);

test('the migrations section of the README was found', () => {
	assert.ok(
		documented.length > 0,
		'no migration table rows found — has the README been restructured?',
	);
});

test('the README documents every registered migration', () => {
	for (const unit of MIGRATIONS) {
		assert.ok(
			documented.includes(unit.id),
			`\`${unit.id}\` is registered but missing from the README migrations table`,
		);
	}
});

test('the README does not document a migration that no longer exists', () => {
	const registered = MIGRATIONS.map((unit) => unit.id);
	for (const id of documented) {
		assert.ok(
			registered.includes(id),
			`\`${id}\` is in the README migrations table but is not registered`,
		);
	}
});
