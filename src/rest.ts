// REST v3 API under /api/v3: user, meta, repos, contents, labels, issues, pulls, merge.
import type http from 'node:http'
import { parseCommit, parseTree, isDirMode } from './objects.ts'
import type { Store, Repo, IssueRec, PullRec } from './store.ts'

const SCOPES = 'repo, delete_repo, workflow'
const DOC_URL = 'https://docs.github.com/rest'

function sendJson(res: http.ServerResponse, store: Store, status: number, obj: unknown, extra: Record<string, string> = {}): void {
  if (status === 204) {
    res.writeHead(204, {
      'X-GitHub-Request-Id': store.nextRequestId(),
      'X-OAuth-Scopes': SCOPES,
      ...extra,
    })
    res.end()
    return
  }
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': store.nextRequestId(),
    'X-OAuth-Scopes': SCOPES,
    'Content-Length': String(body.length),
    ...extra,
  })
  res.end(body)
}

function notFound(res: http.ServerResponse, store: Store, message = 'Not Found'): void {
  sendJson(res, store, 404, { message, documentation_url: DOC_URL })
}

function validationFailed(res: http.ServerResponse, store: Store, message = 'Validation Failed', errors: unknown[] = []): void {
  sendJson(res, store, 422, { message, documentation_url: DOC_URL, errors })
}

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null
}

export function userJson(store: Store): Record<string, unknown> {
  return {
    login: store.login,
    id: 1,
    node_id: store.nodeId('User', 1),
    type: 'User',
    name: 'Forge User',
    email: 'forge@forge.local',
    avatar_url: '',
    url: '',
    html_url: '',
    created_at: new Date(0).toISOString(),
  }
}

export function repoJson(store: Store, repo: Repo, baseUrl: string): Record<string, unknown> {
  const owner = userJson(store)
  const full = repo.fullName
  let openIssues = 0
  for (const i of repo.issues.values()) if (i.state === 'open') openIssues += 1
  return {
    id: repo.dbId,
    node_id: store.nodeId('Repository', repo.dbId),
    name: repo.name,
    full_name: full,
    private: repo.isPrivate,
    owner,
    html_url: `${baseUrl}/${full}`,
    description: repo.description,
    fork: false,
    url: `${baseUrl}/api/v3/repos/${full}`,
    created_at: iso(repo.createdAt),
    updated_at: iso(repo.updatedAt),
    pushed_at: iso(repo.pushedAt),
    git_url: '',
    ssh_url: '',
    clone_url: `${baseUrl}/${full}.git`,
    size: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    permissions: { admin: true, push: true, pull: true },
  }
}

function issueJson(store: Store, repo: Repo, issue: IssueRec, baseUrl: string): Record<string, unknown> {
  const full = repo.fullName
  return {
    id: issue.dbId,
    node_id: store.nodeId('Issue', issue.dbId),
    url: `${baseUrl}/api/v3/repos/${full}/issues/${issue.number}`,
    repository_url: `${baseUrl}/api/v3/repos/${full}`,
    html_url: `${baseUrl}/${full}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    user: userJson(store),
    labels: issue.labels.map((name) => {
      const l = repo.labels.get(name)!
      return { id: l.dbId, node_id: store.nodeId('Label', l.dbId), name: l.name, color: l.color, default: false }
    }),
    state: issue.state,
    locked: false,
    assignee: null,
    assignees: [],
    comments: issue.comments,
    created_at: iso(issue.createdAt),
    updated_at: iso(issue.updatedAt),
    closed_at: iso(issue.closedAt),
    author_association: 'OWNER',
  }
}

function pullJson(store: Store, repo: Repo, pull: PullRec, baseUrl: string): Record<string, unknown> {
  const full = repo.fullName
  const repoObj = repoJson(store, repo, baseUrl)
  const headSha = repo.branchSha(pull.headRef) ?? pull.headSha
  const mergeable = pull.merged ? 'unknown' : store.isConflicted(repo, pull) ? 'conflicting' : 'mergeable'
  return {
    id: pull.dbId,
    node_id: store.nodeId('PullRequest', pull.dbId),
    url: `${baseUrl}/api/v3/repos/${full}/pulls/${pull.number}`,
    html_url: `${baseUrl}/${full}/pull/${pull.number}`,
    diff_url: `${baseUrl}/${full}/pull/${pull.number}.diff`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(store),
    labels: [],
    head: { label: `${store.login}:${pull.headRef}`, ref: pull.headRef, sha: headSha, repo: repoObj },
    base: { label: `${store.login}:${pull.baseRef}`, ref: pull.baseRef, sha: pull.baseSha, repo: repoObj },
    mergeable,
    merged: pull.merged,
    mergeable_state: pull.merged ? 'clean' : mergeable === 'conflicting' ? 'dirty' : 'clean',
    merged_at: iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    comments: 0,
    commits: 1,
    created_at: iso(pull.createdAt),
    updated_at: iso(pull.updatedAt),
    closed_at: pull.state === 'closed' ? iso(pull.mergedAt ?? pull.updatedAt) : null,
    author_association: 'OWNER',
  }
}

function labelJson(store: Store, repo: Repo, name: string, baseUrl: string): Record<string, unknown> {
  const l = repo.labels.get(name)!
  return {
    id: l.dbId,
    node_id: store.nodeId('Label', l.dbId),
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(name)}`,
    name: l.name,
    color: l.color,
    default: false,
    description: null,
  }
}

function commitJson(store: Store, repo: Repo, sha: string, baseUrl: string): Record<string, unknown> {
  const rec = store.objects.get(sha)
  const c = rec ? parseCommit(rec.data) : null
  const parseIdent = (ident: string): Record<string, unknown> => {
    const m = ident.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/)
    if (!m) return { name: 'Forge', email: 'forge@forge.local', date: new Date(0).toISOString() }
    return { name: m[1], email: m[2], date: new Date(parseInt(m[3], 10) * 1000).toISOString() }
  }
  return {
    sha,
    node_id: sha,
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/commits/${sha}`,
    html_url: `${baseUrl}/${repo.fullName}/commit/${sha}`,
    commit: {
      author: c ? parseIdent(c.author) : {},
      committer: c ? parseIdent(c.committer) : {},
      message: c ? c.message.replace(/\n$/, '') : '',
      tree: { sha: c ? c.tree : '', url: '' },
    },
    author: userJson(store),
    committer: userJson(store),
    message: c ? c.message.replace(/\n$/, '') : '',
    tree: { sha: c ? c.tree : '', url: '' },
    parents: (c ? c.parents : []).map((p) => ({ sha: p, url: '' })),
  }
}

function contentsJson(store: Store, repo: Repo, branch: string, path: string, entry: { mode: string; sha: string }, withContent: boolean, baseUrl: string): Record<string, unknown> {
  const rec = store.objects.get(entry.sha)!
  const name = path.split('/').filter(Boolean).pop() ?? ''
  const isDir = entry.mode === '40000' || entry.mode === '040000'
  const out: Record<string, unknown> = {
    name,
    path,
    sha: entry.sha,
    size: isDir ? 0 : rec.data.length,
    url: `${baseUrl}/api/v3/repos/${repo.fullName}/contents/${path}?ref=${branch}`,
    html_url: `${baseUrl}/${repo.fullName}/blob/${branch}/${path}`,
    git_url: '',
    download_url: isDir ? null : `${baseUrl}/${repo.fullName}/raw/${branch}/${path}`,
    type: isDir ? 'dir' : 'file',
    _links: { self: '', git: '', html: '' },
    encoding: isDir ? null : 'base64',
  }
  if (withContent && !isDir) {
    out.content = rec.data.toString('base64')
  }
  return out
}

function paginate(
  store: Store,
  res: http.ServerResponse,
  status: number,
  all: unknown[],
  query: URLSearchParams,
  baseNoQuery: string,
  extraQuery: Record<string, string>,
): void {
  const perPage = Math.min(Math.max(parseInt(query.get('per_page') ?? '30', 10) || 30, 1), 100)
  const page = Math.max(parseInt(query.get('page') ?? '1', 10) || 1, 1)
  const start = (page - 1) * perPage
  const slice = all.slice(start, start + perPage)
  const extra: Record<string, string> = {}
  if (start + perPage < all.length) {
    const q = new URLSearchParams({ ...extraQuery, per_page: String(perPage), page: String(page + 1) })
    extra.Link = `<${baseNoQuery}?${q.toString()}>; rel="next"`
  }
  sendJson(res, store, status, slice, extra)
}

function tsSec(store: Store): number {
  store.clock += 1000
  return Math.floor(store.clock / 1000)
}

export function handleRest(
  store: Store,
  method: string,
  segs: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  baseUrl: string,
  res: http.ServerResponse,
): boolean {
  // repo shorthand
  const getRepo = (): Repo | null => {
    if (segs[0] !== 'repos' || segs.length < 3) return null
    return store.getRepo(decodeURIComponent(segs[1]), decodeURIComponent(segs[2]))
  }
  const afterRepo = (): string[] => segs.slice(3)

  // GET /api/v3/ -> authenticated user
  if (segs.length === 0) {
    if (method !== 'GET') {
      notFound(res, store)
      return true
    }
    sendJson(res, store, 200, userJson(store))
    return true
  }
  if (segs[0] === 'meta') {
    sendJson(res, store, 200, { installed_version: '3.15.2' })
    return true
  }
  if (segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0)
      paginate(
        store,
        res,
        200,
        all.map((r) => repoJson(store, r, baseUrl)),
        query,
        `${baseUrl}/api/v3/user/repos`,
        {},
      )
      return true
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'Repository', field: 'name', code: 'invalid' }])
        return true
      }
      if (store.getRepo(store.login, name)) {
        validationFailed(res, store, 'name already exists on this account', [{ resource: 'Repository', field: 'name', code: 'custom' }])
        return true
      }
      const description = typeof body?.description === 'string' ? body.description : ''
      const isPrivate = body?.private === true
      const repo = store.createRepo(name, description, isPrivate)
      if (body?.auto_init === true) {
        store.writeFile(repo, repo.defaultBranch, 'README.md', Buffer.from(`# ${name}\n`), 'Initial commit', tsSec(store))
        repo.pushedAt = repo.updatedAt
      }
      sendJson(res, store, 201, repoJson(store, repo, baseUrl))
      return true
    }
    notFound(res, store)
    return true
  }
  if (segs[0] === 'user') {
    if (method === 'GET' && segs.length === 1) {
      sendJson(res, store, 200, userJson(store))
      return true
    }
    notFound(res, store)
    return true
  }

  const repo = getRepo()
  if (segs[0] === 'repos' && !repo) {
    if (segs.length === 3 || (segs.length >= 3 && !store.getRepo(decodeURIComponent(segs[1]), decodeURIComponent(segs[2])))) {
      notFound(res, store)
      return true
    }
  }
  if (!repo) {
    notFound(res, store)
    return true
  }
  const rest = afterRepo()

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, store, 200, repoJson(store, repo, baseUrl))
      return true
    }
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private
      if (typeof body?.default_branch === 'string') repo.defaultBranch = body.default_branch
      if (typeof body?.name === 'string' && body.name && body.name !== repo.name) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'Repository', field: 'name', code: 'invalid' }])
        return true
      }
      repo.updatedAt = store.tick()
      sendJson(res, store, 200, repoJson(store, repo, baseUrl))
      return true
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.fullName)
      sendJson(res, store, 204, null)
      return true
    }
    notFound(res, store)
    return true
  }

  // git/refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST') {
      const refName = typeof body?.ref === 'string' ? body.ref : ''
      const sha = typeof body?.sha === 'string' ? body.sha : ''
      if (!refName || !sha || !store.objects.has(sha)) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'Reference', field: 'sha', code: 'invalid' }])
        return true
      }
      repo.setRef(refName, sha)
      repo.updatedAt = store.tick()
      repo.pushedAt = repo.updatedAt
      sendJson(res, store, 201, {
        ref: refName,
        node_id: store.nodeId('Ref', repo.dbId),
        url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/${refName}`,
        object: {
          sha,
          type: 'commit',
          url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
        },
      })
      return true
    }
    if (method === 'GET') {
      const sub = rest.slice(2).join('/')
      const fullRef = sub.startsWith('refs/') ? sub : sub ? `refs/${sub}` : ''
      const sha = repo.refs.get(fullRef) ?? repo.branchSha(sub.replace(/^heads\//, ''))
      if (!sha) {
        notFound(res, store)
        return true
      }
      sendJson(res, store, 200, {
        ref: fullRef || `refs/heads/${sub}`,
        node_id: store.nodeId('Ref', repo.dbId),
        url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/${fullRef || `refs/heads/${sub}`}`,
        object: {
          sha,
          type: 'commit',
          url: `${baseUrl}/api/v3/repos/${repo.fullName}/git/commits/${sha}`,
        },
      })
      return true
    }
  }

  // branches
  if (rest[0] === 'branches' && method === 'GET') {
    if (rest.length === 1) {
      const branches: Array<Record<string, unknown>> = []
      for (const [refName, sha] of repo.refs) {
        if (refName.startsWith('refs/heads/')) {
          const name = refName.slice('refs/heads/'.length)
          branches.push({
            name,
            commit: { sha, url: `${baseUrl}/api/v3/repos/${repo.fullName}/commits/${sha}` },
            protected: false,
          })
        }
      }
      sendJson(res, store, 200, branches)
      return true
    }
    const sha = repo.branchSha(decodeURIComponent(rest[1]))
    if (!sha) {
      notFound(res, store)
      return true
    }
    sendJson(res, store, 200, { name: rest[1], commit: { sha, commit: commitJson(store, repo, sha, baseUrl), url: '' }, protected: false })
    return true
  }

  // commits
  if (rest[0] === 'commits' && method === 'GET') {
    const branch = query.get('sha') ?? repo.defaultBranch
    const tip = repo.branchSha(branch) ?? repo.refs.get(branch) ?? null
    if (!tip) {
      notFound(res, store)
      return true
    }
    const out: unknown[] = []
    const seen = new Set<string>([tip])
    const q = [tip]
    while (q.length && out.length < 200) {
      const c = q.shift()!
      out.push(commitJson(store, repo, c, baseUrl))
      const rec = store.objects.get(c)
      if (!rec) continue
      for (const p of parseCommit(rec.data).parents) {
        if (!seen.has(p)) {
          seen.add(p)
          q.push(p)
        }
      }
    }
    paginate(store, res, 200, out, query, `${baseUrl}/api/v3/repos/${repo.fullName}/commits`, { sha: branch })
    return true
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const sha = decodeURIComponent(rest[1])
    if (!store.objects.has(sha)) {
      notFound(res, store)
      return true
    }
    sendJson(res, store, 200, commitJson(store, repo, sha, baseUrl))
    return true
  }

  // contents
  if (rest[0] === 'contents') {
    const refParam = query.get('ref') ?? repo.defaultBranch
    const branch = repo.branchSha(refParam) !== null ? refParam : repo.defaultBranch
    if (rest.length === 1 && method === 'GET') {
      const tip = repo.branchSha(branch)
      if (!tip) {
        notFound(res, store, 'No commit found for the ref ' + branch)
        return true
      }
      const entries = store.listDir(repo, branch, '')
      paginate(store, res, 200, entries.map((e) => contentsJson(store, repo, branch, e.name, e, false, baseUrl)), query, `${baseUrl}/api/v3/repos/${repo.fullName}/contents`, { ref: branch })
      return true
    }
    const path = rest.slice(1).map(decodeURIComponent).join('/')
    if (method === 'GET') {
      const tip = repo.branchSha(branch)
      if (!tip) {
        notFound(res, store, 'No commit found for the ref ' + branch)
        return true
      }
      const entry = store.fileAt(repo, branch, path)
      if (entry && !isDirMode(entry.mode)) {
        sendJson(res, store, 200, contentsJson(store, repo, branch, path, entry, true, baseUrl))
        return true
      }
      const dirEntries = dirEntriesOf(store, repo, branch, path)
      if (dirEntries !== null) {
        sendJson(res, store, 200, dirEntries.map((e) => contentsJson(store, repo, branch, path === '' ? e.name : `${path}/${e.name}`, e, false, baseUrl)))
        return true
      }
      notFound(res, store, 'No commit found for the ref ' + branch)
      return true
    }
    if (method === 'PUT') {
      const message = typeof body?.message === 'string' ? body.message : ''
      const content = typeof body?.content === 'string' ? body.content : null
      const branchParam = typeof body?.branch === 'string' && body.branch ? body.branch : repo.defaultBranch
      const sha = typeof body?.sha === 'string' ? body.sha : null
      if (!message || content === null) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'Contents', field: 'message', code: 'missing_field' }])
        return true
      }
      const current = store.fileAt(repo, branchParam, path)
      const data = Buffer.from(content, 'base64')
      if (current && !sha) {
        validationFailed(res, store, `sha must be specified for updated files`, [{ resource: 'Contents', field: 'sha', code: 'missing_field' }])
        return true
      }
      if (current && sha && sha !== current.sha) {
        sendJson(res, store, 409, { message: `${path} does not match ${sha}`, documentation_url: DOC_URL })
        return true
      }
      if (!current && sha) {
        validationFailed(res, store, `sha was not found for ${path}`, [{ resource: 'Contents', field: 'sha', code: 'invalid' }])
        return true
      }
      const result = store.writeFile(repo, branchParam, path, data, message, tsSec(store))
      repo.updatedAt = store.tick()
      repo.pushedAt = repo.updatedAt
      const entry = store.fileAt(repo, branchParam, path)!
      sendJson(res, store, current ? 200 : 201, {
        content: contentsJson(store, repo, branchParam, path, entry, false, baseUrl),
        commit: commitJson(store, repo, result.commit, baseUrl),
      })
      return true
    }
    if (method === 'DELETE') {
      const sha = typeof body?.sha === 'string' ? body.sha : null
      const branchParam = typeof body?.branch === 'string' && body.branch ? body.branch : repo.defaultBranch
      const current = store.fileAt(repo, branchParam, path)
      if (!current) {
        notFound(res, store)
        return true
      }
      if (!sha || sha !== current.sha) {
        sendJson(res, store, 409, { message: `${path} does not match ${sha ?? ''}`, documentation_url: DOC_URL })
        return true
      }
      const result = store.writeFile(repo, branchParam, path, null, typeof body?.message === 'string' ? body.message : `Delete ${path}`, tsSec(store))
      repo.updatedAt = store.tick()
      repo.pushedAt = repo.updatedAt
      sendJson(res, store, 200, { content: null, commit: commitJson(store, repo, result.commit, baseUrl) })
      return true
    }
    notFound(res, store)
    return true
  }

  // labels
  if (rest[0] === 'labels') {
    if (rest.length === 1 && method === 'GET') {
      const all = [...repo.labels.keys()].sort()
      paginate(store, res, 200, all.map((n) => labelJson(store, repo, n, baseUrl)), query, `${baseUrl}/api/v3/repos/${repo.fullName}/labels`, {})
      return true
    }
    if (rest.length === 1 && method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name.trim() : ''
      if (!name) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'Label', field: 'name', code: 'missing_field' }])
        return true
      }
      if (repo.labels.has(name)) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'Label', field: 'name', code: 'already_exists' }])
        return true
      }
      const color = typeof body?.color === 'string' && body.color ? body.color : 'ededed'
      repo.labels.set(name, { dbId: (store.labelId += 1), name, color })
      sendJson(res, store, 201, labelJson(store, repo, name, baseUrl))
      return true
    }
    if (rest.length === 2 && method === 'GET') {
      const name = decodeURIComponent(rest[1])
      if (!repo.labels.has(name)) {
        notFound(res, store)
        return true
      }
      sendJson(res, store, 200, labelJson(store, repo, name, baseUrl))
      return true
    }
    notFound(res, store)
    return true
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'GET') {
      const stateFilter = query.get('state') ?? 'open'
      const labelsFilter = query.get('labels')
      let all = [...repo.issues.values()].filter((i) => (stateFilter === 'all' ? true : i.state === stateFilter))
      if (labelsFilter) {
        const wanted = labelsFilter.split(',').filter(Boolean)
        all = all.filter((i) => wanted.every((w) => i.labels.includes(w)))
      }
      const dir = (query.get('direction') ?? 'asc').toLowerCase()
      all.sort((a, b) => (dir === 'desc' ? b.number - a.number : a.number - b.number))
      paginate(store, res, 200, all.map((i) => issueJson(store, repo, i, baseUrl)), query, `${baseUrl}/api/v3/repos/${repo.fullName}/issues`, { state: stateFilter })
      return true
    }
    if (rest.length === 1 && method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : ''
      if (!title) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'Issue', field: 'title', code: 'missing_field' }])
        return true
      }
      const labels = Array.isArray(body?.labels) ? (body.labels as unknown[]).map((x) => (typeof x === 'string' ? x : (x as { name?: string })?.name ?? '')) : []
      for (const l of labels) {
        if (!repo.labels.has(l)) {
          validationFailed(res, store, 'Validation Failed', [{ resource: 'Issue', field: 'labels', code: 'invalid' }])
          return true
        }
      }
      repo.numSeq += 1
      const when = store.tick()
      const issue: IssueRec = {
        dbId: (store.issueId += 1),
        number: repo.numSeq,
        title,
        body: typeof body?.body === 'string' ? body.body : '',
        state: 'open',
        labels,
        createdAt: when,
        updatedAt: when,
        closedAt: null,
        comments: 0,
        commentsList: [],
      }
      repo.issues.set(issue.number, issue)
      store.nodes.set(store.nodeId('Issue', issue.dbId), { kind: 'Issue', repo, id: issue.dbId })
      sendJson(res, store, 201, issueJson(store, repo, issue, baseUrl))
      return true
    }
    const num = parseInt(rest[1], 10)
    const issue = Number.isFinite(num) ? repo.issues.get(num) : undefined
    if (!issue) {
      notFound(res, store)
      return true
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, store, 200, issueJson(store, repo, issue, baseUrl))
      return true
    }
    if (rest.length === 2 && method === 'PATCH') {
      if (typeof body?.title === 'string' && body.title) issue.title = body.title
      if (typeof body?.body === 'string') issue.body = body.body
      if (body?.state === 'open' || body?.state === 'closed') {
        issue.state = body.state
        issue.closedAt = body.state === 'closed' ? store.tick() : null
      }
      if (Array.isArray(body?.labels)) {
        const labels = (body.labels as unknown[]).map((x) => (typeof x === 'string' ? x : (x as { name?: string })?.name ?? ''))
        for (const l of labels) {
          if (!repo.labels.has(l)) {
            validationFailed(res, store, 'Validation Failed', [{ resource: 'Issue', field: 'labels', code: 'invalid' }])
            return true
          }
        }
        issue.labels = labels
      }
      issue.updatedAt = store.tick()
      sendJson(res, store, 200, issueJson(store, repo, issue, baseUrl))
      return true
    }
    if (rest.length === 3 && rest[2] === 'comments' && method === 'GET') {
      const list = (issue.commentsList ?? []).map((c) => ({
        id: c.id,
        node_id: store.nodeId('IssueComment', c.id),
        url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues/comments/${c.id}`,
        html_url: `${baseUrl}/${repo.fullName}/issues/${issue.number}#issuecomment-${c.id}`,
        body: c.body,
        user: userJson(store),
        created_at: iso(c.createdAt),
        updated_at: iso(c.updatedAt),
      }))
      sendJson(res, store, 200, list)
      return true
    }
    if (rest.length === 3 && rest[2] === 'comments' && method === 'POST') {
      const commentBody = typeof body?.body === 'string' ? body.body : ''
      if (!commentBody) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'IssueComment', field: 'body', code: 'missing_field' }])
        return true
      }
      const when = store.tick()
      const commentId = (store.commentId += 1)
      const comment = { id: commentId, body: commentBody, createdAt: when, updatedAt: when }
      if (!issue.commentsList) issue.commentsList = []
      issue.commentsList.push(comment)
      issue.comments = issue.commentsList.length
      issue.updatedAt = when
      sendJson(res, store, 201, {
        id: comment.id,
        node_id: store.nodeId('IssueComment', comment.id),
        url: `${baseUrl}/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
        html_url: `${baseUrl}/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
        body: comment.body,
        user: userJson(store),
        created_at: iso(comment.createdAt),
        updated_at: iso(comment.updatedAt),
      })
      return true
    }
    notFound(res, store)
    return true
  }

  // pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'GET') {
      const stateFilter = (query.get('state') ?? 'open').toLowerCase()
      const all = [...repo.pulls.values()]
        .filter((p) => {
          if (stateFilter === 'all') return true
          if (stateFilter === 'closed') return p.state === 'closed'
          return p.state === 'open' && !p.merged
        })
        .sort((a, b) => a.number - b.number)
      paginate(store, res, 200, all.map((p) => pullJson(store, repo, p, baseUrl)), query, `${baseUrl}/api/v3/repos/${repo.fullName}/pulls`, { state: stateFilter })
      return true
    }
    if (rest.length === 1 && method === 'POST') {
      const title = typeof body?.title === 'string' ? body.title : ''
      const head = typeof body?.head === 'string' ? body.head : ''
      const base = typeof body?.base === 'string' ? body.base : ''
      if (!title || !head || !base) {
        validationFailed(res, store, 'Validation Failed', [{ resource: 'PullRequest', field: 'title', code: 'missing_field' }])
        return true
      }
      const headSha = repo.branchSha(head)
      const baseSha = repo.branchSha(base)
      if (!headSha || !baseSha) {
        validationFailed(res, store, `Head branch ${head} does not exist`, [{ resource: 'PullRequest', field: 'head', code: 'invalid' }])
        return true
      }
      repo.numSeq += 1
      const when = store.tick()
      const pull: PullRec = {
        dbId: (store.pullId += 1),
        number: repo.numSeq,
        title,
        body: typeof body?.body === 'string' ? body.body : '',
        state: 'open',
        merged: false,
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
        mergeCommitSha: null,
        mergedAt: null,
        createdAt: when,
        updatedAt: when,
      }
      repo.pulls.set(pull.number, pull)
      store.nodes.set(store.nodeId('PullRequest', pull.dbId), { kind: 'PullRequest', repo, id: pull.dbId })
      sendJson(res, store, 201, pullJson(store, repo, pull, baseUrl))
      return true
    }
    const num = parseInt(rest[1], 10)
    const pull = Number.isFinite(num) ? repo.pulls.get(num) : undefined
    if (!pull) {
      notFound(res, store)
      return true
    }
    if (rest.length === 2 && method === 'GET') {
      sendJson(res, store, 200, pullJson(store, repo, pull, baseUrl))
      return true
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      void body
      if (pull.merged || pull.state !== 'open') {
        sendJson(res, store, 405, { message: 'Pull Request is not mergeable', documentation_url: DOC_URL })
        return true
      }
      if (store.isConflicted(repo, pull)) {
        sendJson(res, store, 405, { message: 'Pull Request is not mergeable', documentation_url: DOC_URL })
        return true
      }
      const headTip = repo.branchSha(pull.headRef)
      if (!headTip) {
        sendJson(res, store, 405, { message: 'Pull Request is not mergeable', documentation_url: DOC_URL })
        return true
      }
      const message = `Merge pull request #${pull.number} from ${repo.fullName}/${pull.headRef}\n\n${pull.title}`
      const sha = store.squashMerge(repo, pull, message, tsSec(store))
      pull.state = 'closed'
      pull.merged = true
      pull.mergedAt = store.tick()
      pull.mergeCommitSha = sha
      pull.updatedAt = pull.mergedAt
      repo.pushedAt = repo.updatedAt = pull.mergedAt
      sendJson(res, store, 200, { sha, merged: true, message: 'Pull Request successfully merged' })
      return true
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      const headTip = repo.branchSha(pull.headRef)
      const baseTip = repo.branchSha(pull.baseRef)
      const files: Array<Record<string, unknown>> = []
      if (headTip && baseTip) {
        const diff = store.changedPathsBetween(store.commitTree(baseTip), store.commitTree(headTip))
        for (const [path, ab] of diff) {
          if ((ab.a?.sha ?? null) === (ab.b?.sha ?? null)) continue
          files.push({ sha: ab.b?.sha ?? '', filename: path, status: ab.a ? 'modified' : 'added', additions: 1, deletions: 0, changes: 1, blob_url: '', raw_url: '', contents_url: '' })
        }
      }
      paginate(store, res, 200, files, query, `${baseUrl}/api/v3/repos/${repo.fullName}/pulls/${pull.number}/files`, {})
      return true
    }
    notFound(res, store)
    return true
  }

  notFound(res, store)
  return true
}

function dirEntriesOf(store: Store, repo: Repo, branch: string, path: string): Array<{ mode: string; name: string; sha: string; kind: 'file' | 'dir' }> | null {
  // find the directory entry for path itself (or root)
  const segs = path.split('/').filter(Boolean)
  const tip = repo.branchSha(branch)
  if (!tip) return null
  let dirSha = store.commitTree(tip)
  for (const seg of segs) {
    const rec = store.objects.get(dirSha)
    if (!rec) return null
    const hit = parseTree(rec.data).find((e) => e.name === seg)
    if (!hit) return null
    if (hit.mode !== '40000' && hit.mode !== '040000') return null
    dirSha = hit.sha
  }
  const rec = store.objects.get(dirSha)
  if (!rec) return null
  return parseTree(rec.data).map((e) => ({
    mode: e.mode,
    name: e.name,
    sha: e.sha,
    kind: e.mode === '40000' || e.mode === '040000' ? 'dir' : 'file',
  }))
}
