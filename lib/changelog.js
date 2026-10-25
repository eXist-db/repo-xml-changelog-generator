/**
 * Core changelog logic, factored out of the plugin entry so it can be
 * exercised by unit tests with mock git input.
 *
 * Commit analysis is left entirely to the project's configuration: commits
 * come from semantic-release's `context.commits`, are parsed with the parser
 * options of the configured @semantic-release/commit-analyzer, and are rated
 * by that analyzer. This module only renders the result.
 */

import { readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { analyzeCommits } from '@semantic-release/commit-analyzer'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { CommitParser } from 'conventional-commits-parser'

const REPO_NS = 'http://exist-db.org/xquery/repo'
const HTML_NS = 'http://www.w3.org/1999/xhtml'
const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g
const COMMIT_ANALYZER = '@semantic-release/commit-analyzer'

// Item labels by commit type, in the order items are listed. Other types
// a project's release rules let through keep their literal type.
const TYPE_PREFIX = {
  feat: 'New',
  feature: 'New',
  fix: 'Fix',
  perf: 'Improvement',
  revert: 'Revert'
}
const TYPE_ORDER = Object.keys(TYPE_PREFIX)

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

// Load a conventional-changelog preset the way the commit-analyzer does:
// from the analyzer's own dependencies first, then from the project.
async function importPreset (name, cwd) {
  const bases = [import.meta.resolve(COMMIT_ANALYZER), pathToFileURL(join(cwd, 'package.json')).href]
  for (const base of bases) {
    let path
    try {
      path = createRequire(base).resolve(name)
    } catch {
      continue
    }
    return (await import(pathToFileURL(path).href)).default
  }
  throw new Error(`[repo-xml-changelog-generator] Cannot find module '${name}'`)
}

// The commit-analyzer's parser options for its plugin config (mirrors its
// lib/load-parser-config.js, which it does not export).
async function loadParserOpts ({ preset, config, presetConfig, parserOpts }, cwd) {
  const loaded = preset
    ? await (await importPreset(`conventional-changelog-${preset.toLowerCase()}`, cwd))(presetConfig)
    : await (await importPreset(config ?? 'conventional-changelog-angular', cwd))()
  return { ...loaded.parser, ...parserOpts }
}

/**
 * Analyze the commits of a release with the project's configured
 * commit-analyzer: each commit is parsed with its parser options and rated
 * on its own. Returns the commits that trigger a release, each with its
 * `releaseType` (`major` meaning a breaking change) and `parsed` message.
 */
export async function analyzeChanges ({ commits, options, cwd }) {
  if (!commits?.length) return []
  const config = commitAnalyzerConfig(options)
  const parser = new CommitParser(await loadParserOpts(config, cwd))
  const logger = { log () {} }
  const changes = await Promise.all(commits.map(async commit => ({
    commit,
    releaseType: await analyzeCommits(config, { commits: [commit], options, cwd, logger }),
    // `subject` is git's %s, which folds a hard-wrapped subject paragraph
    // into a single line; parsing the full `message` (%B) would truncate it.
    parsed: parser.parse(`${commit.subject}\n\n${commit.body ?? ''}`.trim())
  })))
  return changes.filter(change => change.releaseType)
}

// Link the issue references the parser found in the subject. References to
// other repositories are left alone, which also covers XQuery function
// arities such as `rutil:getDBUser#0`.
function linkReferences (text, references, linkContext) {
  if (!linkContext) return text
  const { host, owner, repository } = linkContext
  let linked = text
  const seen = new Set()
  for (const { prefix, issue } of references.filter(r => !r.owner && !r.repository)) {
    const ref = `${prefix}${issue}`
    if (seen.has(ref)) continue
    seen.add(ref)
    const pattern = new RegExp(`(?<![\\w/.:-])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'g')
    linked = linked.replace(pattern, `[${ref}](${host}/${owner}/${repository}/issues/${issue})`)
  }
  return linked
}

function sortKey ({ releaseType, parsed }) {
  const type = parsed.revert ? 'revert' : (parsed.type ?? '').toLowerCase()
  const rank = TYPE_ORDER.includes(type) ? TYPE_ORDER.indexOf(type) : TYPE_ORDER.length
  return [releaseType === 'major' ? 0 : 1, rank, type, parsed.scope ?? '', parsed.subject ?? '']
}

function compareKeys (a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

/**
 * Render the analyzed changes (see analyzeChanges) as change items: breaking
 * changes first, then by type, scope and subject. Every item uses the commit
 * subject only; a BREAKING CHANGE footer's text is left to the release notes.
 */
export function buildChangeItems ({ changes, repositoryUrl }) {
  const linkContext = githubContext(repositoryUrl)
  return changes
    .map(change => ({ change, key: sortKey(change) }))
    .sort((a, b) => compareKeys(a.key, b.key))
    .map(({ change: { commit, releaseType, parsed } }) => {
      const type = parsed.revert ? 'revert' : parsed.type?.toLowerCase()
      const label = releaseType === 'major' ? 'Breaking change' : TYPE_PREFIX[type] ?? parsed.type
      // A header the project's parser does not understand is shown as is.
      const text = parsed.subject
        ? `${parsed.scope ? `${parsed.scope}: ` : ''}${parsed.subject}`
        : commit.subject
      const item = label ? `${label}: ${text}` : text
      return linkReferences(item.replace(/\s+/g, ' ').trim(), parsed.references ?? [], linkContext)
    })
}

// Item text may contain markdown links for issue references; render them as
// XHTML anchors.
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
