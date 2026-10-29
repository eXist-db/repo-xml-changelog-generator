/**
 * Core changelog logic, factored out of the plugin entry so it can be
 * exercised by unit tests with mock git input.
 *
 * Commit analysis is left entirely to the project's configuration: commits
 * come from semantic-release's `context.commits`, are parsed with the parser
 * options of the configured @semantic-release/commit-analyzer, and are rated
 * by every configured analyzer. This module only renders the result.
 */

import { readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'

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
 * The entries of semantic-release's `plugins` option as [name, config]
 * pairs, read the way semantic-release reads them: `name` is a module name,
 * a path, or an inline plugin object, and `config` is the entry's options
 * merged over the global options, as semantic-release passes them on.
 */
export function pluginEntries (options = {}) {
  const { plugins = [COMMIT_ANALYZER], ...globalOptions } = options
  return plugins.map(plugin => {
    let name = plugin
    let config
    if (Array.isArray(plugin)) {
      [name, config] = plugin
    } else if (plugin?.constructor === Object && plugin.path != null) {
      ({ path: name, ...config } = plugin)
    }
    return [name, { ...globalOptions, ...config }]
  })
}

// Resolve `name` from the first of `bases` (file URLs) it is found from.
function resolveFrom (bases, name) {
  for (const base of bases) {
    try {
      return createRequire(base).resolve(name)
    } catch {}
  }
  throw new Error(`[repo-xml-changelog-generator] Cannot find module '${name}'`)
}

// Where semantic-release resolves plugins from: its own installation first,
// then the project.
function pluginBases (cwd) {
  const bases = [pathToFileURL(join(cwd, 'package.json')).href]
  try {
    bases.unshift(import.meta.resolve('semantic-release'))
  } catch {}
  return bases
}

async function loadPlugin (bases, name) {
  if (typeof name !== 'string') return name
  const { default: cjsExport, ...esmNamedExports } = await import(pathToFileURL(resolveFrom(bases, name)).href)
  return cjsExport ?? esmNamedExports
}

// Every plugin semantic-release runs in its analyzeCommits step.
async function loadAnalyzers (options, cwd) {
  const bases = pluginBases(cwd)
  const analyzers = []
  for (const [name, config] of pluginEntries(options)) {
    const { analyzeCommits } = await loadPlugin(bases, name) ?? {}
    if (typeof analyzeCommits === 'function') analyzers.push({ name, config, analyzeCommits })
  }
  return analyzers
}

// The parser config loader and conventional-commits-parser of the
// @semantic-release/commit-analyzer semantic-release ships, loaded with the
// analyzer's own import-from-esm, so commits are parsed by the same code
// that rates them.
// Version 13 (semantic-release >= 24) is the first to parse with
// conventional-commits-parser v6, whose CommitParser this plugin uses.
async function loadCommitTools (cwd) {
  const path = resolveFrom(pluginBases(cwd), COMMIT_ANALYZER)
  const dir = dirname(path)
  const { version } = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (Number(version.split('.')[0]) < 13) {
    throw new Error(
      `[repo-xml-changelog-generator] Found ${COMMIT_ANALYZER} ${version}, but version 13 or newer is required.\n` +
      'Upgrade to semantic-release 24 or newer.'
    )
  }
  try {
    const { default: loadParserConfig } = await import(pathToFileURL(join(dir, 'lib', 'load-parser-config.js')).href)
    const { default: importFrom } = await import(pathToFileURL(resolveFrom([pathToFileURL(path).href], 'import-from-esm')).href)
    const { CommitParser } = await importFrom(dir, 'conventional-commits-parser')
    if (typeof loadParserConfig !== 'function' || !CommitParser) {
      throw new Error('unexpected module layout')
    }
    return { loadParserConfig, CommitParser }
  } catch (error) {
    throw new Error(
      `[repo-xml-changelog-generator] Cannot load the commit parser of ${COMMIT_ANALYZER} ${version}: ${error.message}`
    )
  }
}

/**
 * Fail early, before a release is computed, when the commit parser or any
 * of the configured analyzers cannot be loaded.
 */
export async function verifyAnalysis ({ options, cwd = process.cwd() }) {
  await loadCommitTools(cwd)
  await loadAnalyzers(options, cwd)
}

const RELEASE_TYPES = ['patch', 'minor', 'major']
const SKIP_RELEASE = /\[skip\s+release]|\[release\s+skip]/i
const silentLogger = { log () {}, info () {}, warn () {}, error () {}, success () {}, scope () { return this } }

// The highest release type of all analyzers, as semantic-release combines them.
async function rate (analyzers, context) {
  const types = await Promise.all(analyzers.map(({ config, analyzeCommits }) => analyzeCommits(config, context)))
  return RELEASE_TYPES[Math.max(-1, ...types.map(type => RELEASE_TYPES.indexOf(type)))]
}

// Commits reverted within the release, with their reverts, when the
// analyzers drop such a pair: rated together, a pair the analyzers cancel out
// rates no release (commit-analyzer does that), while one they keep rates as
// its higher commit. Newest reverts are paired first, so a revert of a
// revert leaves the original commit in.
async function cancelledReverts (analyzers, context, parsedCommits) {
  const cancelled = new Set()
  for (const revert of parsedCommits) {
    if (!revert.parsed.revert?.hash || cancelled.has(revert)) continue
    const reverted = parsedCommits.find(change =>
      change !== revert && !cancelled.has(change) && change.commit.hash?.startsWith(revert.parsed.revert.hash))
    if (!reverted) continue
    const releaseType = await rate(analyzers, { ...context, commits: [revert.commit, reverted.commit] })
    if (!releaseType) {
      cancelled.add(revert).add(reverted)
    }
  }
  return cancelled
}

/**
 * Analyze the commits of a release the way the project's configuration
 * does: commits marked `[skip release]` are dropped, as semantic-release
 * does, and each remaining commit is rated on its own by every configured
 * analyzer (every plugin with an `analyzeCommits` step). A commit reverted
 * within the release is dropped with its revert when the analyzers cancel
 * the pair out. Commits are parsed with the parser options of
 * @semantic-release/commit-analyzer, or of the first other analyzer when it
 * is not configured. Returns the commits that trigger a release, each with
 * its `releaseType` (`major` meaning a breaking change) and `parsed` message.
 */
export async function analyzeChanges (context) {
  const { commits, options, cwd = process.cwd() } = context
  if (!commits?.length) return []
  const { loadParserConfig, CommitParser } = await loadCommitTools(cwd)
  const analyzers = await loadAnalyzers(options, cwd)
  const { config } = analyzers.find(({ name }) => name === COMMIT_ANALYZER) ?? analyzers[0] ?? {}
  const parser = new CommitParser(await loadParserConfig(config ?? {}, { cwd }))
  const analyzerContext = { ...context, logger: silentLogger }
  const parsedCommits = commits
    .filter(({ message }) => message?.trim() && !SKIP_RELEASE.test(message))
    .map(commit => ({
      commit,
      // `subject` is git's %s, which folds a hard-wrapped subject paragraph
      // into a single line; parsing the full `message` (%B) would truncate it.
      parsed: parser.parse(`${commit.subject}\n\n${commit.body ?? ''}`.trim())
    }))
  const cancelled = await cancelledReverts(analyzers, analyzerContext, parsedCommits)
  const changes = await Promise.all(
    parsedCommits
      .filter(change => !cancelled.has(change))
      .map(async change => ({
        ...change,
        releaseType: await rate(analyzers, { ...analyzerContext, commits: [change.commit] })
      }))
  )
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
      // A revert shows the header it reverts; a header the project's parser
      // does not understand is shown as is.
      const text = parsed.subject
        ? `${parsed.scope ? `${parsed.scope}: ` : ''}${parsed.subject}`
        : parsed.revert?.header ?? commit.subject
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

// The indentation of a node: the whitespace after the last line break of
// the text node before it, or '' if there is none.
function indentOf (node) {
  const previous = node.previousSibling
  if (previous?.nodeType !== 3) return ''
  const match = /\n([ \t]*)$/.exec(previous.data)
  return match ? match[1] : ''
}

export function insertChangeEntry ({ tmplPath, version, items }) {
  const tmpl = readFileSync(tmplPath, 'utf8')
  const doc = new DOMParser().parseFromString(tmpl, 'text/xml')

  const changelog = doc.getElementsByTagNameNS(REPO_NS, 'changelog').item(0)
  if (!changelog) throw new Error(`[repo-xml-changelog-generator] <changelog> not found in ${tmplPath}`)

  // Indent relative to <changelog>, one level being the step from its parent
  // to it. If that can't be told, use the indentation of the first indented
  // line of the descriptor, and four spaces if there is none.
  const indent = indentOf(changelog)
  const parentIndent = changelog.parentNode?.nodeType === 1 ? indentOf(changelog.parentNode) : ''
  const step = indent.startsWith(parentIndent) && indent.length > parentIndent.length
    ? indent.slice(parentIndent.length)
    : /\n([ \t]+)</.exec(tmpl)?.[1] ?? '    '
  const changeIndent = indent + step
  const ulIndent = changeIndent + step
  const liIndent = ulIndent + step

  const change = doc.createElementNS(REPO_NS, 'change')
  change.setAttribute('version', version)
  change.appendChild(doc.createTextNode('\n' + ulIndent))

  const ul = doc.createElementNS(HTML_NS, 'ul')
  for (const item of items) {
    ul.appendChild(doc.createTextNode('\n' + liIndent))
    const li = doc.createElementNS(HTML_NS, 'li')
    appendItemContent(doc, li, item)
    ul.appendChild(li)
  }
  ul.appendChild(doc.createTextNode('\n' + ulIndent))

  change.appendChild(ul)
  change.appendChild(doc.createTextNode('\n' + changeIndent))

  let firstChange = null
  for (let i = 0; i < changelog.childNodes.length; i++) {
    if (changelog.childNodes.item(i).nodeType === 1) {
      firstChange = changelog.childNodes.item(i)
      break
    }
  }

  if (firstChange) {
    // the whitespace before the first entry now goes before the new one
    changelog.insertBefore(change, firstChange)
    changelog.insertBefore(doc.createTextNode('\n' + changeIndent), firstChange)
  } else {
    // first entry: replace the whitespace before the closing tag, so that
    // both the entry and the closing tag are indented
    const last = changelog.lastChild
    if (last?.nodeType === 3 && !last.data.trim()) changelog.removeChild(last)
    changelog.appendChild(doc.createTextNode('\n' + changeIndent))
    changelog.appendChild(change)
    changelog.appendChild(doc.createTextNode('\n' + indent))
  }

  // the serializer drops the whitespace after the root element, including
  // the final line break
  writeFileSync(tmplPath, new XMLSerializer().serializeToString(doc) + '\n')
}
