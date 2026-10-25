/**
 * Core changelog logic, factored out of the plugin entry so it can be
 * exercised by unit tests with mock git input.
 *
 * Lifted from eXist-db/semver.xq's update-repo-changelog.js and adapted
 * to the semantic-release plugin shape: commits come from semantic-release's
 * `context.commits` rather than from git directly.
 */

import { readFileSync, writeFileSync } from 'fs'
import { analyzeCommits } from '@semantic-release/commit-analyzer'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { CommitParser } from 'conventional-commits-parser'
import { writeChangelogString } from 'conventional-changelog-writer'
import conventionalChangelogConventionalCommits from 'conventional-changelog-conventionalcommits'

const REPO_NS = 'http://exist-db.org/xquery/repo'
const HTML_NS = 'http://www.w3.org/1999/xhtml'
const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g
// The preset links every `#<word>`, including XQuery function arities such
// as `semver:sort#3`; a reference directly after a word character is none.
const ARITY_LINK = /(\w)\[(#[^\]]+)\]\([^)\s]+\)/g
const COMMIT_ANALYZER = '@semantic-release/commit-analyzer'

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
// v9+ takes a template function, no longer a handlebars string). Every item
// is rendered from the commit subject only, breaking changes first: the
// BREAKING CHANGE footer marks a commit as breaking, but its text (which can
// be long) is left to the release notes.
function xmlTemplate (context) {
  const commits = (context.commitGroups ?? []).flatMap(group => group.commits)
  const item = (prefix, commit) => {
    const scope = commit.scope ? `${commit.scope}: ` : ''
    return `<li>${escapeXml(`${prefix}: ${scope}${commit.subject}`)}</li>`
  }
  return [
    ...commits.filter(c => c.isBreaking).map(c => item('Breaking change', c)),
    ...commits.filter(c => !c.isBreaking).map(c => item(c.prefix, c))
  ].join('\n')
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

/**
 * The options semantic-release hands the configured commit-analyzer: the
 * global options, overridden by those of its entry in `plugins`. Without
 * such an entry the analyzer runs with its defaults.
 */
export function commitAnalyzerConfig (options = {}) {
  const { plugins = [], ...globalOptions } = options
  const entry = plugins
    .map(plugin => Array.isArray(plugin) ? plugin : [plugin, {}])
    .find(([name]) => name === COMMIT_ANALYZER)
  return { ...globalOptions, ...entry?.[1] }
}

/**
 * Hashes of the commits the configured commit-analyzer rates as a major
 * release — what this project considers a breaking change.
 */
export async function findBreakingCommits ({ commits, options, cwd }) {
  const config = commitAnalyzerConfig(options)
  const logger = { log () {} }
  const releaseTypes = await Promise.all((commits ?? []).map(commit =>
    analyzeCommits(config, { commits: [commit], options, cwd, logger })
  ))
  return new Set(commits.filter((_, i) => releaseTypes[i] === 'major').map(c => c.hash))
}

/**
 * Build the change items for a release from semantic-release's
 * `context.commits` (git-log-parser objects with `subject` and `body`).
 * `breaking` holds the hashes of breaking commits (see findBreakingCommits).
 */
export async function buildChangeItems ({ commits, breaking = new Set(), version, repositoryUrl }) {
  // `subject` is git's %s, which folds a hard-wrapped subject paragraph into
  // a single line; the full `message` (%B) would keep the line break and the
  // parser would truncate the subject there.
  if (!commits?.length) return []

  const { parser: parserOpts, writer: writerOpts } = await conventionalChangelogConventionalCommits()
  const commitParser = new CommitParser(parserOpts)

  const parsed = commits
    .map(c => ({ ...commitParser.parse(`${c.subject}\n\n${c.body ?? ''}`.trim()), hash: c.hash }))
    .filter(c => c.type)
  if (parsed.length === 0) return []

  const presetTransform = writerOpts.transform
  const writerOptions = {
    ...writerOpts,
    template: xmlTemplate,
    transform (commit, context) {
      // The commit-analyzer decides what is breaking, not this preset. The
      // preset keeps commits of hidden types (refactor, chore, …) only when
      // they carry notes, so align their notes with the analyzer's verdict.
      const isBreaking = breaking.has(commit.hash)
      const notes = !isBreaking ? []
        : commit.notes.length ? commit.notes : [{ title: 'BREAKING CHANGE', text: '' }]
      const transformed = presetTransform({ ...commit, notes }, context)
      if (!transformed) return null
      transformed.isBreaking = isBreaking
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
    let text = liNodes.item(i).textContent.replace(/\s+/g, ' ').trim()
      .replace(ARITY_LINK, '$1$2')
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
