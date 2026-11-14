// GraphQL v4 at /api/graphql: parser, schema, introspection, executor, batching.
import type http from 'node:http'
import type { Store, Repo, IssueRec, PullRec } from './store.ts'

const DOC_URL = 'https://docs.github.com/graphql'

export interface Ctx {
  store: Store
  baseUrl: string
}

class GraphQLError extends Error {}

// ---------- value model ----------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'lit'; value: unknown }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'obj'; fields: Record<string, Value> }

interface FieldInst {
  name: string
  alias: string
  args: Record<string, Value> | null
  directives: Array<{ name: string; args: Record<string, Value> | null }>
  sel: Selection[] | null
  pos: { line: number; col: number }
}

type Selection =
  | ({ kind: 'field' } & FieldInst)
  | { kind: 'spread'; name: string; directives: Array<{ name: string; args: Record<string, Value> | null }> }
  | { kind: 'inline'; on: string | null; directives: Array<{ name: string; args: Record<string, Value> | null }>; sel: Selection[] }

interface Operation {
  type: 'query' | 'mutation'
  name: string | null
  varDefs: Array<{ name: string; def: Value | null }>
  sel: Selection[]
}

interface Document {
  ops: Operation[]
  fragments: Map<string, { on: string | null; sel: Selection[] }>
}

// ---------- tokenizer ----------

interface Tok {
  t: 'name' | 'int' | 'float' | 'string' | 'punct'
  v: string
}

function tokenize(src: string): Tok[] {
  const toks: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i++
      continue
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
      let j = i + 3
      let s = ''
      while (j < src.length && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) {
        s += src[j]
        j++
      }
      toks.push({ t: 'string', v: s })
      i = j + 3
      continue
    }
    if (c === '"') {
      let j = i + 1
      let s = ''
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const n = src[j + 1]
          if (n === 'n') s += '\n'
          else if (n === 't') s += '\t'
          else if (n === 'r') s += '\r'
          else if (n === 'u') {
            const hex = src.slice(j + 2, j + 6)
            s += String.fromCharCode(parseInt(hex, 16))
            j += 4
          } else s += n
          j += 2
        } else {
          s += src[j]
          j++
        }
      }
      toks.push({ t: 'string', v: s })
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++
      toks.push({ t: 'name', v: src.slice(i, j) })
      i = j
      continue
    }
    if (/[0-9-]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j++
      const v = src.slice(i, j)
      toks.push({ t: v.includes('.') ? 'float' : 'int', v })
      i = j
      continue
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      toks.push({ t: 'punct', v: '...' })
      i += 3
      continue
    }
    toks.push({ t: 'punct', v: c })
    i++
  }
  return toks
}

// ---------- parser ----------

class Parser {
  toks: Tok[]
  i = 0
  constructor(toks: Tok[]) {
    this.toks = toks
  }
  peek(): Tok | null {
    return this.toks[this.i] ?? null
  }
  next(): Tok | null {
    return this.toks[this.i++] ?? null
  }
  expectP(v: string): void {
    const t = this.next()
    if (!t || t.t !== 'punct' || t.v !== v) throw new GraphQLError(`Syntax error: expected '${v}', found ${t ? t.v : '<eof>'}`)
  }
  parseValue(): Value {
    const t = this.next()
    if (!t) throw new GraphQLError('Syntax error: unexpected eof')
    if (t.t === 'punct' && t.v === '$') {
      const n = this.next()
      if (!n || n.t !== 'name') throw new GraphQLError('Syntax error: expected variable name')
      return { kind: 'var', name: n.v }
    }
    if (t.t === 'int') return { kind: 'lit', value: parseInt(t.v, 10) }
    if (t.t === 'float') return { kind: 'lit', value: parseFloat(t.v) }
    if (t.t === 'string') return { kind: 'lit', value: t.v }
    if (t.t === 'name') {
      if (t.v === 'true') return { kind: 'lit', value: true }
      if (t.v === 'false') return { kind: 'lit', value: false }
      if (t.v === 'null') return { kind: 'lit', value: null }
      return { kind: 'enum', value: t.v }
    }
    if (t.t === 'punct' && t.v === '[') {
      const items: Value[] = []
      while (this.peek() && !(this.peek()!.t === 'punct' && this.peek()!.v === ']')) items.push(this.parseValue())
      this.expectP(']')
      return { kind: 'list', items }
    }
    if (t.t === 'punct' && t.v === '{') {
      const fields: Record<string, Value> = {}
      while (this.peek() && !(this.peek()!.t === 'punct' && this.peek()!.v === '}')) {
        const n = this.next()
        if (!n || n.t !== 'name') throw new GraphQLError('Syntax error: expected input field name')
        this.expectP(':')
        fields[n.v] = this.parseValue()
      }
      this.expectP('}')
      return { kind: 'obj', fields }
    }
    throw new GraphQLError(`Syntax error: unexpected '${t.v}'`)
  }
  parseArgs(): Record<string, Value> | null {
    if (!this.peek() || this.peek()!.t !== 'punct' || this.peek()!.v !== '(') return null
    this.next()
    const args: Record<string, Value> = {}
    while (this.peek() && !(this.peek()!.t === 'punct' && this.peek()!.v === ')')) {
      const n = this.next()
      if (!n || n.t !== 'name') throw new GraphQLError('Syntax error: expected argument name')
      this.expectP(':')
      args[n.v] = this.parseValue()
    }
    this.expectP(')')
    return args
  }
  parseDirectives(): Array<{ name: string; args: Record<string, Value> | null }> {
    const out: Array<{ name: string; args: Record<string, Value> | null }> = []
    while (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === '@') {
      this.next()
      const n = this.next()
      if (!n || n.t !== 'name') throw new GraphQLError('Syntax error: expected directive name')
      out.push({ name: n.v, args: this.parseArgs() })
    }
    return out
  }
  parseSelectionSet(): Selection[] {
    this.expectP('{')
    const sels: Selection[] = []
    while (this.peek() && !(this.peek()!.t === 'punct' && this.peek()!.v === '}')) {
      const t = this.peek()!
      if (t.t === 'punct' && t.v === '...') {
        this.next()
        const nx = this.peek()
        if (nx && nx.t === 'name' && nx.v === 'on') {
          this.next()
          const tn = this.next()
          sels.push({ kind: 'inline', on: tn ? tn.v : null, directives: this.parseDirectives(), sel: this.parseSelectionSet() })
        } else if (nx && nx.t === 'punct' && nx.v === '{') {
          sels.push({ kind: 'inline', on: null, directives: this.parseDirectives(), sel: this.parseSelectionSet() })
        } else {
          const n = this.next()
          if (!n || n.t !== 'name') throw new GraphQLError('Syntax error: expected fragment name')
          sels.push({ kind: 'spread', name: n.v, directives: this.parseDirectives() })
        }
        continue
      }
      if (t.t !== 'name') throw new GraphQLError(`Syntax error: unexpected '${t.v}'`)
      this.next()
      const alias = t.v
      let name = t.v
      if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === ':') {
        this.next()
        const n2 = this.next()
        if (!n2 || n2.t !== 'name') throw new GraphQLError('Syntax error: expected field name')
        name = n2.v
        void alias
      }
      const args = this.parseArgs()
      const directives = this.parseDirectives()
      let sel: Selection[] | null = null
      if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === '{') sel = this.parseSelectionSet()
      sels.push({ kind: 'field', name, alias, args, directives, sel, pos: { line: 1, col: 1 } })
    }
    this.expectP('}')
    return sels
  }
  parseDocument(): Document {
    const ops: Operation[] = []
    const fragments = new Map<string, { on: string | null; sel: Selection[] }>()
    while (this.peek()) {
      const t = this.next()!
      if (t.t === 'punct' && t.v === '{') {
        this.i--
        ops.push({ type: 'query', name: null, varDefs: [], sel: this.parseSelectionSet() })
        continue
      }
      if (t.t !== 'name' || (t.v !== 'query' && t.v !== 'mutation' && t.v !== 'fragment')) {
        throw new GraphQLError(`Syntax error: unexpected '${t.v}'`)
      }
      if (t.v === 'fragment') {
        const n = this.next()
        if (!n || n.t !== 'name') throw new GraphQLError('Syntax error: expected fragment name')
        const on = this.next()
        if (!on || on.t !== 'name' || on.v !== 'on') throw new GraphQLError('Syntax error: expected "on"')
        const tn = this.next()
        fragments.set(n.v, { on: tn ? tn.v : null, sel: this.parseSelectionSet() })
        continue
      }
      let name: string | null = null
      const nx = this.peek()
      if (nx && nx.t === 'name' && nx.v !== 'on') {
        this.next()
        name = nx.v
      }
      const varDefs: Array<{ name: string; def: Value | null }> = []
      if (this.peek() && this.peek()!.t === 'punct' && this.peek()!.v === '(') {
        this.next()
        while (this.peek() && !(this.peek()!.t === 'punct' && this.peek()!.v === ')')) {
          this.expectP('$')
          const n = this.next()
          if (!n || n.t !== 'name') throw new GraphQLError('Syntax error: expected variable name')
          this.expectP(':')
          // skip type (wrappers + names)
          this.skipType()
          let def: Value | null = null
          const eq = this.peek()
          if (eq && eq.t === 'punct' && eq.v === '=') {
            this.next()
            def = this.parseValue()
          }
          varDefs.push({ name: n.v, def })
        }
        this.expectP(')')
      }
      // skip directives
      this.parseDirectives()
      ops.push({ type: t.v as 'query' | 'mutation', name, varDefs, sel: this.parseSelectionSet() })
    }
    if (ops.length === 0) throw new GraphQLError('Syntax error: no operations')
    return { ops, fragments }
  }
  skipType(): void {
    let t = this.peek()
    if (t && t.t === 'punct' && t.v === '[') {
      this.next()
      this.skipType()
      t = this.peek()
      if (t && t.t === 'punct' && t.v === ']') this.next()
    } else {
      const n = this.next()
      void n
    }
    const bang = this.peek()
    if (bang && bang.t === 'punct' && bang.v === '!') this.next()
  }
}

// ---------- type model ----------

interface TypeRef {
  kind: 'SCALAR' | 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'LIST' | 'NON_NULL' | 'INTERFACE'
  name?: string
  ofType?: TypeRef
}

function parseTypeRef(s: string): TypeRef {
  let i = 0
  const go = (): TypeRef => {
    if (s[i] === '[') {
      i++
      const inner = go()
      i++ // ']'
      if (s[i] === '!') {
        i++
        return { kind: 'NON_NULL', ofType: { kind: 'LIST', ofType: inner } }
      }
      return { kind: 'LIST', ofType: inner }
    }
    let j = i
    while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++
    const name = s.slice(i, j)
    i = j
    if (s[i] === '!') {
      i++
      return { kind: 'NON_NULL', ofType: { kind: namedKind(name), name } as TypeRef }
    }
    return { kind: namedKind(name), name }
  }
  const out = go()
  if (i !== s.length) throw new Error(`bad type ref ${s}`)
  return out
}

function namedKind(name: string): TypeRef['kind'] {
  if (name === 'String' || name === 'Int' || name === 'Boolean' || name === 'ID' || name === 'Float') return 'SCALAR'
  if (name === 'IssueState' || name === 'PullRequestState' || name === 'MergeableState' || name === 'IssueOrderField' || name === 'OrderDirection' || name === 'SearchType') return 'ENUM'
  if (name === 'IssueOrder' || name === 'CreatePullRequestInput' || name === 'UpdateIssueInput') return 'INPUT_OBJECT'
  if (name === 'Node') return 'INTERFACE'
  return 'OBJECT'
}

function unwrap(t: TypeRef): TypeRef {
  return t.ofType ? unwrap(t.ofType) : t
}

interface ArgDef {
  type: string
  defaultValue?: unknown
}

interface FieldDef {
  type: string
  args?: Record<string, ArgDef>
  resolve?: (src: any, args: Record<string, unknown>, ctx: Ctx) => unknown
}

const ENUMS: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  SearchType: ['ISSUE', 'USER', 'REPOSITORY'],
}

const connectionFields = (item: string): Record<string, FieldDef> => ({
  totalCount: { type: 'Int!' },
  pageInfo: { type: 'PageInfo!' },
  edges: { type: `[${item}Edge!]!` },
  nodes: { type: `[${item}!]!` },
})

const edgeFields = (item: string): Record<string, FieldDef> => ({
  cursor: { type: 'String!' },
  node: { type: item },
})

function connResolver(kind: 'issues' | 'pulls') {
  return (src: any, args: Record<string, unknown>, ctx: Ctx): unknown => {
    const repo: Repo = src.__repo
    const list: Array<IssueRec | PullRec> =
      kind === 'issues'
        ? [...repo.issues.values()].filter((i: IssueRec) => {
            const states = (args.states as string[] | undefined) ?? null
            if (!states || states.length === 0) return true
            return states.some((s) => s.toLowerCase() === i.state)
          })
        : [...repo.pulls.values()].filter((p: PullRec) => {
            const states = (args.states as string[] | undefined) ?? null
            if (!states || states.length === 0) return true
            const st = p.merged ? 'merged' : p.state
            return states.some((s) => s.toLowerCase() === st.toLowerCase())
          })
    const order = (args.orderBy as { field?: string; direction?: string } | undefined) ?? { field: 'CREATED_AT', direction: 'ASC' }
    const field = (order.field ?? 'CREATED_AT').toUpperCase()
    const dir = (order.direction ?? 'ASC').toUpperCase()
    const keyOf = (x: IssueRec | PullRec): number =>
      field === 'UPDATED_AT' ? new Date(x.updatedAt).getTime() : field === 'COMMENTS' ? (x as IssueRec).comments ?? 0 : new Date(x.createdAt).getTime()
    list.sort((a, b) => {
      const ka = keyOf(a)
      const kb = keyOf(b)
      if (ka !== kb) return dir === 'DESC' ? kb - ka : ka - kb
      const na = a.number
      const nb = b.number
      return dir === 'DESC' ? nb - na : na - nb
    })
    const first = typeof args.first === 'number' ? args.first : 100
    let start = 0
    if (typeof args.after === 'string') {
      try {
        const idx = parseInt(Buffer.from(args.after, 'base64').toString('utf8').split(':')[1], 10)
        if (Number.isFinite(idx)) start = idx + 1
      } catch {
        start = 0
      }
    }
    const slice = list.slice(start, start + first)
    const cursorOf = (idx: number): string => Buffer.from(`cursor:${idx}`, 'utf8').toString('base64')
    const nodeOf = (x: IssueRec | PullRec): unknown =>
      kind === 'issues' ? issueGql(ctx.store, repo, x as IssueRec, ctx.baseUrl) : pullGql(ctx.store, repo, x as PullRec, ctx.baseUrl)
    return {
      __repo: repo,
      totalCount: list.length,
      pageInfo: { hasNextPage: start + first < list.length, hasPreviousPage: start > 0, startCursor: slice.length ? cursorOf(start) : null, endCursor: slice.length ? cursorOf(start + slice.length - 1) : null },
      edges: slice.map((x, k) => ({ cursor: cursorOf(start + k), node: nodeOf(x) })),
      nodes: slice.map((x) => nodeOf(x)),
    }
  }
}

const SCHEMA: Record<string, Record<string, FieldDef>> = {
  Query: {
    __typename: { type: 'String!' },
    viewer: {
      type: 'User!',
      resolve: (src, args, ctx) => ({ __repo: null, login: ctx.store.login, id: '1', createdAt: new Date(0).toISOString() }),
    },
    repository: {
      type: 'Repository',
      args: { owner: { type: 'String!' }, name: { type: 'String!' } },
      resolve: (src, args, ctx) => {
        const repo = ctx.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''))
        return repo ? repoGql(ctx.store, repo, ctx.baseUrl) : null
      },
    },
    node: {
      type: 'Node',
      args: { id: { type: 'ID!' } },
      resolve: (src, args, ctx) => {
        const id = String(args.id ?? '')
        const repo = findRepoByNodeId(ctx.store, id)
        return repo ? repoGql(ctx.store, repo, ctx.baseUrl) : null
      },
    },
    search: {
      type: 'SearchResultItemConnection!',
      args: { query: { type: 'String!' }, type: { type: 'SearchType!' }, first: { type: 'Int' } },
      resolve: () => ({ totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, edges: [], nodes: [] }),
    },
  },
  Mutation: {
    __typename: { type: 'String!' },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      args: { input: { type: 'CreatePullRequestInput!' } },
      resolve: (src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>
        const repo = findRepoByNodeId(ctx.store, String(input.repositoryId ?? ''))
        if (!repo) throw new GraphQLError(`Could not resolve to a Repository with the id of '${String(input.repositoryId ?? '')}'.`)
        const head = String(input.headRefName ?? '')
        const base = String(input.baseRefName ?? '')
        const title = String(input.title ?? '')
        const headSha = repo.branchSha(head)
        const baseSha = repo.branchSha(base)
        if (!headSha) throw new GraphQLError(`Head branch ${head} does not exist in ${repo.fullName}.`)
        if (!baseSha) throw new GraphQLError(`Base branch ${base} does not exist in ${repo.fullName}.`)
        repo.numSeq += 1
        const when = ctx.store.tick()
        const pull = {
          dbId: (ctx.store.pullId += 1),
          number: repo.numSeq,
          title,
          body: typeof input.body === 'string' ? input.body : '',
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
        ctx.store.nodes.set(ctx.store.nodeId('PullRequest', pull.dbId), { kind: 'PullRequest', repo, id: pull.dbId })
        return {
          clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
          pullRequest: pullGql(ctx.store, repo, pull, ctx.baseUrl),
        }
      },
    },
    createIssue: {
      type: 'CreateIssuePayload',
      args: { input: { type: 'CreateIssueInput!' } },
      resolve: (src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>
        const repo = findRepoByNodeId(ctx.store, String(input.repositoryId ?? ''))
        if (!repo) throw new GraphQLError(`Could not resolve to a Repository with the id of '${String(input.repositoryId ?? '')}'.`)
        const title = String(input.title ?? '')
        if (!title) throw new GraphQLError('Title is required')
        const body = typeof input.body === 'string' ? input.body : ''
        repo.numSeq += 1
        const when = ctx.store.tick()
        const issue: IssueRec = {
          dbId: (ctx.store.issueId += 1),
          number: repo.numSeq,
          title,
          body,
          state: 'open',
          labels: [],
          createdAt: when,
          updatedAt: when,
          closedAt: null,
          comments: 0,
          commentsList: [],
        }
        repo.issues.set(issue.number, issue)
        ctx.store.nodes.set(ctx.store.nodeId('Issue', issue.dbId), { kind: 'Issue', repo, id: issue.dbId })
        return {
          clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
          issue: issueGql(ctx.store, repo, issue, ctx.baseUrl),
        }
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      args: { input: { type: 'CloseIssueInput!' } },
      resolve: (src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>
        const target = ctx.store.nodes.get(String(input.issueId ?? ''))
        if (!target || target.kind !== 'Issue') throw new GraphQLError(`Could not resolve to an Issue with the id of '${String(input.issueId ?? '')}'.`)
        const issue = [...target.repo.issues.values()].find((i) => i.dbId === target.id)
        if (!issue) throw new GraphQLError('Issue not found')
        issue.state = 'closed'
        issue.closedAt = ctx.store.tick()
        issue.updatedAt = issue.closedAt
        return {
          clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
          issue: issueGql(ctx.store, target.repo, issue, ctx.baseUrl),
        }
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      args: { input: { type: 'MergePullRequestInput!' } },
      resolve: (src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>
        const target = ctx.store.nodes.get(String(input.pullRequestId ?? ''))
        if (!target || target.kind !== 'PullRequest') throw new GraphQLError(`Could not resolve to a PullRequest with the id of '${String(input.pullRequestId ?? '')}'.`)
        const pull = [...target.repo.pulls.values()].find((p) => p.dbId === target.id)
        if (!pull) throw new GraphQLError('PullRequest not found')
        const repo = target.repo
        const headTip = repo.branchSha(pull.headRef)
        if (!headTip) throw new GraphQLError('Head branch not found')
        const message = `Merge pull request #${pull.number} from ${repo.fullName}/${pull.headRef}\n\n${pull.title}`
        const sha = ctx.store.squashMerge(repo, pull, message, Math.floor(ctx.store.clock / 1000))
        pull.state = 'closed'
        pull.merged = true
        pull.mergedAt = ctx.store.tick()
        pull.mergeCommitSha = sha
        pull.updatedAt = pull.mergedAt
        repo.pushedAt = repo.updatedAt = pull.mergedAt
        return {
          clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
          pullRequest: pullGql(ctx.store, repo, pull, ctx.baseUrl),
        }
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      args: { input: { type: 'AddCommentInput!' } },
      resolve: (src, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>
        const target = ctx.store.nodes.get(String(input.subjectId ?? ''))
        if (!target || target.kind !== 'Issue') throw new GraphQLError(`Could not resolve to an Issue with the id of '${String(input.subjectId ?? '')}'.`)
        const issue = [...target.repo.issues.values()].find((i) => i.dbId === target.id)
        if (!issue) throw new GraphQLError('Issue not found')
        const body = String(input.body ?? '')
        const when = ctx.store.tick()
        const commentId = (ctx.store.commentId += 1)
        const comment = { id: commentId, body, createdAt: when, updatedAt: when }
        if (!issue.commentsList) issue.commentsList = []
        issue.commentsList.push(comment)
        issue.comments = issue.commentsList.length
        issue.updatedAt = when
        const globalId = ctx.store.nodeId('IssueComment', commentId)
        return {
          clientMutationId: typeof input.clientMutationId === 'string' ? input.clientMutationId : null,
          commentEdge: {
            node: {
              id: globalId,
              body,
            },
          },
        }
      },
    },
  },
  User: {
    login: { type: 'String!' },
    id: { type: 'ID!' },
    name: { type: 'String' },
    createdAt: { type: 'String!' },
    url: { type: 'String!' },
  },
  Node: { id: { type: 'ID!' } },
  Repository: {
    id: { type: 'ID!' },
    databaseId: { type: 'Int!' },
    name: { type: 'String!' },
    nameWithOwner: { type: 'String!' },
    owner: { type: 'User!' },
    defaultBranchRef: { type: 'Ref' },
    viewerPermission: { type: 'String!' },
    hasIssuesEnabled: { type: 'Boolean!' },
    url: { type: 'String!' },
    createdAt: { type: 'String!' },
    issue: {
      type: 'Issue',
      args: { number: { type: 'Int!' } },
      resolve: (src, args, ctx) => {
        const repo: Repo = src.__repo
        const issue = repo.issues.get(Number(args.number))
        return issue ? issueGql(ctx.store, repo, issue, ctx.baseUrl) : null
      },
    },
    issues: { type: 'IssueConnection!', args: { first: { type: 'Int' }, after: { type: 'String' }, orderBy: { type: 'IssueOrder' }, states: { type: '[IssueState!]' } }, resolve: connResolver('issues') },
    pullRequest: {
      type: 'PullRequest',
      args: { number: { type: 'Int!' } },
      resolve: (src, args, ctx) => {
        const repo: Repo = src.__repo
        const pull = repo.pulls.get(Number(args.number))
        return pull ? pullGql(ctx.store, repo, pull, ctx.baseUrl) : null
      },
    },
    pullRequests: { type: 'PullRequestConnection!', args: { first: { type: 'Int' }, after: { type: 'String' }, orderBy: { type: 'IssueOrder' }, states: { type: '[PullRequestState!]' } }, resolve: connResolver('pulls') },
  },
  Ref: {
    id: { type: 'ID!' },
    name: { type: 'String!' },
    prefix: { type: 'String!' },
  },
  Issue: {
    id: { type: 'ID!' },
    number: { type: 'Int!' },
    title: { type: 'String!' },
    state: { type: 'IssueState!' },
    body: { type: 'String' },
    author: { type: 'User' },
    createdAt: { type: 'String!' },
    updatedAt: { type: 'String!' },
    url: { type: 'String!' },
    repository: { type: 'Repository!' },
  },
  IssueConnection: connectionFields('Issue'),
  IssueEdge: edgeFields('Issue'),
  PullRequest: {
    id: { type: 'ID!' },
    number: { type: 'Int!' },
    title: { type: 'String!' },
    state: { type: 'PullRequestState!' },
    body: { type: 'String' },
    headRefName: { type: 'String!' },
    baseRefName: { type: 'String!' },
    headRefOid: { type: 'GitObjectID!' },
    baseRefOid: { type: 'GitObjectID!' },
    mergeable: { type: 'MergeableState!' },
    merged: { type: 'Boolean!' },
    url: { type: 'String!' },
    createdAt: { type: 'String!' },
    updatedAt: { type: 'String!' },
    files: {
      type: 'PullRequestChangedFileConnection!',
      args: { first: { type: 'Int' }, after: { type: 'String' } },
      resolve: (src, args, ctx) => {
        const pull: PullRec = src.__pull
        const repo: Repo = src.__repo
        const headTip = repo.branchSha(pull.headRef)
        const baseTip = repo.branchSha(pull.baseRef)
        const paths: string[] = []
        if (headTip && baseTip) {
          const diff = ctx.store.changedPathsBetween(ctx.store.commitTree(baseTip), ctx.store.commitTree(headTip))
          for (const [path, ab] of diff) {
            if ((ab.a?.sha ?? null) === (ab.b?.sha ?? null)) continue
            paths.push(path)
          }
        }
        paths.sort()
        const first = typeof args.first === 'number' ? args.first : 100
        const slice = paths.slice(0, first)
        return {
          totalCount: paths.length,
          pageInfo: { hasNextPage: paths.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
          edges: slice.map((p) => ({ cursor: '', node: { path: p } })),
          nodes: slice.map((p) => ({ path: p })),
        }
      },
    },
  },
  PullRequestConnection: connectionFields('PullRequest'),
  PullRequestEdge: edgeFields('PullRequest'),
  PullRequestChangedFile: { path: { type: 'String!' } },
  PullRequestChangedFileConnection: connectionFields('PullRequestChangedFile'),
  PageInfo: {
    hasNextPage: { type: 'Boolean!' },
    hasPreviousPage: { type: 'Boolean!' },
    startCursor: { type: 'String' },
    endCursor: { type: 'String' },
  },
  SearchResultItemConnection: connectionFields('SearchResultItem'),
  SearchResultItemEdge: edgeFields('SearchResultItem'),
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest' },
    clientMutationId: { type: 'String' },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue' },
    clientMutationId: { type: 'String' },
  },
  CreateIssueInput: {
    repositoryId: { type: 'ID!' },
    title: { type: 'String!' },
    body: { type: 'String' },
    clientMutationId: { type: 'String' },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue' },
    clientMutationId: { type: 'String' },
  },
  CloseIssueInput: {
    issueId: { type: 'ID!' },
    clientMutationId: { type: 'String' },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest' },
    clientMutationId: { type: 'String' },
  },
  MergePullRequestInput: {
    pullRequestId: { type: 'ID!' },
    mergeMethod: { type: 'PullRequestMergeMethod' },
    clientMutationId: { type: 'String' },
  },
  AddCommentPayload: {
    commentEdge: { type: 'CommentEdge' },
    clientMutationId: { type: 'String' },
  },
  AddCommentInput: {
    subjectId: { type: 'ID!' },
    body: { type: 'String!' },
    clientMutationId: { type: 'String' },
  },
  CommentEdge: {
    node: { type: 'IssueComment' },
  },
  IssueComment: {
    id: { type: 'ID!' },
    body: { type: 'String!' },
  },
  IssueOrder: {
    field: { type: 'IssueOrderField!' },
    direction: { type: 'OrderDirection!' },
  },
  CreatePullRequestInput: {
    repositoryId: { type: 'ID!' },
    title: { type: 'String!' },
    headRefName: { type: 'String!' },
    baseRefName: { type: 'String!' },
    body: { type: 'String' },
    clientMutationId: { type: 'String' },
  },
}

const SCALARS = new Set(['String', 'Int', 'Boolean', 'ID', 'Float'])

// ---------- object builders ----------

function repoGql(store: Store, repo: Repo, baseUrl: string): Record<string, unknown> {
  const tip = repo.branchSha(repo.defaultBranch)
  return {
    __typename: 'Repository',
    __repo: repo,
    id: store.nodeId('Repository', repo.dbId),
    databaseId: repo.dbId,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: store.login, id: '1', createdAt: new Date(0).toISOString(), url: `${baseUrl}/${store.login}` },
    defaultBranchRef: tip ? { id: store.nodeId('Ref', repo.dbId), name: repo.defaultBranch, prefix: 'refs/heads/' } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `${baseUrl}/${repo.fullName}`,
    createdAt: repo.createdAt.toISOString(),
  }
}

function issueGql(store: Store, repo: Repo, issue: IssueRec, baseUrl: string): Record<string, unknown> {
  return {
    __typename: 'Issue',
    __repo: repo,
    id: store.nodeId('Issue', issue.dbId),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    author: { login: store.login, id: '1', createdAt: new Date(0).toISOString(), url: '' },
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
    url: `${baseUrl}/${repo.fullName}/issues/${issue.number}`,
  }
}

function pullGql(store: Store, repo: Repo, pull: PullRec, baseUrl: string): Record<string, unknown> {
  return {
    __typename: 'PullRequest',
    __repo: repo,
    __pull: pull,
    id: store.nodeId('PullRequest', pull.dbId),
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pull.body,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: repo.branchSha(pull.headRef) ?? pull.headSha,
    baseRefOid: repo.branchSha(pull.baseRef) ?? pull.baseSha,
    mergeable: pull.merged ? 'UNKNOWN' : store.isConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    merged: pull.merged,
    url: `${baseUrl}/${repo.fullName}/pull/${pull.number}`,
    createdAt: pull.createdAt.toISOString(),
    updatedAt: pull.updatedAt.toISOString(),
  }
}

// ---------- introspection ----------

function typeIntrospection(t: TypeRef): Record<string, unknown> {
  return {
    kind: t.kind,
    name: t.name ?? null,
    ofType: t.ofType ? typeIntrospection(t.ofType) : null,
  }
}

function inputValueIntrospection(name: string, def: ArgDef): Record<string, unknown> {
  return { name, description: null, type: typeIntrospection(parseTypeRef(def.type)), defaultValue: def.defaultValue === undefined ? null : String(def.defaultValue), isDeprecated: false, deprecationReason: null }
}

function fieldIntrospection(name: string, def: FieldDef): Record<string, unknown> {
  return {
    name,
    description: null,
    args: Object.entries(def.args ?? {}).map(([n, d]) => inputValueIntrospection(n, d)),
    type: typeIntrospection(parseTypeRef(def.type)),
    isDeprecated: false,
    deprecationReason: null,
  }
}

const ALL_TYPES: Array<{ kind: string; name: string }> = [
  ...Object.keys(SCHEMA).map((n) => ({ kind: n === 'Query' || n === 'Mutation' ? 'OBJECT' : n === 'Node' ? 'INTERFACE' : 'OBJECT', name: n })),
  ...Object.keys(ENUMS).map((n) => ({ kind: 'ENUM', name: n })),
  ...['IssueOrder', 'CreatePullRequestInput', 'CreateIssueInput', 'CloseIssueInput', 'MergePullRequestInput', 'AddCommentInput'].map((n) => ({ kind: 'INPUT_OBJECT', name: n })),
  ...[...SCALARS].map((n) => ({ kind: 'SCALAR', name: n })),
]

function namedTypeIntrospection(name: string): Record<string, unknown> | null {
  if (SCHEMA[name]) {
    return {
      kind: name === 'Node' ? 'INTERFACE' : 'OBJECT',
      name,
      description: null,
      fields: Object.entries(SCHEMA[name]).map(([n, d]) => fieldIntrospection(n, d)),
      inputFields: null,
      enumValues: null,
      interfaces: name === 'Node' ? [] : [],
      possibleTypes: null,
      ofType: null,
    }
  }
  if (ENUMS[name]) {
    return {
      kind: 'ENUM',
      name,
      description: null,
      fields: null,
      inputFields: null,
      enumValues: ENUMS[name].map((v) => ({ name: v, isDeprecated: false, deprecationReason: null })),
      interfaces: null,
      possibleTypes: null,
      ofType: null,
    }
  }
  if (name === 'IssueOrder' || name === 'CreatePullRequestInput') {
    const fields = SCHEMA[name === 'IssueOrder' ? 'IssueOrder' : 'CreatePullRequestInput']
    return {
      kind: 'INPUT_OBJECT',
      name,
      description: null,
      fields: null,
      inputFields: Object.entries(fields).map(([n, d]) => inputValueIntrospection(n, d as ArgDef)),
      enumValues: null,
      interfaces: null,
      possibleTypes: null,
      ofType: null,
    }
  }
  if (SCALARS.has(name)) {
    return { kind: 'SCALAR', name, description: null, fields: null, inputFields: null, enumValues: null, interfaces: null, possibleTypes: null, ofType: null }
  }
  return null
}

SCHEMA.Query.__schema = {
  type: '__Schema!',
  resolve: (_src, _args, ctx) => ({
    description: null,
    queryType: { name: 'Query', kind: 'OBJECT', ofType: null },
    mutationType: { name: 'Mutation', kind: 'OBJECT', ofType: null },
    subscriptionType: null,
    types: ALL_TYPES.map((t) => namedTypeIntrospection(t.name)!).filter(Boolean),
    directives: [
      { name: 'include', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', description: null, type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Boolean', ofType: null } }, defaultValue: null, isDeprecated: false, deprecationReason: null }] },
      { name: 'skip', locations: ['FIELD', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'], args: [{ name: 'if', description: null, type: { kind: 'NON_NULL', ofType: { kind: 'SCALAR', name: 'Boolean', ofType: null } }, defaultValue: null, isDeprecated: false, deprecationReason: null }] },
    ],
  }),
}
SCHEMA.Query.__type = {
  type: '__Type',
  args: { name: { type: 'String!' } },
  resolve: (_src, args) => namedTypeIntrospection(String(args.name ?? '')),
}
SCHEMA.Query.__typename = { type: 'String!', resolve: () => 'Query' }
SCHEMA.Mutation.__typename = { type: 'String!', resolve: () => 'Mutation' }

const INTROSPECTION_SCHEMA: Record<string, Record<string, FieldDef>> = {
  __Schema: {
    description: { type: 'String' },
    queryType: { type: '__Type!' },
    mutationType: { type: '__Type' },
    subscriptionType: { type: '__Type' },
    types: { type: '[__Type!]!' },
    directives: { type: '[__Directive!]!' },
  },
  __Type: {
    kind: { type: '__TypeKind!' },
    name: { type: 'String' },
    description: { type: 'String' },
    fields: {
      type: '[__Field!]',
      args: { includeDeprecated: { type: 'Boolean', defaultValue: false } },
      resolve: (src) => (src.kind === 'OBJECT' || src.kind === 'INTERFACE' ? (src.fields ?? []) : src.fields ?? null),
    },
    inputFields: { type: '[__InputValue!]', resolve: (src) => src.inputFields ?? null },
    enumValues: {
      type: '[__EnumValue!]',
      args: { includeDeprecated: { type: 'Boolean', defaultValue: false } },
      resolve: (src) => src.enumValues ?? null,
    },
    interfaces: { type: '[__Type!]', resolve: (src) => src.interfaces ?? [] },
    possibleTypes: { type: '[__Type!]', resolve: (src) => src.possibleTypes ?? null },
    ofType: { type: '__Type' },
  },
  __Field: {
    name: { type: 'String!' },
    description: { type: 'String' },
    args: { type: '[__InputValue!]!' },
    type: { type: '__Type!' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
  __InputValue: {
    name: { type: 'String!' },
    description: { type: 'String' },
    type: { type: '__Type!' },
    defaultValue: { type: 'String' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
  __EnumValue: {
    name: { type: 'String!' },
    description: { type: 'String' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
  __TypeKind: { name: { type: 'String!' } },
  __Directive: {
    name: { type: 'String!' },
    description: { type: 'String' },
    locations: { type: '[__DirectiveLocation!]!' },
    args: { type: '[__InputValue!]!' },
    isRepeatable: { type: 'Boolean!' },
  },
  __DirectiveLocation: { name: { type: 'String!' } },
}

function combinedSchema(type: string): Record<string, FieldDef> | null {
  return SCHEMA[type] ?? INTROSPECTION_SCHEMA[type] ?? null
}

// ---------- execution ----------

interface OutErrors {
  errors: Array<{ message: string; path?: Array<string | number>; locations?: unknown }>
}

function evalValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': {
      if (!(v.name in variables)) throw new GraphQLError(`Variable '${v.name}' has invalid value: no value provided`)
      return variables[v.name]
    }
    case 'lit':
      return v.value
    case 'enum':
      return v.value
    case 'list':
      return v.items.map((x) => evalValue(x, variables))
    case 'obj': {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v.fields)) out[k] = evalValue(x, variables)
      return out
    }
  }
}

function coerceArgs(def: FieldDef, given: Record<string, Value> | null, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [name, v] of Object.entries(given ?? {})) {
    out[name] = evalValue(v, variables)
  }
  for (const [name, a] of Object.entries(def.args ?? {})) {
    if (!(name in out) && a.defaultValue !== undefined) out[name] = a.defaultValue
  }
  return out
}

interface FieldOut {
  data: Record<string, unknown>
}

function directivePass(directives: Array<{ name: string; args: Record<string, Value> | null }>, variables: Record<string, unknown>): boolean {
  for (const d of directives) {
    const ifArg = d.args?.if ? evalValue(d.args.if, variables) : undefined
    if (d.name === 'include' && ifArg === false) return false
    if (d.name === 'skip' && ifArg === true) return false
  }
  return true
}

function execute(
  typeName: string,
  selections: Selection[],
  source: unknown,
  fragments: Map<string, { on: string | null; sel: Selection[] }>,
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: OutErrors['errors'],
  path: Array<string | number>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {}
  const collect = (type: string, sels: Selection[]): FieldInst[] => {
    const out: FieldInst[] = []
    for (const s of sels) {
      if (s.kind === 'field') {
        if (!directivePass(s.directives, variables)) continue
        out.push(s)
      } else if (s.kind === 'inline') {
        if (s.on && s.on !== type && s.on !== 'Node') continue
        if (!directivePass(s.directives, variables)) continue
        out.push(...collect(type, s.sel))
      } else {
        const frag = fragments.get(s.name)
        if (!frag) {
          errors.push({ message: `Unknown fragment '${s.name}'.`, path })
          continue
        }
        if (frag.on && frag.on !== type && frag.on !== 'Node') continue
        if (!directivePass(s.directives, variables)) continue
        out.push(...collect(type, frag.sel))
      }
    }
    return out
  }
  for (const f of collect(typeName, selections)) {
    const key = f.alias
    const fname = f.name
    const fpath = [...path, key]
    if (fname === '__typename') {
      data[key] = typeName
      continue
    }
    const schema = combinedSchema(typeName)
    const def = schema?.[fname]
    if (!def) {
      errors.push({ message: `Cannot query field '${fname}' on type '${typeName}'.`, path: fpath, locations: [{ line: 1, column: 1 }] })
      data[key] = null
      continue
    }
    let value: unknown
    try {
      const args = coerceArgs(def, f.args, variables)
      value = def.resolve ? def.resolve(source, args, ctx) : source ? (source as Record<string, unknown>)[fname] : null
    } catch (e) {
      errors.push({ message: (e as Error).message, path: fpath, locations: [{ line: 1, column: 1 }] })
      data[key] = null
      continue
    }
    if (f.sel) {
      data[key] = descend(parseTypeRef(def.type), f.sel, value, fragments, variables, ctx, errors, fpath)
    } else {
      data[key] = value === undefined ? null : value
    }
  }
  return data
}

function descend(
  t: TypeRef,
  sel: Selection[],
  value: unknown,
  fragments: Map<string, { on: string | null; sel: Selection[] }>,
  variables: Record<string, unknown>,
  ctx: Ctx,
  errors: OutErrors['errors'],
  path: Array<string | number>,
): unknown {
  if (t.kind === 'NON_NULL') return descend(t.ofType!, sel, value, fragments, variables, ctx, errors, path)
  if (t.kind === 'LIST') {
    if (value === null || value === undefined) return null
    const arr = Array.isArray(value) ? value : [value]
    return arr.map((item, i) => descend(t.ofType!, sel, item, fragments, variables, ctx, errors, [...path, i]))
  }
  if (value === null || value === undefined) return null
  if (t.kind === 'SCALAR' || t.kind === 'ENUM') return value
  const named = t.name!
  const actualType = value && typeof (value as any).__typename === 'string' ? (value as any).__typename : named
  return execute(actualType, sel, value, fragments, variables, ctx, errors, path)
}

function runOperation(doc: Document, op: Operation, variables: Record<string, unknown>, ctx: Ctx): Record<string, unknown> {
  const errors: OutErrors['errors'] = []
  const vars: Record<string, unknown> = { ...variables }
  for (const vd of op.varDefs) {
    if (!(vd.name in vars) && vd.def !== null) vars[vd.name] = vd.def === null ? undefined : evalValue(vd.def, vars)
  }
  const rootType = op.type === 'mutation' ? 'Mutation' : 'Query'
  const data = execute(rootType, op.sel, {}, doc.fragments, vars, ctx, errors, [])
  const out: Record<string, unknown> = { data }
  if (errors.length > 0) out.errors = errors
  return out
}

export function handleGraphQL(
  store: Store,
  bodyText: string,
  baseUrl: string,
  res: http.ServerResponse,
): void {
  let parsed: { query?: unknown; variables?: unknown } | Array<{ query?: unknown; variables?: unknown }>
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    const buf = Buffer.from(JSON.stringify({ message: 'Problems parsing JSON', documentation_url: DOC_URL }))
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(buf.length) })
    res.end(buf)
    return
  }
  const ctx: Ctx = { store, baseUrl }
  const runOne = (item: { query?: unknown; variables?: unknown }): Record<string, unknown> => {
    try {
      const doc = new Parser(tokenize(String(item.query ?? ''))).parseDocument()
      let op: Operation
      if (doc.ops.length === 1) op = doc.ops[0]
      else {
        const wanted = (item as { operationName?: string }).operationName
        const hit = doc.ops.find((o) => o.name === wanted)
        if (!hit) throw new GraphQLError('Must provide operation name if query contains multiple operations.')
        op = hit
      }
      return runOperation(doc, op, (item.variables as Record<string, unknown>) ?? {}, ctx)
    } catch (e) {
      return { data: null, errors: [{ message: (e as Error).message }] }
    }
  }
  let payload: unknown
  if (Array.isArray(parsed)) {
    payload = parsed.map((item) => runOne(item as { query?: unknown; variables?: unknown }))
  } else {
    payload = runOne(parsed as { query?: unknown; variables?: unknown })
  }
  const buf = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': String(buf.length) })
  res.end(buf)
}

function findRepoByNodeId(store: Store, id: string): Repo | null {
  const node = store.nodes.get(id)
  if (node && node.kind === 'Repository') return node.repo
  try {
    const decoded = Buffer.from(id, 'base64').toString('latin1')
    const m = decoded.match(/^(Repository|Ref):(\d+)$/)
    if (m) {
      const dbId = parseInt(m[2], 10)
      for (const repo of store.repos.values()) {
        if (repo.dbId === dbId) return repo
      }
    }
  } catch {
    // fall through
  }
  return null
}
