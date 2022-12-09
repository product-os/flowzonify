# flowzonify

A CLI utility to not only set up repositories to use [Flowzone](https://github.com/product-os/flowzone) for CI,
but also keep existing Flowzone configurations up-to-date.

Note: This tool currently only works for Node projects. This tool also assumes `git` is locally installed
and the executing user has access to the repositories through `git`.

## Environment Variables
The following environment variables are used/required:
- `REPOS`: A comma-separated list of GitHub repositories to target
	- Example: `product-os/foobar,balena-io/open-balena-api`
	- Required. No default value.
- `PERSONAL_ACCESS_TOKEN`: GitHub personal access token used to create pull requests
	- Example: `github_pat_xxxxx`
	- Required. No default.
- `WORKSPACE`: Path to a local directory to clone repositories to
	- Example: `/home/user/workspace`
	- Not required. Default: `/tmp`.
