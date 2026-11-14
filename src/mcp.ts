// MCP over Streamable HTTP at /mcp: initialize, server/discover, tools/list, tools/call.
import type http from 'node:http'
import type { Store, Repo } from './store.ts'

const SERVER_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']

interface ToolDef {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, { type: string; description: string }>
    required: string[]
  }
}

const TOOLS: ToolDef[] = [
  {
    name: 'github__create_repo',
    description: 'Create a new repository owned by the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
        auto_init: { type: 'boolean', description: 'Initialize the repository with a README' },
      },
      required: ['name'],
    },
  },
  {
    name: 'github__get_repo',
    description: 'Get details of a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name as owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github__create_issue',
    description: 'Create a new issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name as owner/repo' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
        labels: { type: 'array', description: 'Labels to attach; each label must already exist' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'github__list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name as owner/repo' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'github__create_pull_request',
    description: 'Open a pull request from an existing head branch to a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name as owner/repo' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'github__merge_pull_request',
    description: 'Merge a pull request by squash commit onto its base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name as owner/repo' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'github__update_issue',
    description: 'Update an issue title, body, state or labels',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name as owner/repo' },
        issue_number: { type: 'number', description: 'Issue number' },
        state: { type: 'string', description: 'New state: open or closed' },
        title: { type: 'string', description: 'New title' },
        body: { type: 'string', description: 'New body' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'github__list_pull_requests',
    description: 'List pull requests in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Repository full name as owner/repo' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
]

// Byte-for-byte stable tools/list payload
const TOOLS_JSON = JSON.stringify({
  tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
})

function rpc(id: unknown, result: unknown): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }), 'utf8')
}

function rpcError(id: unknown, code: number, message: string): Buffer {
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: id === undefined ? null : id, error: { code, message } }), 'utf8')
}

function sendJsonRpc(res: http.ServerResponse, status: number, body: Buffer, sessionId: string | null): void {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(body.length),
  }
  if (sessionId) headers['Mcp-Session-Id'] = sessionId
  res.writeHead(status, headers)
  res.end(body)
}

function resolveRepo(store: Store, args: Record<string, unknown>): { repo: Repo } | { err: string } {
  const owner = typeof args.owner === 'string' && args.owner ? args.owner : null
  const repo = typeof args.repo === 'string' && args.repo ? args.repo : null
  const fullName = typeof args.full_name === 'string' && args.full_name ? args.full_name : null
  let target: Repo | null = null
  if (owner && repo) target = store.getRepo(owner, repo)
  else if (fullName) {
    const slash = fullName.indexOf('/')
    if (slash > 0) target = store.getRepo(fullName.slice(0, slash), fullName.slice(slash + 1))
  }
  if (!target) return { err: `Repository not found: ${fullName ?? `${owner ?? '?'}/${repo ?? '?'}`}` }
  return { repo: target }
}

export function handleMcp(
  store: Store,
  bodyText: string,
  res: http.ServerResponse,
  sessionIdIn: string | null,
  send: (status: number, body: Buffer, sessionId: string | null) => void,
): void {
  let msg: { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> } | null = null
  try {
    msg = JSON.parse(bodyText)
  } catch {
    send(400, rpcError(null, -32700, 'Parse error'), null)
    return
  }
  if (!msg || typeof msg !== 'object' || typeof msg.method !== 'string') {
    send(200, rpcError(msg?.id ?? null, -32600, 'Invalid Request'), sessionIdIn)
    return
  }
  const id = msg.id === undefined ? null : msg.id
  const method = msg.method
  const params = (msg.params ?? {}) as Record<string, unknown>
  const sessionOut = sessionIdIn

  if (method.startsWith('notifications/')) {
    // notification: no response body per Streamable HTTP
    send(202, Buffer.alloc(0), sessionOut)
    return
  }

  try {
    switch (method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : SERVER_VERSIONS[0]
        const version = SERVER_VERSIONS.includes(requested) ? requested : SERVER_VERSIONS.find((v) => v <= requested) ?? SERVER_VERSIONS[0]
        send(200, rpc(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'forge', title: 'Standalone Git Forge', version: '1.0.0' },
        }), sessionOut)
        return
      }
      case 'server/discover': {
        send(200, rpc(id, {
          supportedVersions: SERVER_VERSIONS,
          serverInfo: { name: 'forge', title: 'Standalone Git Forge', version: '1.0.0' },
          capabilities: { tools: { listChanged: false } },
        }), sessionOut)
        return
      }
      case 'ping': {
        send(200, rpc(id, {}), sessionOut)
        return
      }
      case 'tools/list': {
        send(200, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: JSON.parse(TOOLS_JSON) }), 'utf8'), sessionOut)
        return
      }
      case 'tools/call': {
        callTool(store, id, params, (status, buf) => send(status, buf, sessionOut))
        return
      }
      default:
        send(200, rpcError(id, -32601, `Method not found: ${method}`), sessionOut)
        return
    }
  } catch (e) {
    send(200, rpcError(id, -32603, `Internal error: ${(e as Error).message}`), sessionOut)
  }
}

function callTool(
  store: Store,
  id: unknown,
  params: Record<string, unknown>,
  send: (status: number, buf: Buffer) => void,
): void {
  const name = typeof params.name === 'string' ? params.name : ''
  const args = (params.arguments ?? {}) as Record<string, unknown>
  const tool = TOOLS.find((t) => t.name.toLowerCase() === name.toLowerCase() || t.name.toLowerCase().endsWith(name.toLowerCase()))
  if (!name || !tool) {
    send(200, rpcError(id, -32602, `Unknown tool: ${name || '<missing name>'}`))
    return
  }
  const missing = tool.inputSchema.required.filter((k) => {
    const v = args[k]
    return v === undefined || v === null || v === ''
  })
  if (missing.length > 0) {
    send(200, rpc(id, { content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }], isError: true }))
    return
  }
  const ok = (value: unknown): void => send(200, rpc(id, { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false }))
  const fail = (message: string): void => send(200, rpc(id, { content: [{ type: 'text', text: message }], isError: true }))

  const short = name.toLowerCase().replace(/^github__/, '')
  switch (short) {
    case 'create_repo': {
      const repoName = String(args.name)
      if (!/^[A-Za-z0-9._-]+$/.test(repoName) || store.getRepo(store.login, repoName)) {
        fail(`Repository ${repoName} already exists or the name is invalid`)
        return
      }
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '')
      if (args.auto_init === true) {
        store.writeFile(repo, repo.defaultBranch, 'README.md', Buffer.from(`# ${repoName}\n`), 'Initial commit', Math.floor((store.clock += 1000) / 1000))
        repo.pushedAt = repo.updatedAt
      }
      ok({ name: repo.name, full_name: repo.fullName, owner: repo.owner, id: repo.dbId, default_branch: repo.defaultBranch })
      return
    }
    case 'get_repo': {
      const found = resolveRepo(store, args)
      if ('err' in found) {
        fail(found.err)
        return
      }
      ok({ name: found.repo.name, full_name: found.repo.fullName, owner: found.repo.owner, id: found.repo.dbId, node_id: store.nodeId('Repository', found.repo.dbId), description: found.repo.description, default_branch: found.repo.defaultBranch, clone_url: `/api/v3/${found.repo.fullName}.git` })
      return
    }
    case 'create_issue': {
      const found = resolveRepo(store, args)
      if ('err' in found) {
        fail(found.err)
        return
      }
      const repo = found.repo
      const title = String(args.title ?? '')
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String) : []
      for (const l of labels) {
        if (!repo.labels.has(l)) {
          fail(`Label not found: ${l}`)
          return
        }
      }
      repo.numSeq += 1
      const when = store.tick()
      const issue = {
        dbId: (store.issueId += 1),
        number: repo.numSeq,
        title,
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
        labels,
        createdAt: when,
        updatedAt: when,
        closedAt: null,
        comments: 0,
      }
      repo.issues.set(issue.number, issue)
      store.nodes.set(store.nodeId('Issue', issue.dbId), { kind: 'Issue', repo, id: issue.dbId })
      ok({ id: issue.dbId, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: issue.labels, created_at: issue.createdAt.toISOString() })
      return
    }
    case 'list_issues': {
      const found = resolveRepo(store, args)
      if ('err' in found) {
        fail(found.err)
        return
      }
      const state = typeof args.state === 'string' ? args.state : 'open'
      const all = [...found.repo.issues.values()]
        .filter((i) => (state === 'all' ? true : i.state === state))
        .sort((a, b) => a.number - b.number)
        .map((i) => ({ id: i.dbId, number: i.number, title: i.title, body: i.body, state: i.state, labels: i.labels }))
      ok(all)
      return
    }
    case 'create_pull_request': {
      const found = resolveRepo(store, args)
      if ('err' in found) {
        fail(found.err)
        return
      }
      const repo = found.repo
      const head = String(args.head ?? '')
      const base = String(args.base ?? '')
      const headSha = repo.branchSha(head)
      const baseSha = repo.branchSha(base)
      if (!headSha || !baseSha) {
        fail(`Head branch ${head} or base branch ${base} does not exist`)
        return
      }
      repo.numSeq += 1
      const when = store.tick()
      const pull = {
        dbId: (store.pullId += 1),
        number: repo.numSeq,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open' as const,
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
      ok({ id: pull.dbId, number: pull.number, title: pull.title, state: pull.state, head: { ref: pull.headRef, sha: headSha }, base: { ref: pull.baseRef, sha: baseSha } })
      return
    }
    case 'merge_pull_request': {
      const found = resolveRepo(store, args)
      if ('err' in found) {
        fail(found.err)
        return
      }
      const repo = found.repo
      const num = Number(args.pull_number)
      const pull = Number.isFinite(num) ? repo.pulls.get(num) : undefined
      if (!pull) {
        fail(`Pull request not found: ${num}`)
        return
      }
      if (pull.merged || pull.state !== 'open') {
        fail('Pull Request is not mergeable')
        return
      }
      if (store.isConflicted(repo, pull)) {
        fail('Pull Request is not mergeable: conflicting changes')
        return
      }
      const headTip = repo.branchSha(pull.headRef)
      if (!headTip) {
        fail('Pull Request head branch is gone')
        return
      }
      const message = `Merge pull request #${pull.number} from ${repo.fullName}/${pull.headRef}\n\n${pull.title}`
      const sha = store.squashMerge(repo, pull, message, Math.floor((store.clock += 1000) / 1000))
      pull.state = 'closed'
      pull.merged = true
      pull.mergedAt = store.tick()
      pull.mergeCommitSha = sha
      pull.updatedAt = pull.mergedAt
      repo.pushedAt = repo.updatedAt = pull.mergedAt
      ok({ sha, merged: true, message: 'Pull Request successfully merged' })
      return
    }
    case 'update_issue': {
      const found = resolveRepo(store, args)
      if ('err' in found) {
        fail(found.err)
        return
      }
      const num = Number(args.issue_number)
      const issue = Number.isFinite(num) ? found.repo.issues.get(num) : undefined
      if (!issue) {
        fail(`Issue not found: ${num}`)
        return
      }
      if (typeof args.title === 'string' && args.title) issue.title = args.title
      if (typeof args.body === 'string') issue.body = args.body
      if (args.state === 'open' || args.state === 'closed') {
        issue.state = args.state
        issue.closedAt = args.state === 'closed' ? store.tick() : null
      }
      issue.updatedAt = store.tick()
      ok({ id: issue.dbId, number: issue.number, title: issue.title, state: issue.state, labels: issue.labels })
      return
    }
    case 'list_pull_requests': {
      const found = resolveRepo(store, args)
      if ('err' in found) {
        fail(found.err)
        return
      }
      const state = typeof args.state === 'string' ? args.state : 'open'
      const all = [...found.repo.pulls.values()]
        .filter((p) => {
          if (state === 'all') return true
          const st = p.merged ? 'closed' : p.state
          return st === state
        })
        .sort((a, b) => a.number - b.number)
        .map((p) => ({ id: p.dbId, number: p.number, title: p.title, state: p.state, merged: p.merged, head: p.headRef, base: p.baseRef }))
      ok(all)
      return
    }
    default:
      send(200, rpcError(id, -32602, `Unknown tool: ${name}`))
  }
}
