// Deterministic in-memory forge store: repos, refs, issues, PRs, labels, ids, clock.
import { ObjectStore, EMPTY_TREE, makeCommit, serializeTree, treeClosure, updateTreePath, parseTree, isDirMode, type TreeEntry } from './objects.ts'
import type { ObjType } from './packfile.ts'

// Logical clock: every mutating operation advances one tick, so two runs of the
// same suite produce identical ids and timestamps byte for byte.
const BASE_MS = 1767225600000 // 2026-01-01T00:00:00.000Z

export interface CommentRec {
  id: number
  body: string
  createdAt: Date
  updatedAt: Date
}

export interface IssueRec {
  dbId: number
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  createdAt: Date
  updatedAt: Date
  closedAt: Date | null
  comments: number
  commentsList: CommentRec[]
}

export interface PullRec {
  dbId: number
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  merged: boolean
  headRef: string
  baseRef: string
  headSha: string
  baseSha: string
  mergeCommitSha: string | null
  mergedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface LabelRec {
  dbId: number
  name: string
  color: string
}

export class Repo {
  owner: string
  name: string
  dbId: number
  description = ''
  defaultBranch = 'main'
  isPrivate = false
  createdAt: Date
  updatedAt: Date
  pushedAt: Date
  numSeq = 0
  issues = new Map<number, IssueRec>()
  pulls = new Map<number, PullRec>()
  labels = new Map<string, LabelRec>()
  refs = new Map<string, string>()
  packCache = new Map<string, Buffer>()

  constructor(owner: string, name: string, when: Date, dbId: number) {
    this.owner = owner
    this.name = name
    this.createdAt = when
    this.updatedAt = when
    this.pushedAt = when
    this.dbId = dbId
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`
  }

  refSha(ref: string): string | null {
    if (ref.startsWith('refs/')) return this.refs.get(ref) ?? null
    return null
  }

  branchSha(branch: string): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null
  }

  setRef(ref: string, sha: string): void {
    this.refs.set(ref, sha)
    this.packCache.clear()
  }

  deleteRef(ref: string): void {
    this.refs.delete(ref)
    this.packCache.clear()
  }
}

export class Store {
  objects = new ObjectStore()
  repos = new Map<string, Repo>()
  clock = BASE_MS
  reqCounter = 0
  repoId = 1000
  issueId = 2000
  pullId = 3000
  labelId = 4000
  commentId = 5000
  login = process.env.MAKEFUN_LOGIN || 'adaiversen'
  nodes = new Map<string, { kind: 'Repository' | 'Issue' | 'PullRequest'; repo: Repo; id: number }>()

  tick(): Date {
    this.clock += 1000
    return new Date(this.clock)
  }

  iso(): string {
    this.clock += 1000
    return new Date(this.clock).toISOString()
  }

  nextRequestId(): string {
    this.reqCounter += 1
    return `req-${this.reqCounter}`
  }

  nodeId(kind: string, dbId: number): string {
    return Buffer.from(`${kind}:${dbId}`, 'latin1').toString('base64')
  }

  getRepo(owner: string, name: string): Repo | null {
    return this.repos.get(`${owner}/${name}`) ?? null
  }

  createRepo(name: string, description = '', isPrivate = false, when = this.tick()): Repo {
    this.repoId += 1
    const repo = new Repo(this.login, name, when, this.repoId)
    repo.description = description
    repo.isPrivate = isPrivate
    this.repos.set(repo.fullName, repo)
    return repo
  }

  // ---- contents / commit helpers ----

  writeFile(repo: Repo, branch: string, path: string, data: Buffer | null, message: string, tsSec: number): { commit: string; blob: string | null } {
    const segs = path.split('/').filter((s) => s.length > 0)
    let blobSha: string | null = null
    if (data !== null) blobSha = this.objects.store('blob', data)
    const tip = repo.branchSha(branch)
    const baseTree = tip ? this.commitTree(tip) : null
    const entry = data === null ? null : { mode: '100644', sha: blobSha! }
    const newTree = updateTreePath(this.objects, baseTree, segs, entry) ?? EMPTY_TREE
    const commit = makeCommit(this.objects, {
      tree: newTree,
      parents: tip ? [tip] : [],
      message,
      tsSec,
    })
    repo.setRef(`refs/heads/${branch}`, commit)
    return { commit, blob: blobSha }
  }

  commitTree(commitSha: string): string {
    const rec = this.objects.get(commitSha)
    if (!rec) return EMPTY_TREE
    const m = rec.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m)
    return m ? m[1] : EMPTY_TREE
  }

  fileAt(repo: Repo, branch: string, path: string): { mode: string; sha: string } | null {
    const tip = repo.branchSha(branch)
    if (!tip) return null
    const tree = this.commitTree(tip)
    const segs = path.split('/').filter((s) => s.length > 0)
    let cur: TreeEntry | null = { mode: '40000', name: '', sha: tree }
    for (let i = 0; i < segs.length; i++) {
      if (!cur) return null
      const rec = this.objects.get(cur.sha)
      if (!rec) return null
      const hit = parseTree(rec.data).find((e) => e.name === segs[i])
      if (!hit) return null
      if (i === segs.length - 1) return { mode: hit.mode, sha: hit.sha }
      if (!isDirMode(hit.mode)) return null
      cur = hit
    }
    return cur ? { mode: cur.mode, sha: cur.sha } : null
  }

  listDir(repo: Repo, branch: string, path: string): Array<{ mode: string; name: string; sha: string; kind: 'file' | 'dir' }> {
    const tip = repo.branchSha(branch)
    if (!tip) return []
    const tree = this.commitTree(tip)
    const segs = path.split('/').filter((s) => s.length > 0)
    let dirSha = tree
    for (const seg of segs) {
      const rec = this.objects.get(dirSha)
      if (!rec) return []
      const hit = parseTree(rec.data).find((e) => e.name === seg && isDirMode(e.mode))
      if (!hit) return []
      dirSha = hit.sha
    }
    const rec = this.objects.get(dirSha)
    if (!rec) return []
    return parseTree(rec.data).map((e) => ({
      mode: e.mode,
      name: e.name,
      sha: e.sha,
      kind: isDirMode(e.mode) ? 'dir' : 'file',
    }))
  }

  // ---- merge helpers ----

  /** Squash-merge `pull`: tree from head, single parent = base tip, onto base branch. */
  squashMerge(repo: Repo, pull: PullRec, message: string, tsSec: number): string {
    const headTip = repo.branchSha(pull.headRef)
    if (!headTip) throw new Error('head branch missing')
    const tree = this.commitTree(headTip)
    const baseTip = repo.branchSha(pull.baseRef) ?? ''
    const commit = makeCommit(this.objects, { tree, parents: [baseTip], message, tsSec })
    repo.setRef(`refs/heads/${pull.baseRef}`, commit)
    return commit
  }

  changedPathsBetween(aTree: string | null, bTree: string | null): Map<string, { a: { mode: string; sha: string } | null; b: { mode: string; sha: string } | null }> {
    const out = new Map<string, { a: { mode: string; sha: string } | null; b: { mode: string; sha: string } | null }>()
    const put = (path: string, side: 'a' | 'b', v: { mode: string; sha: string } | null): void => {
      const cur = out.get(path) ?? { a: null, b: null }
      cur[side] = v
      out.set(path, cur)
    }
    if (aTree) for (const [p, v] of treeClosure(this.objects, aTree).blobs) put(p, 'a', v)
    if (bTree) for (const [p, v] of treeClosure(this.objects, bTree).blobs) put(p, 'b', v)
    return out
  }

  /** 3-way conflict check for a pull request. Returns true when conflicted. */
  isConflicted(repo: Repo, pull: PullRec): boolean {
    const headTip = repo.branchSha(pull.headRef)
    const baseTip = repo.branchSha(pull.baseRef)
    if (!headTip || !baseTip) return false
    // common ancestor walk
    const ancBase = new Set<string>([baseTip])
    const q = [baseTip]
    while (q.length) {
      const c = q.shift()!
      const rec = this.objects.get(c)
      if (!rec) continue
      for (const line of rec.data.toString('utf8').split('\n')) {
        if (line.startsWith('parent ')) {
          const p = line.slice(7).trim()
          if (!ancBase.has(p)) {
            ancBase.add(p)
            q.push(p)
          }
        } else if (line === '') break
      }
    }
    let mb: string | null = null
    const seenH = new Set<string>([headTip])
    const qh = [headTip]
    while (qh.length) {
      const c = qh.shift()!
      if (ancBase.has(c)) {
        mb = c
        break
      }
      const rec = this.objects.get(c)
      if (!rec) continue
      for (const line of rec.data.toString('utf8').split('\n')) {
        if (line.startsWith('parent ')) {
          const p = line.slice(7).trim()
          if (!seenH.has(p)) {
            seenH.add(p)
            qh.push(p)
          }
        } else if (line === '') break
      }
    }
    const baseTree = this.commitTree(baseTip)
    const headTree = this.commitTree(headTip)
    const mbTree = mb ? this.commitTree(mb) : null
    const diff = this.changedPathsBetween(mbTree, baseTree)
    const headDiff = this.changedPathsBetween(mbTree, headTree)
    for (const [path, hb] of headDiff) {
      const bside = diff.get(path)
      if (!bside) continue
      const baseChanged = (bside.a?.sha ?? null) !== (bside.b?.sha ?? null)
      const headChanged = (hb.a?.sha ?? null) !== (hb.b?.sha ?? null)
      if (!baseChanged || !headChanged) continue
      const baseVer = bside.b?.sha ?? null
      const headVer = hb.b?.sha ?? null
      if (baseVer !== headVer) return true
    }
    return false
  }
}

export function storeObject(store: Store, type: ObjType, data: Buffer): string {
  return store.objects.store(type, data)
}

export function emptyTreeSha(store: Store): string {
  if (!store.objects.has(EMPTY_TREE)) store.objects.store('tree', serializeTree([]))
  return EMPTY_TREE
}
