// The rules balena-lint applies, so an editor's ESLint integration resolves the same
// parser and rules the CLI does. balena-lint passes this config to ESLint as
// `baseConfig` itself; an editor only performs the ordinary project lookup, and
// without the parser here it falls back to JavaScript and reports every type
// annotation in the repository as a syntax error.
import balenaLint from '@balena/lint/config/eslint.config.js';

export default [
	// balena-lint lints ts and tsx only. Its config applies `parserOptions.project`
	// unscoped, though, so any JavaScript file an editor opens — this one included — gets
	// parsed against a tsconfig that does not include it. Holding the linted surface to
	// TypeScript is what the CLI already does.
	{ ignores: ['**/*.js', '**/*.mjs', '**/*.cjs'] },
	...balenaLint,
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
