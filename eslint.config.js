import balenaLint from '@balena/lint/config/eslint.config.js';

export default [
	...balenaLint,
	{
		// Type-aware rules only run on files the TypeScript project includes.
		// tsconfig.json lists the compiled sources; tsconfig.dev.json adds
		// eslint.config.js to them.
		languageOptions: { parserOptions: { project: './tsconfig.dev.json' } },
	},
	{
		// node:test's test() returns a promise the runner itself awaits, and
		// `() => assert...` arrow shorthands are idiomatic in tests.
		files: ['test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-floating-promises': 'off',
			'@typescript-eslint/no-confusing-void-expression': 'off',
		},
	},
];
