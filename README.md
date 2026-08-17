# flowzonify

A CLI utility that migrates [flowzone](https://github.com/product-os/flowzone) caller workflows.

Flowzone's configuration changes over time, and every change has to reach ~100 caller repositories.
Flowzonify applies those changes to `.github/workflows/flowzone.yml` as a **comment-preserving,
idempotent** transform. It edits only the lines a migration actually touches — everything else comes
through byte for byte, so the resulting pull request is small enough to review at a glance.

It does not touch git. Committing, branching, and opening pull requests are somebody else's job.

## Usage

```sh
npx product-os/flowzonify   # migrate in place
git diff                    # review it; git checkout -- . to undo
```

It edits the workflow in place and leaves reviewing to git, which renders the
change better than the tool could and undoes it in one command.

```text
flowzonify [migrate] [path...]   migrate workflows in place (default: .github/workflows/flowzone.yml)
flowzonify init                  create a flowzone caller workflow in a new repository

Options:
  --json           print a machine-readable report instead of prose
  --list           list the available migrations and exit
  --only <id,...>  run only the named migrations
  --type <type>    (init) repo.yml type for a repository versionist cannot infer
  --help           show this message
```

| Exit code | Meaning |
| --- | --- |
| `0` | migrated, already up to date, or skipped |
| `1` | a workflow could not be parsed or failed validation |
| `2` | a workflow needs to be migrated by hand |

Nothing is written unless the migrated workflow re-parses, passes validation, and introduces no
actionlint diagnostic the file did not already have. A workflow that fails any of those is reported
and left exactly as it was — a half-migrated workflow is worse than an old one.

Validation includes a check that no filter ends up on a trigger GitHub does not allow it on, since
a mis-spliced filter list produces valid YAML that parses and validates and only a schema check
notices. That runs always. `actionlint` covers far more, but only when it is installed, so the CLI
says when it could not run rather than quietly downgrading the checks.

`init` also declares the repository type. Without a `repo.yml`, balena-versionist falls back to the
node strategy and needs a `package.json` to anchor the version, so a repository with neither would be
versioned by the wrong strategy — `init` refuses it and asks for `--type`, writing the answer to
`repo.yml`. Repositories with a `package.json` need nothing, since versionist's default is already
right for them, and an existing `repo.yml` is never touched.

## GitHub Action

The same migrations, run by flowzone against the repository calling it, opening the pull
request the CLI deliberately leaves to somebody else. Branch management, rebasing, commit
creation and the pull request itself are
[create-pull-request](https://github.com/peter-evans/create-pull-request); this action is the
glue that decides whether to act and turns the `--json` report into something worth reading.

```yaml
  flowzonify:
    name: Flowzonify
    # A job of its own: this action checks the base branch out into the workspace, so
    # sharing a job with steps that expect a different ref would rewrite their tree.
    if: |
      (github.event_name == 'push' && github.ref == format('refs/heads/{0}', github.event.repository.default_branch))
      || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository)
    concurrency:
      group: flowzonify-${{ github.repository }}
      cancel-in-progress: true
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/create-github-app-token@v3
        id: token
        # The `workflows` permission is meant to be withdrawn once most repositories
        # have been migrated. Soft-failing here means that withdrawal is a no-op.
        continue-on-error: true
        with:
          app-id: ${{ secrets.APP_ID }}
          private-key: ${{ secrets.APP_PRIVATE_KEY }}
          permission-contents: write
          permission-pull-requests: write
          permission-workflows: write
      - uses: product-os/flowzonify@v0.4.0
        with:
          token: ${{ steps.token.outputs.token }}
```

`workflows` is not one of `GITHUB_TOKEN`'s permissions — the key does not exist — so the
default token can never change a file under `.github/workflows/`. Given it, or given the empty
string a soft-failed token mint produces, this action **skips silently**. That is the point:
withdrawing the permission later must not light up a warning in every caller repository.

| Input | Default | What it is |
| --- | --- | --- |
| `token` | `${{ github.token }}` | A token that can write `contents`, `pull-requests` and `workflows`. Anything less and the action does nothing. |
| `branch` | `flowzone/migrate-config` | The branch the migration lives on. |
| `base` | the default branch | The branch to migrate from, and the pull request's base. |
| `only` | | Run only the named migrations, comma separated. |
| `labels` | | Labels for the pull request. |
| `dry-run` | `false` | Report the diff in the step summary and open nothing. |
| `on-blocked` | `warn` | `fail`, `warn` or `skip`, when a workflow needs migrating by hand. |
| `on-failure` | `warn` | `fail`, `warn` or `skip`, when create-pull-request fails. |
| `commit-message` | `Migrate the flowzone caller workflow` | The commit subject, and the pull request title. |

Outputs are `status`, `pull-request-number`, `pull-request-url` and
`pull-request-operation`. `status` is one of `migrated`, `unchanged`, `blocked`, `refused`, or
`skipped` when the action decided not to act — always the truth, since the `on-*` inputs
choose how loudly an outcome is reported, never what it was.

There is no input for the `flowzonify` version, and the action does not install one from the
registry. It runs the CLI sitting beside it in its own checkout, so the code that migrates the
workflow and the code that describes the migration in the commit message are always the same
release. Referencing the action by a commit sha — flowzone's convention — would otherwise run
whatever was last *published*, which at a post-release sha is older than the source at that
sha, and a pull request could end up describing migrations other than the ones in its diff.

The cost is one `npm ci --omit=dev --ignore-scripts` in the action's own directory, since the
runner checks an action out without installing anything. That also means the caller's `.npmrc`
is never read, only this repository's.

The versionist footer is not an input either. A caller that passes
`disable_versioning: true` gets no footer at all, since both footers are versionist's and one
nothing reads says something untrue about the commit. Otherwise the footer is chosen from
`repo.yml`: a `yocto-based OS image` repository gets `Changelog-entry:`, since that is what its
versionist strategy reads, and everything else gets `Change-type: patch`. A repository with no
`repo.yml` also gets `Change-type:`, matching versionist's own fallback to the node strategy.

Anything short of a definite `disable_versioning: true` keeps the footer — a value only known
at run time, say. That is the safe direction: a footer versionist never reads is inert, while a
missing one fails the caller's own versioning job.

The action cannot tell you *why* create-pull-request failed. No API reports an installation
token's own permissions, and the step outcome reaches us as a boolean, so a refusal names the
likeliest cause — a token without `workflows` — and points at the create-pull-request step log
for the real error. Requesting the permission when the token is minted is what turns that into
a precise, one-time failure instead.

## Migrations

Run `flowzonify --list` for the current set.

| id | What it does |
| --- | --- |
| `remove-pull-request-target` | Removes the `pull_request_target` trigger. Flowzone rejects the event; fork PRs run on `pull_request` with no secrets. |
| `remove-fork-routing-if` | Removes the `if:` that routed fork PRs to `pull_request_target`. Left in place it would filter fork PRs out entirely. |
| `add-push-trigger` | Adds the `push:` trigger, mirroring the caller's own `pull_request` branch list, where fork contributions are rebuilt and published after merge. |
| `remove-restrict-custom-actions` | Removes the deprecated `restrict_custom_actions` input. |
| `add-npm-oidc-permissions` | Grants npm packages the `id-token: write` permission that [trusted publishing](https://docs.npmjs.com/trusted-publishers) needs. |
| `migrate-custom-runs-on` | Moves the deprecated `custom_runs_on` input onto the `os` property of the matrix of each custom job the repository defines, so flowzone can drop the input. |

Each migration decides for itself whether it has anything to do, so running flowzonify on a
partially migrated workflow converges rather than double-applying.

## Writing a migration

A migration is a plain object in `lib/migrations/`, added to the ordered registry in
`lib/migrations/index.ts`. Nothing else in the tool changes — unless it needs a repository fact
nobody has needed yet, which is one more probe in `repoContext` (`lib/run.ts`).

```ts
import type { Migration } from '../migrate.ts';

export default {
  id: 'remove-something',
  description: 'One line, shown by --list and in pull request bodies.',

  apply(src, doc, context) {
    // `doc` is a parsed yaml Document; `src` is the original text.
    // Return edits as source ranges rather than re-serialising the document.
    return { status: 'applied', edits: [{ start, end, text: '' }] };
  },

  // Optional: what must be true once this migration has run.
  verify(doc) {
    return problem ? 'what went wrong' : undefined;
  },
} satisfies Migration;
```

`apply` returns one of four verdicts:

| Status | Meaning |
| --- | --- |
| `skip` | Nothing to do, or already applied. |
| `applied` | Edits to splice into the source. |
| `advisory` | The migration applied, but something about it needs saying. Edits are still spliced and the workflow is still written; the `note` is surfaced to whoever reviews it. |
| `blocked` | Migrating would be wrong or incomplete. Include a `note`; **nothing** is written. |

Three rules make the whole thing work:

- **Emit edits, never a re-serialised document.** Round-tripping a `yaml` Document reformats lines
  the migration never touched — flow sequences gain padding, four-space blocks get reindented. Use
  `pairRange` from `lib/source.ts` to get a pair's source range, comments included, and let
  `applyEdits` splice it.
- **Find caller jobs with `callerJobs`, not by name.** Job names are caller-chosen, and flowzone's
  own workflow file mentions its full path in step scripts. Only the `uses:` key tells them apart.
- **Skip when you lack context, don't guess.** `context` carries a few facts about the surrounding
  repository — `isNpmPackage`, and `customActions` for the directories under `.github/actions`,
  which is how flowzone itself decides which custom jobs exist. A migration called without the
  context it needs must skip rather than assume.

The runner reparses between migrations, so each one sees the previous one's output and edits can
never overlap.

## Tests

```sh
npm test
```

No test dependencies — `node:test` and `node:assert` only, running the TypeScript sources directly
through Node's own type stripping (node ≥ 22.18). Alongside the per-migration tests,
`test/fixtures/` pairs whole caller workflows with their expected output. Each fixture is named for
the structural variant it pins down, distilled from the shapes callers actually have in the wild:
flow *and* block sequence branch lists, four-space `permissions:` blocks, both spellings of the
routing condition, a renamed caller job, a `with:` whose only input is being removed, and a
workflow that is not valid YAML at all. Those are the variants a canonical template never exercises,
and they are where a naive transform breaks.

Add a fixture by dropping the input in `test/fixtures/input/` and its migrated form in
`test/fixtures/expected/`; a fixture with no expected file is asserted to be one the tool refuses.

To dry-run the whole fleet without touching any repository:

```sh
gh api graphql --paginate -F org=product-os -f query='
  query($org: String!, $endCursor: String) {
    organization(login: $org) {
      repositories(first: 100, after: $endCursor, isArchived: false) {
        pageInfo { hasNextPage endCursor }
        nodes {
          name
          object(expression: "HEAD:.github/workflows/flowzone.yml") { ... on Blob { text } }
          actions: object(expression: "HEAD:.github/actions") { ... on Tree { entries { name type } } }
          packageJson: object(expression: "HEAD:package.json") { ... on Blob { text } }
        }
      }
    }
  }' --jq '.data.organization.repositories.nodes[]
           | select(.object != null)
           | {
               name: .name,
               text: .object.text,
               customActions: [(.actions.entries // [])[] | select(.type == "tree") | .name],
               isNpmPackage: (try ((.packageJson.text // "null") | fromjson | . != null and (.private != true)) catch false)
             }' \
  | node scripts/sweep.ts
```

The query gathers repository context as well as the workflow, because a migration
given no context skips rather than guesses — omit `isNpmPackage` or `customActions`
and the sweep quietly under-reports what the tool would really do.
