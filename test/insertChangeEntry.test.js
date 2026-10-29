/**
 * Unit test: insertChangeEntry against a fixture descriptor.
 *
 * Doesn't depend on git — verifies the XML manipulation alone.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, copyFileSync, mkdtempSync, writeFileSync } from 'fs'
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

// Writes `changelog` as the last child of a <meta> descriptor indented with
// `step`, runs insertChangeEntry once per version and returns the <changelog>.
function insertInto (changelog, versions, step = '    ') {
  const dir = mkdtempSync(join(tmpdir(), 'sre-test-'))
  const tmplPath = join(dir, 'repo.xml.tmpl')
  writeFileSync(tmplPath,
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<meta xmlns="http://exist-db.org/xquery/repo">\n' +
    `${step}<type>library</type>\n` +
    `${step}${changelog}\n` +
    '</meta>\n')
  for (const version of versions) {
    insertChangeEntry({ tmplPath, version, items: [`Fix: ${version}`] })
  }
  const result = readFileSync(tmplPath, 'utf8')
  return result.slice(result.indexOf(`${step}<changelog`), result.indexOf('</meta>'))
}

function expected (versions, step = '    ') {
  const entries = versions.map(version =>
    `${step.repeat(2)}<change version="${version}">\n` +
    `${step.repeat(3)}<ul xmlns="http://www.w3.org/1999/xhtml">\n` +
    `${step.repeat(4)}<li>Fix: ${version}</li>\n` +
    `${step.repeat(3)}</ul>\n` +
    `${step.repeat(2)}</change>\n`)
  return `${step}<changelog>\n${entries.join('')}${step}</changelog>\n`
}

for (const [name, changelog] of [
  ['an empty <changelog/>', '<changelog/>'],
  ['an empty <changelog></changelog>', '<changelog></changelog>'],
  ['a <changelog> with whitespace at the depth of its entries', '<changelog>\n        </changelog>'],
  ['a <changelog> with whitespace at its own depth', '<changelog>\n    </changelog>']
]) {
  test(`insertChangeEntry indents the first entry and the closing tag of ${name} (#11)`, () => {
    assert.equal(insertInto(changelog, ['1.0.0']), expected(['1.0.0']))
  })
}

test('insertChangeEntry keeps the indentation over several releases (#11)', () => {
  assert.equal(
    insertInto('<changelog/>', ['1.0.0', '1.1.0', '2.0.0']),
    expected(['2.0.0', '1.1.0', '1.0.0'])
  )
})

test('insertChangeEntry keeps the indentation of an existing changelog', () => {
  const tmplPath = inTempDir()
  insertChangeEntry({ tmplPath, version: '1.0.0', items: ['Fix: 1.0.0'] })
  assert.equal(
    readFileSync(tmplPath, 'utf8'),
    readFileSync(join(__dirname, 'fixture-repo.xml.tmpl'), 'utf8').replace(
      '    <changelog>\n',
      '    <changelog>\n' + expected(['1.0.0']).split('\n').slice(1, -2).join('\n') + '\n'
    )
  )
})

test('insertChangeEntry follows the indentation step of the descriptor (#11)', () => {
  assert.equal(insertInto('<changelog/>', ['1.0.0'], '  '), expected(['1.0.0'], '  '))
  assert.equal(insertInto('<changelog/>', ['1.0.0'], '\t'), expected(['1.0.0'], '\t'))
})

test('insertChangeEntry ends the descriptor with a line break', () => {
  for (const end of ['\n', '', '\n\n']) {
    const dir = mkdtempSync(join(tmpdir(), 'sre-test-'))
    const tmplPath = join(dir, 'repo.xml.tmpl')
    writeFileSync(tmplPath, '<meta xmlns="http://exist-db.org/xquery/repo">\n    <changelog/>\n</meta>' + end)
    insertChangeEntry({ tmplPath, version: '1.0.0', items: ['Fix: 1.0.0'] })
    assert.ok(readFileSync(tmplPath, 'utf8').endsWith('</meta>\n'), JSON.stringify(end))
  }
})

test('insertChangeEntry takes the indentation step from the descriptor if <changelog> does not tell it', () => {
  const insert = xml => {
    const dir = mkdtempSync(join(tmpdir(), 'sre-test-'))
    const tmplPath = join(dir, 'repo.xml.tmpl')
    writeFileSync(tmplPath, xml)
    insertChangeEntry({ tmplPath, version: '1.0.0', items: ['Fix: 1.0.0'] })
    return readFileSync(tmplPath, 'utf8')
  }
  const entry = (indent, step) =>
    `${indent}<change version="1.0.0">\n` +
    `${indent}${step}<ul xmlns="http://www.w3.org/1999/xhtml">\n` +
    `${indent}${step.repeat(2)}<li>Fix: 1.0.0</li>\n` +
    `${indent}${step}</ul>\n` +
    `${indent}</change>\n`

  // <changelog> at column 0 of a descriptor indented with tabs
  assert.equal(
    insert('<meta xmlns="http://exist-db.org/xquery/repo">\n\t<type>library</type>\n<changelog/>\n</meta>\n'),
    '<meta xmlns="http://exist-db.org/xquery/repo">\n\t<type>library</type>\n<changelog>\n' +
      entry('\t', '\t') + '</changelog>\n</meta>\n'
  )
  // no indentation at all
  assert.equal(
    insert('<meta xmlns="http://exist-db.org/xquery/repo"><changelog/></meta>'),
    '<meta xmlns="http://exist-db.org/xquery/repo"><changelog>\n' +
      entry('    ', '    ') + '</changelog></meta>\n'
  )
})
