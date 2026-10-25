/**
 * @existdb/repo-xml-changelog-generator
 *
 * semantic-release plugin that injects a new `<change>` entry into an EXPath
 * package descriptor (typically `repo.xml.tmpl`) based on the Conventional
 * Commits between the previous release tag and the current release.
 *
 * Lifecycle hooks:
 *
 *   verifyConditions(pluginConfig, context)
 *     Confirms the configured descriptor file exists and contains a
 *     `<changelog xmlns="http://exist-db.org/xquery/repo">` element. Fails
 *     fast (before the release is computed) with an actionable error if not.
 *
 *   prepare(pluginConfig, context)
 *     Reads the conventional commits semantic-release collected for this
 *     release (`context.commits`; all commits for a first release), builds
 *     a list of human-readable change items, and inserts a new `<change
 *     version="X.Y.Z">` element with those items at the top of `<changelog>`.
 *     Writes the descriptor back to disk. Whether that mutation stays
 *     in-memory on the CI runner or is committed back to the default branch
 *     (so the changelog accumulates across releases) depends on whether
 *     @semantic-release/git is in the plugin chain — both workflows are
 *     supported. See README for the trade-offs.
 *
 * Config options (all optional):
 *
 *   tmplPath: string  (default: 'repo.xml.tmpl')
 *     Path to the EXPath repo descriptor template, relative to cwd.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { buildChangeItems, findBreakingCommits, insertChangeEntry } from './lib/changelog.js'

const REPO_NS = 'http://exist-db.org/xquery/repo'

function resolveTmplPath (pluginConfig, context) {
  return join(context.cwd ?? process.cwd(), pluginConfig.tmplPath ?? 'repo.xml.tmpl')
}

async function readChangelogContainer (tmplPath) {
  const { readFileSync } = await import('fs')
  const { DOMParser } = await import('@xmldom/xmldom')
  const tmpl = readFileSync(tmplPath, 'utf8')
  const doc = new DOMParser().parseFromString(tmpl, 'text/xml')
  return doc.getElementsByTagNameNS(REPO_NS, 'changelog').item(0)
}

export async function verifyConditions (pluginConfig, context) {
  const { logger } = context
  const tmplPath = resolveTmplPath(pluginConfig, context)

  if (!existsSync(tmplPath)) {
    throw new Error(
      `[repo-xml-changelog-generator] Template not found: ${tmplPath}\n` +
      `Set the \`tmplPath\` plugin option if your descriptor lives elsewhere.`
    )
  }

  const changelog = await readChangelogContainer(tmplPath)
  if (!changelog) {
    throw new Error(
      `[repo-xml-changelog-generator] No <changelog xmlns="${REPO_NS}"> element found in ${tmplPath}.\n` +
      `Add an empty <changelog/> child inside <meta> to enable change-entry injection.`
    )
  }

  logger.log(`[repo-xml-changelog-generator] verified ${tmplPath}`)
}

export async function prepare (pluginConfig, context) {
  const { logger, lastRelease, nextRelease } = context
  const tmplPath = resolveTmplPath(pluginConfig, context)

  const items = await buildChangeItems({
    commits: context.commits,
    breaking: await findBreakingCommits(context),
    version: nextRelease.version,
    repositoryUrl: context.options?.repositoryUrl
  })

  if (items.length === 0) {
    const since = lastRelease?.gitTag ? ` since ${lastRelease.gitTag}` : ''
    logger.log(`[repo-xml-changelog-generator] No notable commits${since} — skipping.`)
    return
  }

  insertChangeEntry({
    tmplPath,
    version: nextRelease.version,
    items
  })

  logger.log(`[repo-xml-changelog-generator] inserted ${items.length} change item(s) for ${nextRelease.version} into ${tmplPath}`)
}
