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

The plugin works with or without `@semantic-release/git` — the choice decides where your changelog history lives:

- **Without it** (in-memory mode), the mutation happens only on the CI runner; the on-disk `repo.xml.tmpl` in your default branch stays at its development-placeholder state, and the per-release changelog history lives in git tags + GitHub Releases. Note that each built XAR then contains only the entries curated in the template plus the *current* release's generated entry — the entries generated for previous releases are not carried forward.
- **With it** (commit-back mode), add `@semantic-release/git` *after* this plugin with `repo.xml.tmpl` (and typically `package.json` + `package-lock.json`) as assets. Each release then commits the new `<change>` entry back to the default branch, so the changelog accumulates and every released XAR carries the full history. This is the model `eXist-db/monex` adopted by community vote ([monex#453](https://github.com/eXist-db/monex/pull/453)); it requires branch protection to allow the GitHub Actions app to push.

See [Design rationale](#design-rationale) below.

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

Analysis is left entirely to the project's semantic-release configuration; the plugin only renders the result.

**Analysis**: the commits are the ones semantic-release collected for the release (`context.commits`): everything since the last release, or all commits of the branch on a first release. Each one is:

- parsed with the parser options of the configured `@semantic-release/commit-analyzer` (its `preset`, `config` and `parserOpts`; `angular` when none is set), and
- rated on its own by that analyzer, including its `releaseRules`.

A commit is listed when it triggers a release. It's a breaking change when the analyzer rates it major.

**Rendering**:

- Breaking changes first, as `Breaking change: scope: subject`, then the other commits as `Prefix: scope: subject`, where Prefix is:
  - `New` (for `feat:`)
  - `Fix` (for `fix:`)
  - `Improvement` (for `perf:`)
  - `Revert` (for reverts)
  - or the literal type for any other type a project's release rules let through.
- Items are ordered by type in that order, then by scope and subject.
- Only the commit subject is rendered. A `BREAKING CHANGE:` footer's text, which can run to several paragraphs, is left to the release notes. Commit bodies, including trailers such as `Co-Authored-By:`, never appear.
- A header the project's parser does not understand is shown as is (e.g. `feat(api)!: …` under `angular`, which has no `!` marker).
- Issue/PR references the parser found (e.g. `#398`) become XHTML `<a>` links, with URLs derived from semantic-release's `repositoryUrl`. References to other repositories, which include XQuery function arities like `semver:sort#3`, and all references on non-GitHub remotes, stay plain text.
- Hard-wrapped commit subjects are folded into a single line.

The rendered items are wrapped in a `<change version="X.Y.Z"><ul xmlns="http://www.w3.org/1999/xhtml">…</ul></change>` and inserted at the **top** of the existing `<changelog>` element (most recent first).

### Edge cases

| Situation | Behavior |
|-----------|----------|
| First release (no previous release) | All commits of the branch are rendered into the first `<change>` entry. |
| No conventional commits since the last release | Skip injection. Log "no notable commits". |
| Configured `tmplPath` doesn't exist | `verifyConditions` aborts the release with a clear error. |
| `<changelog>` element missing | `verifyConditions` aborts with instructions to add an empty `<changelog/>`. |

## Design rationale

### Why in-memory, not push-back?

The default approach for many semantic-release setups is to use `@semantic-release/git` to commit the mutated files (`package.json`, `CHANGELOG.md`, etc.) back to the default branch. For eXist-db org repos with branch protection that requires PRs, this means the GitHub Actions token can't push the release commit — you need a PAT or a GitHub App to bypass protection. That's operational overhead (PAT rotation, App installation per repo, secret management).

The alternative — used by `@existdb/xst`, `@existdb/node-exist`, `@existdb/gulp-exist`, and `eXist-db/function-documentation` — is to **pin the default-branch version to `0.0.0-development` permanently**, do all the version + changelog work in-memory on the CI runner, and let the built XAR carry the real version. No push-back, no token plumbing, branch protection works as intended.

The trade-off: for npm packages the version history lives in the npm registry anyway, but for XAR packages the `<changelog>` in the shipped descriptor is itself the history — and in-memory mode drops each generated entry after its release. `eXist-db/monex` used in-memory mode from 2026-05-19 until a community vote switched it to commit-back ([monex#453](https://github.com/eXist-db/monex/pull/453)) after its 5.1.0 XAR shipped without the generated 5.0.0 entry. Branch protection there allows the GitHub Actions app to push, so no PAT or custom App is needed.

This plugin supports both workflows; pick per repository.

### Why not just publish the existing script as-is?

Because every adopter would still have to copy it into their repo and invoke it via `@semantic-release/exec` prepareCmd. The plugin form:

- Hooks into semantic-release's lifecycle directly (gets `lastRelease`, `nextRelease`, `commits`, `logger`, `cwd` natively).
- Adds proper `verifyConditions` so misconfiguration is caught early.
- Lets adopters install it as an npm dependency instead of vendoring a 170-line script.
- Centralizes future improvements (e.g. cross-link PRs/issues, support `expath-pkg.xml.tmpl` version sync, support custom commit-type → prefix mappings).

### Why a Node plugin, not an XQuery one?

semantic-release itself is a Node tool and runs in Node. The plugin API is Node-native. Reimplementing in XQuery would mean either (a) standing up a separate XQuery runtime in CI just to run the changelog hook, or (b) calling out to it via HTTP/shell. Both add complexity for no user-visible benefit. The plugin's output (the `<change>` element it emits) is the data that lives in the XQuery world — the producer can be in any language.

## Releasing this package

This plugin releases itself with semantic-release, eating its own dog food. Merges to `main` run the [CI workflow](.github/workflows/release.yml): the test matrix runs, then `semantic-release` analyzes the Conventional Commits, computes the next version, publishes to npm (`@existdb` scope), and creates the GitHub Release. The in-tree `version` stays pinned at `0.0.0-development`; the real version is set in-memory at release time (the in-memory workflow described above — a natural fit here, since an npm package's version history lives in the registry).

Commit messages are linted against [Conventional Commits](https://www.conventionalcommits.org/) via commitlint — locally through a husky `commit-msg` hook, and in CI on every pull request.

## Acknowledgements

- The core changelog logic was originally written for [eXist-db/semver.xq#69](https://github.com/eXist-db/semver.xq/pull/69) and adopted in [eXist-db/monex](https://github.com/eXist-db/monex) and [eXist-db/function-documentation](https://github.com/eXist-db/function-documentation). This plugin is a refactor of that proven logic.
- @line-o pointed out that the no-push pattern matches what `@existdb/xst`, `@existdb/node-exist`, and `@existdb/gulp-exist` already do. That feedback shaped this plugin's design.

This plugin corresponds to §5.3 of a broader release-strategy proposal being circulated among the eXist-db devs for automating EXPath package releases.

## License

LGPL-2.1-or-later (matching the eXist-db org convention).
