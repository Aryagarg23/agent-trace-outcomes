# CI integration: automatic capture and merge gates

## Automatic capture with the GitHub Action

On every merged PR, the [action](../action.yml) gathers the PR's check runs from the Checks API, derives the verdict, records approvers as `reviewed_by`, uses the PR title as `intent.summary`, and commits the record to `.agent-trace/outcomes/`:

```yaml
# .github/workflows/outcomes.yml
name: outcomes
on:
  pull_request:
    types: [closed]
permissions:
  contents: write
  checks: read
  pull-requests: read
jobs:
  record:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.ref }}
      - uses: Aryagarg23/agent-trace-outcomes@v0
```

Set `with: { storage: notes }` to write git notes (`refs/notes/agent-trace/outcomes`) instead of files — history-clean, but remember notes are only shared explicitly (`git push origin 'refs/notes/*'`, `git fetch origin 'refs/notes/*:refs/notes/*'`).

Two SHA subtleties the action handles for you: check runs attach to the **PR head** commit, while the record should attach to the **merge commit** that actually landed (`--from-checks <head> --revision <merge>`); and on `pull_request` events `GITHUB_SHA` is neither of those.

## Recording from inside a workflow (no Action)

After your test step, one always-running step:

```yaml
- id: test
  run: npm test
- if: always()
  run: npx -y agent-trace-outcomes record --from-ci --status "${{ steps.test.outcome }}" --intent "${{ github.event.head_commit.message }}"
```

`--from-ci` reads `GITHUB_SHA` for the revision and links `detail_url` to the run.

## Using the verdict as a merge gate

`atrace-outcomes verdict <sha>` exits 0 iff the newest outcome record for the commit is `verified`, so it composes directly into scripts and required checks:

```yaml
# require a verified outcome before deploying
- run: npx -y agent-trace-outcomes verdict "$GITHUB_SHA"
```

```sh
# local pre-push gate (.husky/pre-push)
npx atrace-outcomes verdict "$(git rev-parse HEAD)" || { echo "HEAD is not verified"; exit 1; }
```

Populate checks retroactively for any commit from the Checks API:

```sh
GITHUB_TOKEN=$TOKEN npx -y agent-trace-outcomes record --from-checks <sha>
```
