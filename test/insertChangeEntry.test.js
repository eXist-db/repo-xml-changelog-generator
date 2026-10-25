/**
 * Unit test: insertChangeEntry against a fixture descriptor.
 *
 * Doesn't depend on git — verifies the XML manipulation alone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, copyFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

import { insertChangeEntry } from '../lib/changelog.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function inTempDir () {
  const dir = mkdtempSync(join(tmpdir(), 'sre-test-'))
  const tmplPath = join(dir, 'repo.xml.tmpl')
  copyFileSync(join(__dirname, 'fixture-repo.xml.tmpl'), tmplPath)
  return tmplPath
}

test('insertChangeEntry inserts a new <change> at the top of <changelog>', () => {
  const tmplPath = inTempDir()

  insertChangeEntry({
    tmplPath,
    version: '1.0.0',
    items: ['New: foo: add foo support', 'Fix: bar: handle null bar']
  })

  const result = readFileSync(tmplPath, 'utf8')

  assert.match(result, /<change version="1\.0\.0">/, 'new <change> element present')
  assert.match(result, /add foo support/, 'first item present')
  assert.match(result, /handle null bar/, 'second item present')

  // The new entry should appear before the 0.0.1 entry that was already there.
  const new_pos = result.indexOf('version="1.0.0"')
  const old_pos = result.indexOf('version="0.0.1"')
  assert.ok(new_pos > 0 && old_pos > 0, 'both entries present')
  assert.ok(new_pos < old_pos, 'new entry inserted before old entry (most-recent-first ordering)')

  // The old entry should still be intact.
  assert.match(result, /Initial release/, 'pre-existing entry preserved')
})

test('insertChangeEntry preserves the <changelog> root and other meta children', () => {
  const tmplPath = inTempDir()

  insertChangeEntry({
    tmplPath,
    version: '2.0.0',
    items: ['New: x']
  })

  const result = readFileSync(tmplPath, 'utf8')

  assert.match(result, /<target>fixture<\/target>/, 'other <meta> children preserved')
  assert.match(result, /<changelog>/, '<changelog> still present')
  assert.match(result, /<\/changelog>/, '<changelog> closing tag still present')
})

test('insertChangeEntry renders markdown links as XHTML anchors', () => {
  const tmplPath = inTempDir()

  insertChangeEntry({
    tmplPath,
    version: '4.0.0',
    items: ['Fix: ui: address PR [#398](https://github.com/eXist-db/monex/issues/398) review comments']
  })

  const result = readFileSync(tmplPath, 'utf8')

  assert.match(
    result,
    /Fix: ui: address PR <a href="https:\/\/github\.com\/eXist-db\/monex\/issues\/398">#398<\/a> review comments/,
    'markdown link converted to anchor'
  )
})

test('insertChangeEntry uses correct namespaces (repo for <change>, html for <ul>/<li>)', () => {
  const tmplPath = inTempDir()

  insertChangeEntry({
    tmplPath,
    version: '3.0.0',
    items: ['Test item']
  })

  const result = readFileSync(tmplPath, 'utf8')

  // <change> inherits the repo namespace from its <changelog> parent — no explicit xmlns needed
  // <ul> needs the explicit html xmlns since it's in a different namespace
  assert.match(
    result,
    /<change version="3\.0\.0">[^<]*<ul xmlns="http:\/\/www\.w3\.org\/1999\/xhtml">/,
    '<ul> carries html namespace'
  )
})
