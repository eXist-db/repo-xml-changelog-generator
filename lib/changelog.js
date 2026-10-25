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
const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g
// Attribution trailers that would otherwise be read as part of a preceding
// BREAKING CHANGE note.
const ATTRIBUTION_TRAILER = /^\s*(Co-authored-by|Signed-off-by|Reviewed-by|Claude-Session):/i

const SECTION_PREFIX = {
  Features: 'New',
  'Bug Fixes': 'Fix',
  'Performance Improvements': 'Improvement',
  Reverts: 'Revert'
}

function escapeXml (text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Replaces the writer's default markdown template (conventional-changelog-writer
// v9+ takes a template function, no longer a handlebars string).
function xmlTemplate (context) {
  const lines = []
  for (const group of context.noteGroups ?? []) {
    for (const note of group.notes) {
      lines.push(`<li>Breaking change: ${escapeXml(note.text)}</li>`)
    }
  }
  for (const group of context.commitGroups ?? []) {
    for (const commit of group.commits) {
      if (commit.isBreaking) continue
      const scope = commit.scope ? `${commit.scope}: ` : ''
      lines.push(`<li>${escapeXml(`${commit.prefix}: ${scope}${commit.subject}`)}</li>`)
    }
  }
  return lines.join('\n')
}

/**
 * Derive the {host, owner, repository} link context from a repository URL
 * (semantic-release's `context.options.repositoryUrl`). Returns null when
 * the URL is not a recognizable GitHub remote; issue references are then
 * left as plain text instead of rendered with broken URLs.
 */
export function githubContext (repositoryUrl) {
  const m = (repositoryUrl ?? '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!m) return null
  return { host: 'https://github.com', owner: m[1], repository: m[2] }
}

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

  // %s folds a hard-wrapped subject paragraph into a single line; %B would
  // keep the line break and the parser would truncate the subject there.
  return hashes.map(hash =>
    execSync(`git log -1 --format=%s%n%n%b ${hash}`, { encoding: 'utf8', cwd })
      .split('\n').filter(line => !ATTRIBUTION_TRAILER.test(line)).join('\n').trim()
  )
}

export async function buildChangeItems ({ prevTag, version, cwd, repositoryUrl }) {
  const rawCommits = getRawCommits({ prevTag, cwd })
  if (rawCommits.length === 0) return []

  const { parser: parserOpts, writer: writerOpts } = await conventionalChangelogConventionalCommits()
  const commitParser = new CommitParser(parserOpts)

  const parsed = rawCommits.map(msg => commitParser.parse(msg)).filter(c => c.type)
  if (parsed.length === 0) return []

  const presetTransform = writerOpts.transform
  const writerOptions = {
    ...writerOpts,
    template: xmlTemplate,
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

  const linkContext = githubContext(repositoryUrl)
  const output = await writeChangelogString(parsed, { version, ...linkContext }, writerOptions)

  const doc = new DOMParser().parseFromString(
    `<ul xmlns="${HTML_NS}">${output}</ul>`,
    'text/xml'
  )
  const liNodes = doc.getElementsByTagNameNS(HTML_NS, 'li')
  const items = []
  for (let i = 0; i < liNodes.length; i++) {
    // Collapse line breaks left over from hard-wrapped BREAKING CHANGE footers.
    let text = liNodes.item(i).textContent.replace(/\s+/g, ' ').trim()
    if (!linkContext) {
      // Without a link context the preset renders references as markdown
      // links with `undefined` URLs — reduce them to their label text.
      text = text.replace(MD_LINK, '$1')
    }
    if (text) items.push(text)
  }
  return items
}

// Item text may contain markdown links produced by the conventional-changelog
// preset (issue refs, mentions); render them as XHTML anchors.
function appendItemContent (doc, li, text) {
  let last = 0
  for (const match of text.matchAll(MD_LINK)) {
    if (match.index > last) {
      li.appendChild(doc.createTextNode(text.slice(last, match.index)))
    }
    const a = doc.createElementNS(HTML_NS, 'a')
    a.setAttribute('href', match[2])
    a.appendChild(doc.createTextNode(match[1]))
    li.appendChild(a)
    last = match.index + match[0].length
  }
  if (last < text.length) {
    li.appendChild(doc.createTextNode(text.slice(last)))
  }
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
    appendItemContent(doc, li, item)
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
