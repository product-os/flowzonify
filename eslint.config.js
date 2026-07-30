export default [
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
