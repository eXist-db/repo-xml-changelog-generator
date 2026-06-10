/**
 * Core changelog logic, factored out of the plugin entry so it can be
 * exercised by unit tests with mock git input.
 *
 * Lifted from eXist-db/semver.xq's update-repo-changelog.js and adapted
 * to the semantic-release plugin shape (read tags from arguments, not
 * CLI flags; resolve paths against an explicit cwd).
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { CommitParser } from 'conventional-commits-parser'
import { writeChangelogString } from 'conventional-changelog-writer'
import conventionalChangelogConventionalCommits from 'conventional-changelog-conventionalcommits'

const REPO_NS = 'http://exist-db.org/xquery/repo'
const HTML_NS = 'http://www.w3.org/1999/xhtml'

const SECTION_PREFIX = {
  Features: 'New',
  'Bug Fixes': 'Fix',
  'Performance Improvements': 'Improvement',
  Reverts: 'Revert'
}

const XML_MAIN_TEMPLATE =
  '{{#each noteGroups}}' +
  '{{#each notes}}' +
  '<li>Breaking change: {{text}}</li>\n' +
  '{{/each}}' +
  '{{/each}}' +
  '{{#each commitGroups}}' +
  '{{#each commits}}' +
  '{{#unless isBreaking}}<li>{{prefix}}: {{#if scope}}{{scope}}: {{/if}}{{subject}}</li>\n{{/unless}}' +
  '{{/each}}' +
  '{{/each}}'

function tagExists (tag, cwd) {
  try {
    execSync(`git rev-parse "${tag}"`, { stdio: 'pipe', cwd })
    return true
  } catch {
    return false
  }
}

function getRawCommits ({ prevTag, cwd }) {
  const ref = tagExists(prevTag, cwd) ? prevTag
    : tagExists(`v${prevTag}`, cwd) ? `v${prevTag}`
      : null
  if (!ref) throw new Error(`[repo-xml-changelog-generator] Tag not found: ${prevTag} or v${prevTag}`)

  const hashes = execSync(`git log ${ref}..HEAD --format=%H`, { encoding: 'utf8', cwd })
    .trim().split('\n').filter(Boolean)

  return hashes.map(hash =>
    execSync(`git log -1 --format=%B ${hash}`, { encoding: 'utf8', cwd }).trim()
  )
}

export async function buildChangeItems ({ prevTag, version, cwd }) {
  const rawCommits = getRawCommits({ prevTag, cwd })
  if (rawCommits.length === 0) return []

  const { parser: parserOpts, writer: writerOpts } = await conventionalChangelogConventionalCommits()
  const commitParser = new CommitParser(parserOpts)

  const parsed = rawCommits.map(msg => commitParser.parse(msg)).filter(c => c.type)
  if (parsed.length === 0) return []

  const presetTransform = writerOpts.transform
  const writerOptions = {
    ...writerOpts,
    mainTemplate: XML_MAIN_TEMPLATE,
    headerPartial: '',
    commitPartial: '',
    footerPartial: '',
    transform (commit, context) {
      const transformed = presetTransform(commit, context)
      if (!transformed) return null
      if (transformed.notes.length > 0) {
        transformed.isBreaking = true
        return transformed
      }
      transformed.prefix = SECTION_PREFIX[transformed.type] ?? transformed.type
      return transformed
    }
  }

  const output = await writeChangelogString(parsed, { version }, writerOptions)

  const doc = new DOMParser().parseFromString(
    `<ul xmlns="${HTML_NS}">${output}</ul>`,
    'text/xml'
  )
  const liNodes = doc.getElementsByTagNameNS(HTML_NS, 'li')
  const items = []
  for (let i = 0; i < liNodes.length; i++) {
    const text = liNodes.item(i).textContent
    if (text) items.push(text)
  }
  return items
}

export function insertChangeEntry ({ tmplPath, version, items }) {
  const tmpl = readFileSync(tmplPath, 'utf8')
  const doc = new DOMParser().parseFromString(tmpl, 'text/xml')

  const changelog = doc.getElementsByTagNameNS(REPO_NS, 'changelog').item(0)
  if (!changelog) throw new Error(`[repo-xml-changelog-generator] <changelog> not found in ${tmplPath}`)

  const change = doc.createElementNS(REPO_NS, 'change')
  change.setAttribute('version', version)
  change.appendChild(doc.createTextNode('\n            '))

  const ul = doc.createElementNS(HTML_NS, 'ul')
  for (const item of items) {
    ul.appendChild(doc.createTextNode('\n                '))
    const li = doc.createElementNS(HTML_NS, 'li')
    li.textContent = item
    ul.appendChild(li)
  }
  ul.appendChild(doc.createTextNode('\n            '))

  change.appendChild(ul)
  change.appendChild(doc.createTextNode('\n        '))

  let firstChange = null
  for (let i = 0; i < changelog.childNodes.length; i++) {
    if (changelog.childNodes.item(i).nodeType === 1) {
      firstChange = changelog.childNodes.item(i)
      break
    }
  }

  changelog.insertBefore(change, firstChange)
  changelog.insertBefore(doc.createTextNode('\n        '), firstChange)

  writeFileSync(tmplPath, new XMLSerializer().serializeToString(doc))
}
