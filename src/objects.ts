// Git object core: content-addressed store, commits, trees, tree writes, ancestry.
import { sha1, type ObjType } from './packfile.ts'

export interface ObjRec {
  type: ObjType
  data: Buffer
}

export class ObjectStore {
  map = new Map<string, ObjRec>()
  treeMemo = new Map<string, { blobs: Map<string, { mode: string; sha: string }>; trees: Set<string> }>()

  store(type: ObjType, data: Buffer): string {
    const sha = sha1(type, data)
    if (!this.map.has(sha)) this.map.set(sha, { type, data })
    return sha
  }

  get(sha: string): ObjRec | undefined {
    return this.map.get(sha)
  }

  has(sha: string): boolean {
    return this.map.has(sha)
  }
}

export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export interface CommitRec {
  tree: string
  parents: string[]
  author: string
  committer: string
  message: string
}

export function parseCommit(data: Buffer): CommitRec {
  const text = data.toString('utf8')
  const idx = text.indexOf('\n\n')
  const head = idx === -1 ? text : text.slice(0, idx)
  const message = idx === -1 ? '' : text.slice(idx + 2)
  let tree = ''
  const parents: string[] = []
  let author = ''
  let committer = ''
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim()
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim())
    else if (line.startsWith('author ')) author = line.slice(7)
    else if (line.startsWith('committer ')) committer = line.slice(10)
  }
  return { tree, parents, author, committer, message }
}

export interface TreeEntry {
  mode: string
  name: string
  sha: string
}

export function isDirMode(mode: string): boolean {
  return mode === '40000' || mode === '040000'
}

export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = []
  let p = 0
  while (p < data.length) {
    const sp = data.indexOf(32, p)
    const nul = data.indexOf(0, sp)
    if (sp === -1 || nul === -1 || nul + 21 > data.length) break
    const mode = data.toString('latin1', p, sp)
    const name = data.toString('utf8', sp + 1, nul)
    const sha = data.toString('hex', nul + 1, nul + 21)
    out.push({ mode, name, sha })
    p = nul + 21
  }
  return out
}

export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.name + (isDirMode(a.mode) ? '/' : '')
    const bn = b.name + (isDirMode(b.mode) ? '/' : '')
    return an < bn ? -1 : an > bn ? 1 : 0
  })
  const parts: Buffer[] = []
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'))
    parts.push(Buffer.from(e.sha, 'hex'))
  }
  return Buffer.concat(parts)
}

export function makeCommit(
  objects: ObjectStore,
  opts: { tree: string; parents: string[]; message: string; tsSec: number; who?: string },
): string {
  const ident = `${opts.who ?? 'Forge <forge@forge.local>'} ${opts.tsSec} +0000`
  const lines = [`tree ${opts.tree}`]
  for (const p of opts.parents) lines.push(`parent ${p}`)
  lines.push(`author ${ident}`, `committer ${ident}`, '', opts.message, '')
  return objects.store('commit', Buffer.from(lines.join('\n'), 'utf8'))
}

/** Full recursive closure of a tree: blob paths + all tree shas (memoized). */
export function treeClosure(objects: ObjectStore, treeSha: string): {
  blobs: Map<string, { mode: string; sha: string }>
  trees: Set<string>
} {
  const memo = objects.treeMemo
  const hit = memo.get(treeSha)
  if (hit) return hit
  const blobs = new Map<string, { mode: string; sha: string }>()
  const trees = new Set<string>([treeSha])
  const walk = (sha: string, prefix: string): void => {
    const rec = objects.get(sha)
    if (!rec) return
    for (const e of parseTree(rec.data)) {
      if (isDirMode(e.mode)) {
        trees.add(e.sha)
        walk(e.sha, prefix + e.name + '/')
      } else {
        blobs.set(prefix + e.name, { mode: e.mode, sha: e.sha })
      }
    }
  }
  walk(treeSha, '')
  const rec = { blobs, trees }
  memo.set(treeSha, rec)
  return rec
}

/**
 * Update a nested tree along a path. entry=null deletes. Returns the new tree
 * sha of this level, or null when this level becomes empty (callers drop it).
 */
export function updateTreePath(
  objects: ObjectStore,
  treeSha: string | null,
  segs: string[],
  entry: { mode: string; sha: string } | null,
): string | null {
  const rec = treeSha ? objects.get(treeSha) : undefined
  const entries = rec ? parseTree(rec.data) : []
  const name = segs[0]
  if (segs.length === 1) {
    const rest = entries.filter((e) => e.name !== name)
    if (entry) rest.push({ mode: entry.mode, name, sha: entry.sha })
    return objects.store('tree', serializeTree(rest))
  }
  const cur = entries.find((e) => e.name === name && isDirMode(e.mode))
  const newSub = updateTreePath(objects, cur ? cur.sha : null, segs.slice(1), entry)
  const rest = entries.filter((e) => e.name !== name)
  if (newSub !== null) rest.push({ mode: '40000', name, sha: newSub })
  return objects.store('tree', serializeTree(rest))
}

/** Walk a tree path to a blob entry. */
export function lookupPath(objects: ObjectStore, treeSha: string | null, segs: string[]): { mode: string; sha: string } | null {
  let cur: TreeEntry | null = treeSha ? { mode: '40000', name: '', sha: treeSha } : null
  for (let i = 0; i < segs.length; i++) {
    if (!cur) return null
    const rec = objects.get(cur.sha)
    if (!rec) return null
    const entries = parseTree(rec.data)
    const hit = entries.find((e) => e.name === segs[i]) ?? null
    if (!hit) return null
    if (i === segs.length - 1) return { mode: hit.mode, sha: hit.sha }
    if (!isDirMode(hit.mode)) return null
    cur = hit
  }
  return cur ? { mode: cur.mode, sha: cur.sha } : null
}

/** All ancestor commit shas of `sha` (inclusive), BFS with cap. */
export function ancestors(objects: ObjectStore, sha: string, cap = 20000): Set<string> {
  const seen = new Set<string>()
  const queue = [sha]
  seen.add(sha)
  while (queue.length && seen.size < cap) {
    const c = queue.shift()!
    const rec = objects.get(c)
    if (!rec) continue
    const commit = parseCommit(rec.data)
    for (const p of commit.parents) {
      if (!seen.has(p)) {
        seen.add(p)
        queue.push(p)
      }
    }
  }
  return seen
}

export function isAncestor(objects: ObjectStore, oldSha: string, newSha: string): boolean {
  if (oldSha === newSha) return true
  const seen = new Set<string>([newSha])
  const queue = [newSha]
  while (queue.length) {
    const c = queue.shift()!
    if (c === oldSha) return true
    const rec = objects.get(c)
    if (!rec) continue
    for (const p of parseCommit(rec.data).parents) {
      if (!seen.has(p)) {
        seen.add(p)
        queue.push(p)
      }
    }
  }
  return false
}

export function mergeBase(objects: ObjectStore, a: string, b: string): string | null {
  const ancA = ancestors(objects, a)
  const seen = new Set<string>([b])
  const queue = [b]
  while (queue.length) {
    const c = queue.shift()!
    if (ancA.has(c)) return c
    const rec = objects.get(c)
    if (!rec) continue
    for (const p of parseCommit(rec.data).parents) {
      if (!seen.has(p)) {
        seen.add(p)
        queue.push(p)
      }
    }
  }
  return null
}
