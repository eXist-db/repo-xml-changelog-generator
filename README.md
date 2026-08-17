# @existdb/repo-xml-changelog-generator

A [semantic-release](https://github.com/semantic-release/semantic-release) plugin that injects a new `<change>` entry into an [EXPath package descriptor](https://expath.org/spec/pkg) (typically `repo.xml.tmpl` for eXist-db XAR packages) based on the Conventional Commits between the previous release tag and the current release.

## What problem this solves

eXist-db apps and libraries that already use [semantic-release](https://github.com/semantic-release/semantic-release) for automated tagging and GitHub Releases still need to keep the in-XAR EXPath `<change>` history up to date. Previously, every adopter (monex, function-documentation, semver.xq) maintained its own copy of an `update-repo-changelog.js` script invoked via `@semantic-release/exec`. This plugin productizes that script into a single, configurable semantic-release plugin so the script doesn't need to be copy-pasted into every repo.

## Install

```bash
npm install --save-dev @existdb/repo-xml-changelog-generator
```

## Usage

Add to your `.releaserc` plugin chain. Place it after the commit-analyzer / release-notes-generator (so `lastRelease` and `nextRelease` are populated) and before any plugin that builds the XAR (so the injected change is included in the built artifact):

```jsonc
{
  "branches": ["master"],
  "plugins": [
    ["@semantic-release/commit-analyzer",        { "preset": "conventionalcommits" }],
    ["@semantic-release/release-notes-generator", { "preset": "conventionalcommits" }],

    // 1) bump the version in-memory on the CI runner
    ["@semantic-release/exec", {
      "prepareCmd": "npm version ${nextRelease.version} --no-git-tag-version --allow-same-version"
    }],

    // 2) inject the <change> entry into repo.xml.tmpl
    "@existdb/repo-xml-changelog-generator",

    // 3) build the XAR (now sees both the bumped version + the injected <change>)
    ["@semantic-release/exec", { "publishCmd": "npm run build" }],

    // 4) tag + GitHub Release + asset upload via REST
    ["@semantic-release/github", {
      "assets": [{ "path": "dist/*.xar", "label": "EXPath Package (XAR)" }]
    }]
  ]
}
```

**Do not** include `@semantic-release/git` in the plugin chain. The mutation this plugin performs is in-memory on the CI runner; the on-disk `repo.xml.tmpl` in your default branch stays at its development-placeholder state, and the per-release changelog history lives in git tags + GitHub Releases. See [Design rationale](#design-rationale) below.

## Configuration

| Option | Type | Default | Notes |
|--------|------|---------|-------|
| `tmplPath` | string | `'repo.xml.tmpl'` | Path to the EXPath repo descriptor template, relative to `cwd`. |

```jsonc
["@existdb/repo-xml-changelog-generator", { "tmplPath": "src/repo.xml.tmpl" }]
```

## What it does

### `verifyConditions` (runs early, before any release work)

- Confirms `tmplPath` exists.
- Confirms the descriptor contains a `<changelog xmlns="http://exist-db.org/xquery/repo">` element.

If either check fails, semantic-release aborts before doing anything. This is the right place to surface configuration mistakes, not the middle of a release.

### `prepare` (runs after version is computed)

For each conventional commit since `context.lastRelease.gitTag`:

- Skip non-typed commits (those that don't match the Conventional Commits grammar).
- Group by type using `conventional-changelog-conventionalcommits`.
- Render each commit as `Prefix: scope: subject` where Prefix is one of:
  - `New` (for `feat:`)
  - `Fix` (for `fix:`)
  - `Improvement` (for `perf:`)
  - `Revert` (for `revert:`)
  - or the literal type for other categories.
- Render breaking changes as `Breaking change: <text>` from `BREAKING CHANGE:` footers.
- Render issue/PR references (e.g. `#398`) as XHTML `<a>` links, with URLs derived from semantic-release's `repositoryUrl`; on non-GitHub remotes they are kept as plain text.
- Hard-wrapped commit subjects are folded into a single line, and hard-wrapped `BREAKING CHANGE:` footers are collapsed to single-line items.

The rendered items are wrapped in a `<change version="X.Y.Z"><ul xmlns="http://www.w3.org/1999/xhtml">…</ul></change>` and inserted at the **top** of the existing `<changelog>` element (most recent first).

### Edge cases

| Situation | Behavior |
|-----------|----------|
| No `lastRelease.gitTag` (first release) | Skip injection. Log a note. Curate the initial `<change>` entry manually in the template. |
| No conventional commits since last tag | Skip injection. Log "no notable commits". |
| Configured `tmplPath` doesn't exist | `verifyConditions` aborts the release with a clear error. |
| `<changelog>` element missing | `verifyConditions` aborts with instructions to add an empty `<changelog/>`. |
| `lastRelease.gitTag` is e.g. `1.2.3` but the actual tag is `v1.2.3` | Both forms are tried; the first one that resolves wins. |

## Design rationale

### Why in-memory, not push-back?

The default approach for many semantic-release setups is to use `@semantic-release/git` to commit the mutated files (`package.json`, `CHANGELOG.md`, etc.) back to the default branch. For eXist-db org repos with branch protection that requires PRs, this means the GitHub Actions token can't push the release commit — you need a PAT or a GitHub App to bypass protection. That's operational overhead (PAT rotation, App installation per repo, secret management).

The alternative — used by `@existdb/xst`, `@existdb/node-exist`, `@existdb/gulp-exist`, and (since 2026-05-19) `eXist-db/monex` and `eXist-db/function-documentation` — is to **pin the default-branch version to `0.0.0-development` permanently**, do all the version + changelog work in-memory on the CI runner, and let the built XAR carry the real version. No push-back, no token plumbing, branch protection works as intended.

This plugin is designed for that workflow. (It would also work alongside `@semantic-release/git`, but the apps in the org don't need that path.)

### Why not just publish the existing script as-is?

Because every adopter would still have to copy it into their repo and invoke it via `@semantic-release/exec` prepareCmd. The plugin form:

- Hooks into semantic-release's lifecycle directly (gets `lastRelease`, `nextRelease`, `logger`, `cwd` natively).
- Adds proper `verifyConditions` so misconfiguration is caught early.
- Lets adopters install it as an npm dependency instead of vendoring a 170-line script.
- Centralizes future improvements (e.g. cross-link PRs/issues, support `expath-pkg.xml.tmpl` version sync, support custom commit-type → prefix mappings).

### Why a Node plugin, not an XQuery one?

semantic-release itself is a Node tool and runs in Node. The plugin API is Node-native. Reimplementing in XQuery would mean either (a) standing up a separate XQuery runtime in CI just to run the changelog hook, or (b) calling out to it via HTTP/shell. Both add complexity for no user-visible benefit. The plugin's output (the `<change>` element it emits) is the data that lives in the XQuery world — the producer can be in any language.

## Releasing this package

This plugin releases itself with semantic-release, eating its own dog food. Merges to `main` run the [CI workflow](.github/workflows/release.yml): the test matrix runs, then `semantic-release` analyzes the Conventional Commits, computes the next version, publishes to npm (`@existdb` scope), and creates the GitHub Release. The in-tree `version` stays pinned at `0.0.0-development`; the real version is set in-memory at release time (the same no-push pattern this plugin advocates for adopters).

Commit messages are linted against [Conventional Commits](https://www.conventionalcommits.org/) via commitlint — locally through a husky `commit-msg` hook, and in CI on every pull request.

## Acknowledgements

- The core changelog logic was originally written for [eXist-db/semver.xq#69](https://github.com/eXist-db/semver.xq/pull/69) and adopted in [eXist-db/monex](https://github.com/eXist-db/monex) and [eXist-db/function-documentation](https://github.com/eXist-db/function-documentation). This plugin is a refactor of that proven logic.
- @line-o pointed out that the no-push pattern matches what `@existdb/xst`, `@existdb/node-exist`, and `@existdb/gulp-exist` already do. That feedback shaped this plugin's design.

This plugin corresponds to §5.3 of a broader release-strategy proposal being circulated among the eXist-db devs for automating EXPath package releases.

## License

LGPL-2.1-or-later (matching the eXist-db org convention).
