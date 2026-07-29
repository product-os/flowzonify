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
`lib/migrations/index.js`. Nothing else in the tool changes — unless it needs a repository fact
nobody has needed yet, which is one more probe in `repoContext` (`lib/run.js`).

```js
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
};
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
  `pairRange` from `lib/source.js` to get a pair's source range, comments included, and let
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

No test dependencies — `node:test` and `node:assert` only. Alongside the per-migration tests,
`test/corpus/` pairs whole caller workflows with their expected output. Each fixture is named for
the structural variant it pins down, distilled from the shapes callers actually have in the wild:
flow *and* block sequence branch lists, four-space `permissions:` blocks, both spellings of the
routing condition, a renamed caller job, a `with:` whose only input is being removed, and a
workflow that is not valid YAML at all. Those are the variants a canonical template never exercises,
and they are where a naive transform breaks.

Add a fixture by dropping the input in `test/corpus/input/` and its migrated form in
`test/corpus/expected/`; a fixture with no expected file is asserted to be one the tool refuses.

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
  | node scripts/sweep.js
```

The query gathers repository context as well as the workflow, because a migration
given no context skips rather than guesses — omit `isNpmPackage` or `customActions`
and the sweep quietly under-reports what the tool would really do.
