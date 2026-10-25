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

import * as plugin from '../index.js'

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

function mockContext (cwd, lastTag, repositoryUrl = 'https://github.com/eXist-db/fixture.git') {
  const logs = []
  return {
    cwd,
    logger: { log: (msg) => logs.push(msg) },
    lastRelease: { gitTag: lastTag },
    nextRelease: { version: '1.0.0', gitTag: 'v1.0.0' },
    options: repositoryUrl ? { repositoryUrl } : {},
    _logs: logs
  }
}

test('verifyConditions accepts a well-formed fixture', async () => {
  const cwd = setupFixtureRepo()
  const ctx = mockContext(cwd, 'v0.0.1')

  await plugin.verifyConditions({}, ctx)
  assert.ok(ctx._logs.some(m => m.includes('verified')), 'logged verification')
})

test('verifyConditions rejects when template is missing', async () => {
  const ctx = mockContext('/nonexistent-12345', 'v0.0.1')
  await assert.rejects(plugin.verifyConditions({}, ctx), /Template not found/)
})

test('prepare injects conventional commits as a new <change>', async () => {
  const cwd = setupFixtureRepo()
  const ctx = mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')

  assert.match(result, /<change version="1\.0\.0">/, 'new <change> present')

  // Each conventional commit should be rendered as a <li>
  assert.match(result, /Breaking change: removed deprecated do_thing/, 'BREAKING CHANGE rendered')
  assert.match(result, /New: add new awesome feature/, 'feat rendered with New prefix')
  assert.match(result, /Fix: parser: handle empty input/, 'fix rendered with Fix prefix and scope')
  assert.match(result, /Improvement: speed up the hot loop/, 'perf rendered with Improvement prefix')

  // The breaking-change feat commit should NOT also appear as a non-breaking item
  const matches = result.match(/drop legacy API/g) ?? []
  assert.equal(matches.length, 0, 'breaking commit is not double-rendered')

  // 0.0.1 entry still present
  assert.match(result, /version="0\.0\.1"/)
})

test('prepare logs and exits cleanly when no commits since lastRelease', async () => {
  const cwd = setupFixtureRepo()
  // Use HEAD as the previous tag, so there are no commits after it
  execSync('git tag v0.9.9', { cwd, stdio: 'pipe' })
  const ctx = mockContext(cwd, 'v0.9.9')

  await plugin.prepare({}, ctx)

  assert.ok(
    ctx._logs.some(m => m.includes('No notable commits')),
    'logged no-commits message'
  )

  // Template should be unchanged
  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.doesNotMatch(result, /version="1\.0\.0"/, 'template not mutated')
})

test('prepare skips when no lastRelease.gitTag (first release)', async () => {
  const cwd = setupFixtureRepo()
  const ctx = mockContext(cwd, '')

  await plugin.prepare({}, ctx)

  assert.ok(
    ctx._logs.some(m => m.includes('No previous release tag')),
    'logged first-release skip message'
  )

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.doesNotMatch(result, /version="1\.0\.0"/, 'template not mutated')
})

test('prepare folds hard-wrapped commit subjects into a single item', async () => {
  const cwd = setupFixtureRepo()
  // A subject paragraph hard-wrapped by an editor at 72 columns: git treats
  // both lines as the subject, so no words may be lost.
  addCommit(cwd, 'e.txt', 'feat: redesign browse indexes with KPI summary and vector\nbadges')
  const ctx = mockContext(cwd, 'v0.0.1')

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
  const ctx = mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(
    result,
    /Fix: ui: address PR <a href="https:\/\/github\.com\/eXist-db\/fixture\/issues\/398">#398<\/a> review comments/,
    'issue reference rendered as anchor with URL derived from repositoryUrl'
  )
})

test('prepare falls back to plain-text references without a GitHub repositoryUrl', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'g.txt', 'fix(ui): address PR #398 review comments')
  const ctx = mockContext(cwd, 'v0.0.1', null)

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /address PR #398 review comments/, 'reference kept as plain text')
  assert.doesNotMatch(result, /undefined/, 'no broken undefined URLs')
})

test('prepare drops git trailers from breaking-change notes', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'i.txt',
    'feat!: remove the old API\n\n' +
    'BREAKING CHANGE: The old API is gone.\n\n' +
    'Co-Authored-By: Someone <someone@example.com>\n' +
    'Signed-off-by: Other <other@example.com>\n' +
    'Reviewed-by: Reviewer <reviewer@example.com>\n' +
    'Claude-Session: https://claude.ai/code/session_123\n' +
    'Change-Id: I0123456789abcdef')
  addCommit(cwd, 'j.txt',
    'feat!: rename the config file\n\n' +
    'Co-authored-by: Someone <someone@example.com>\n' +
    'BREAKING-CHANGE: config.json is now settings.json.')
  // A squashed fixup repeats a trailer in the middle of the message.
  addCommit(cwd, 'k.txt',
    'feat!: require Node 22\n\n' +
    'BREAKING CHANGE: Node 20 is no longer supported.\n\n' +
    'Co-Authored-By: Someone <someone@example.com>\n\n' +
    'More details.\n\n' +
    'Co-Authored-By: Someone <someone@example.com>')
  const ctx = mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<li>Breaking change: The old API is gone\.<\/li>/, 'trailers dropped from note')
  assert.match(result, /<li>Breaking change: config\.json is now settings\.json\.<\/li>/, 'BREAKING-CHANGE footer kept')
  assert.match(result, /<li>Breaking change: Node 20 is no longer supported\. More details\.<\/li>/, 'mid-message trailer dropped')
  assert.doesNotMatch(result, /Co-Authored-By|Signed-off-by|Reviewed-by|Claude-Session|Change-Id/i, 'no trailer leaks into the changelog')
})

test('prepare escapes XML special characters in subjects', async () => {
  const cwd = setupFixtureRepo()
  addCommit(cwd, 'h.txt', 'feat: support <b> tags & friends')
  const ctx = mockContext(cwd, 'v0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /support &lt;b&gt; tags &amp; friends/, 'special characters escaped')
})

test('prepare also accepts numeric tag form (e.g. lastTag without v prefix)', async () => {
  const cwd = setupFixtureRepo()
  // lastRelease.gitTag is "0.0.1" but the actual tag in git is "v0.0.1"
  const ctx = mockContext(cwd, '0.0.1')

  await plugin.prepare({}, ctx)

  const result = readFileSync(join(cwd, 'repo.xml.tmpl'), 'utf8')
  assert.match(result, /<change version="1\.0\.0">/, 'still found commits via v-prefixed fallback')
})
