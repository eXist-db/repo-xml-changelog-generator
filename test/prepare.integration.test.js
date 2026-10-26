/**
 * Integration test: exercise the prepare hook end-to-end against a
 * temporary git repo with real Conventional Commits.
 *
 * Verifies the full pipeline: git log → CommitParser → grouping →
 * template injection → file write.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'child_process'
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'

import { getCommits } from 'semantic-release/lib/git.js'

import * as plugin from '../index.js'
import { pluginEntries } from '../lib/changelog.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function setupFixtureRepo () {
  const dir = mkdtempSync(join(tmpdir(), 'sre-integ-'))
  const tmplPath = join(dir, 'repo.xml.tmpl')
  copyFileSync(join(__dirname, 'fixture-repo.xml.tmpl'), tmplPath)

  const run = (cmd) => execSync(cmd, { cwd: dir, stdio: 'pipe' })

  run('git init -q -b main')
  run('git config user.email test@example.com')
  run('git config user.name Test')
  run('git add repo.xml.tmpl')
  run('git commit -q -m "chore: initial commit"')
  run('git tag v0.0.1')

  // Several conventional commits to be picked up by the next release
  writeFileSync(join(dir, 'a.txt'), 'a')
  run('git add a.txt')
  run('git commit -q -m "feat: add new awesome feature"')

  writeFileSync(join(dir, 'b.txt'), 'b')
  run('git add b.txt')
  run('git commit -q -m "fix(parser): handle empty input"')

  writeFileSync(join(dir, 'c.txt'), 'c')
  run('git add c.txt')
  run('git commit -q -m "perf: speed up the hot loop"')

  writeFileSync(join(dir, 'd.txt'), 'd')
  run('git add d.txt')
  run('git commit -q -m "feat!: drop legacy API\n\nBREAKING CHANGE: removed deprecated do_thing() in favor of doThing()."')

  return dir
}

function addCommit (dir, file, message) {
  writeFileSync(join(dir, file), file)
  execSync('git add ' + file, { cwd: dir, stdio: 'pipe' })
  execSync(`git commit -q -m "${message}"`, { cwd: dir, stdio: 'pipe' })
}

// Collects `commits` the way semantic-release does: everything since the
// last release, or all commits of the branch for a first release.
async function mockContext (
  cwd,
  lastTag,
  repositoryUrl = 'https://github.com/eXist-db/fixture.git',
  analyzerConfig = { preset: 'conventionalcommits' }
) {
  const logs = []
  const gitHead = lastTag
    ? execSync(`git rev-list -n 1 ${lastTag}`, { cwd, encoding: 'utf8' }).trim()
    : undefined
  return {
    cwd,
    logger: { log: (msg) => logs.push(msg) },
    lastRelease: lastTag ? { gitTag: lastTag, gitHead } : {},
    commits: await getCommits(gitHead, 'HEAD', { cwd }),
    nextRelease: { version: '1.0.0', gitTag: 'v1.0.0' },
    options: {
      ...(repositoryUrl ? { repositoryUrl } : {}),
      plugins: [['@semantic-release/commit-analyzer', analyzerConfig], '@semantic-release/release-notes-generator']
    },
    _logs: logs
  }
}

test('verifyConditions accepts a well-formed fixture', async () => {
  const cwd = setupFixtureRepo()
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.verifyConditions({}, ctx)
  assert.ok(ctx._logs.some(m => m.includes('verified')), 'logged verification')
})

test('verifyConditions rejects when template is missing', async () => {
  const ctx = { cwd: '/nonexistent-12345', logger: { log () {} } }
  await assert.rejects(plugin.verifyConditions({}, ctx), /Template not found/)
})

test('prepare injects conventional commits as a new <change>', async () => {
  const cwd = setupFixtureRepo()
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')

  assert.match(result, /<change version="1\.0\.0">/, 'new <change> present')

  // Each conventional commit should be rendered as a <li>
  assert.match(result, /<li>Breaking change: drop legacy API<\/li>/, 'breaking change rendered from its subject')
  assert.match(result, /New: add new awesome feature/, 'feat rendered with New prefix')
  assert.match(result, /Fix: parser: handle empty input/, 'fix rendered with Fix prefix and scope')
  assert.match(result, /Improvement: speed up the hot loop/, 'perf rendered with Improvement prefix')

  // The breaking-change feat commit appears once, and not as a New: item
  const matches = result.match(/drop legacy API/g) ?? []
  assert.equal(matches.length, 1, 'breaking commit is not double-rendered')
  assert.doesNotMatch(result, /removed deprecated do_thing/, 'footer text is left to the release notes')

  // 0.0.1 entry still present
  assert.match(result, /version="0\.0\.1"/)
})

test('prepare logs and exits cleanly when no commits since lastRelease', async () => {
  const cwd = setupFixtureRepo()
  // Use HEAD as the previous tag, so there are no commits after it
  execSync('git tag v0.9.9', { cwd, stdio: 'pipe' })
  const ctx = await mockContext(cwd, 'v0.9.9')

  await plugin.prepare({}, ctx)

  assert.ok(
    ctx._logs.some(m => m.includes('No notable commits')),
    'logged no-commits message'
  )

  // Template should be unchanged
  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.doesNotMatch(result, /version="1\.0\.0"/, 'template not mutated')
})

test('prepare renders all commits on a first release', async () => {
  const cwd = setupFixtureRepo()
  const ctx = await mockContext(cwd, undefined)

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<change version="1\.0\.0">/, 'new <change> present')
  assert.match(result, /New: add new awesome feature/, 'commit before the v0.0.1 tag included')
  assert.doesNotMatch(result, /initial commit/, 'hidden chore commit still skipped')
})

test('prepare folds hard-wrapped commit subjects into a single item', async () => {
  const cwd = setupFixtureRepo()
  // A subject paragraph hard-wrapped by an editor at 72 columns: git treats
  // both lines as the subject, so no words may be lost.
  addCommit(cwd, 'e.txt', 'feat: redesign browse indexes with KPI summary and vector\nbadges')
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(
    result,
    /New: redesign browse indexes with KPI summary and vector badges/,
    'wrapped subject rendered in full'
  )
})

test('prepare renders issue references as XHTML links', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'f.txt', 'fix(ui): address PR #398 review comments')
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(
    result,
    /Fix: ui: address PR <a href="https:\/\/github\.com\/eXist-db\/fixture\/issues\/398">#398<\/a> review comments/,
    'issue reference rendered as anchor with URL derived from repositoryUrl'
  )
})

test('prepare does not link XQuery function arities as issue references', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'o.txt', 'fix: semver:sort#3 returns all results (#12)')
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(
    result,
    /<li>Fix: semver:sort#3 returns all results \(<a href="https:\/\/github\.com\/eXist-db\/fixture\/issues\/12">#12<\/a>\)<\/li>/,
    'arity kept as text, real reference still linked'
  )
})

test('prepare falls back to plain-text references without a GitHub repositoryUrl', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'g.txt', 'fix(ui): address PR #398 review comments')
  const ctx = await mockContext(cwd, 'v0.0.1', null)

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /address PR #398 review comments/, 'reference kept as plain text')
  assert.doesNotMatch(result, /undefined/, 'no broken undefined URLs')
})

test('prepare renders breaking changes from the subject, not the footer', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'i.txt',
    'refactor(api)!: remove the old API\n\n' +
    'BREAKING CHANGE: The old API is gone. Migrating takes a few steps:\n' +
    'first replace the calls, then update the configuration.\n\n' +
    'Co-Authored-By: Someone <someone@example.com>\n' +
    'Signed-off-by: Other <other@example.com>')
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>Breaking change: api: remove the old API<\/li>/, 'subject of a hidden type rendered as breaking')
  assert.doesNotMatch(result, /old API is gone|Co-Authored-By|Signed-off-by/i, 'neither footer nor trailers rendered')
  const items = result.match(/<li>[^<]*<\/li>/g)
  assert.match(items[0], /^<li>Breaking change:/, 'breaking changes listed first')
})

test('breaking changes are the ones the configured commit-analyzer rates major', async () => {
  const cwd = setupFixtureRepo()
  // Not breaking for an analyzer that only knows the `BREAKING CHANGE` keyword:
  addCommit(cwd, 'l.txt', 'fix: tidy the parser\n\nBREAKING-CHANGE: nothing really')
  addCommit(cwd, 'm.txt', 'refactor: shuffle internals\n\nBREAKING-CHANGE: not really either')
  // Breaking through a custom release rule, though it has no footer:
  addCommit(cwd, 'n.txt', 'docs(api): drop the v1 reference')
  const ctx = await mockContext(cwd, 'v0.0.1', undefined, {
    preset: 'conventionalcommits',
    parserOpts: { noteKeywords: ['BREAKING CHANGE'] },
    releaseRules: [{ type: 'docs', scope: 'api', release: 'major' }]
  })

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>Fix: tidy the parser<\/li>/, 'footer the analyzer ignores is not breaking')
  assert.doesNotMatch(result, /shuffle internals/, 'hidden type without a breaking verdict skipped')
  assert.match(result, /<li>Breaking change: api: drop the v1 reference<\/li>/, 'custom major rule rendered as breaking')
  assert.match(result, /<li>Breaking change: drop legacy API<\/li>/, 'BREAKING CHANGE footer still breaking')
})

test('commits are parsed with the configured analyzer preset', async () => {
  const cwd = setupFixtureRepo()
  // `angular` does not know the `!` marker: the header stays unparsed and is
  // shown as is, while its BREAKING CHANGE footer still makes it major.
  addCommit(cwd, 'p.txt', 'feat(api)!: drop v1\n\nBREAKING CHANGE: v1 is gone')
  const ctx = await mockContext(cwd, 'v0.0.1', undefined, {})

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>Breaking change: feat\(api\)!: drop v1<\/li>/, 'unparsed header shown as is')
  assert.match(result, /<li>New: add new awesome feature<\/li>/, 'regular commits parsed by angular')
})

test('types released by custom rules keep their literal type', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'q.txt', 'docs: explain the router')
  addCommit(cwd, 'r.txt', 'style: reformat sources')
  const ctx = await mockContext(cwd, 'v0.0.1', undefined, {
    preset: 'conventionalcommits',
    releaseRules: [{ type: 'docs', release: 'patch' }]
  })

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>docs: explain the router<\/li>/, 'released docs commit listed')
  assert.doesNotMatch(result, /reformat sources/, 'commit that triggers no release skipped')
})

test('pluginEntries merges global options with each entry', () => {
  const inline = { analyzeCommits () {} }
  assert.deepEqual(
    pluginEntries({
      preset: 'angular',
      branches: ['main'],
      plugins: [
        '@semantic-release/npm',
        ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
        { path: './analyzer.js', label: 'x' },
        inline
      ]
    }),
    [
      ['@semantic-release/npm', { preset: 'angular', branches: ['main'] }],
      ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits', branches: ['main'] }],
      ['./analyzer.js', { preset: 'angular', branches: ['main'], label: 'x' }],
      [inline, { preset: 'angular', branches: ['main'] }]
    ]
  )
  assert.deepEqual(pluginEntries({}), [['@semantic-release/commit-analyzer', {}]])
})

test('commits reverted within the release are left out with their reverts', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 's.txt', 'feat: add x')
  addCommit(cwd, 't.txt', 'fix: keep y')
  execSync('git revert --no-edit HEAD~1', { cwd, stdio: 'pipe' })
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>Fix: keep y<\/li>/, 'other commits still listed')
  assert.doesNotMatch(result, /add x/, 'reverted commit and its revert both left out')
})

test('reverted pairs stay when the analyzers do not cancel them out', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 's.txt', 'feat: add x')
  execSync('git revert --no-edit HEAD', { cwd, stdio: 'pipe' })
  const ctx = await mockContext(cwd, 'v0.0.1')
  ctx.options.preset = 'conventionalcommits'
  // rates every commit, without filtering reverts
  ctx.options.plugins = [{ analyzeCommits: (config, { commits }) => commits.length ? 'patch' : null }]

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>New: add x<\/li>/, 'reverted commit kept')
  assert.match(result, /<li>Revert: feat: add x<\/li>/, 'revert kept')
})

test('a reapplied commit is rated as commit-analyzer rates it', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 's.txt', 'feat: add x')
  execSync('git revert --no-edit HEAD', { cwd, stdio: 'pipe' })
  // git titles a revert of a revert `Reapply "feat: add x"`, which the
  // presets do not parse as a revert: commit-analyzer cancels the feat with
  // the first revert and releases nothing for the reapply.
  execSync('git revert --no-edit HEAD', { cwd, stdio: 'pipe' })
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.doesNotMatch(result, /add x/)
  assert.match(result, /<li>New: add new awesome feature<\/li>/, 'other commits still listed')
})

test('reverts of earlier releases show the reverted header', async () => {
  const cwd = setupFixtureRepo()
  execSync('git tag v0.1.0', { cwd, stdio: 'pipe' })
  execSync('git revert --no-edit HEAD', { cwd, stdio: 'pipe' })
  const ctx = await mockContext(cwd, 'v0.1.0')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>Revert: feat!: drop legacy API<\/li>/, 'revert rendered once, with the reverted header')
})

test('commits marked [skip release] are left out', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'u.txt', 'fix: quiet fix [skip release]')
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.doesNotMatch(result, /quiet fix/)
})

test('every configured analyzer rates the commits, the highest rating wins', async () => {
  const cwd = setupFixtureRepo()
  writeFileSync(join(cwd, 'analyzer.mjs'), `export function analyzeCommits ({ word, release }, { commits }) {
    return commits.some(({ message }) => message.includes(word)) ? release : null
  }`)
  addCommit(cwd, 'v.txt', 'docs: mention the [api] change')
  addCommit(cwd, 'w.txt', 'feat: add [big] thing')
  const ctx = await mockContext(cwd, 'v0.0.1')
  ctx.options.plugins.push(['./analyzer.mjs', { word: '[api]', release: 'minor' }])
  ctx.options.plugins.push(['./analyzer.mjs', { word: '[big]', release: 'major' }])

  await plugin.verifyConditions({}, ctx)
  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>docs: mention the \[api\] change<\/li>/, 'released by the custom analyzer only')
  assert.match(result, /<li>Breaking change: add \[big\] thing<\/li>/, 'major from the custom analyzer wins')
  assert.match(result, /<li>Fix: parser: handle empty input<\/li>/, 'commit-analyzer ratings kept')
})

test('custom analyzers work without @semantic-release/commit-analyzer', async () => {
  const cwd = setupFixtureRepo()
  const ctx = await mockContext(cwd, 'v0.0.1')
  ctx.options.preset = 'conventionalcommits'
  ctx.options.plugins = [{
    analyzeCommits: (config, { commits }) => commits[0].message.startsWith('perf') ? 'patch' : null
  }]

  await plugin.verifyConditions({}, ctx)
  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  const change = result.match(/<change version="1\.0\.0">[\s\S]*?<\/change>/)[0]
  const items = change.match(/<li>[^<]*<\/li>/g)
  assert.deepEqual(items, ['<li>Improvement: speed up the hot loop</li>'], 'parsed with the analyzer options')
})

test('verifyConditions rejects an analyzer that cannot be loaded', async () => {
  const cwd = setupFixtureRepo()
  const ctx = await mockContext(cwd, 'v0.0.1')
  ctx.options.plugins.push('./missing-analyzer.mjs')

  await assert.rejects(plugin.verifyConditions({}, ctx), /Cannot find module '\.\/missing-analyzer\.mjs'/)
})

test('prepare escapes XML special characters in subjects', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'h.txt', 'feat: support <b> tags & friends')
  const ctx = await mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /support &lt;b&gt; tags &amp; friends/, 'special characters escaped')
})
