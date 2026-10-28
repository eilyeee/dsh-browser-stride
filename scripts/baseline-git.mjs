/** Resolve provenance separately from the ancestor used for commit counts. */
export function resolveRepositoryBaselines(fixedUpstream, fixedPublication, git) {
  const validHash = value => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
  const upstreamCommit = validHash(fixedUpstream) ? (git('rev-parse', '--verify', `${fixedUpstream}^{commit}`) ?? null) : null
  const publicationCommit = validHash(fixedPublication) ? (git('rev-parse', '--verify', `${fixedPublication}^{commit}`) ?? null) : null
  const isAncestor = commit => commit !== null && git('merge-base', '--is-ancestor', commit, 'HEAD') !== undefined
  const historyBaselineKind = isAncestor(publicationCommit) ? 'publication' : isAncestor(upstreamCommit) ? 'upstream' : null
  const historyBaselineCommit = historyBaselineKind === 'publication' ? publicationCommit
    : historyBaselineKind === 'upstream' ? upstreamCommit : null
  const count = historyBaselineCommit === null ? undefined : git('rev-list', '--count', `${historyBaselineCommit}..HEAD`)
  return {
    upstreamCommit,
    publicationCommit,
    historyBaselineCommit,
    historyBaselineKind,
    commitsAhead: count !== undefined && /^\d+$/.test(count) ? Number(count) : null,
  }
}
