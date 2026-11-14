// Core Git object storage, tree graph serialization, commit synthesis, and ancestry traversal.
import { sha1, type ObjType } from './packfile.ts'

export interface ObjRec {
  type: ObjType
  data: Buffer
}

export class ObjectStore {
  readonly map = new Map<string, ObjRec>()
  readonly treeMemo = new Map<string, { blobs: Map<string, { mode: string; sha: string }>; trees: Set<string> }>()

  store(objType: ObjType, rawBytes: Buffer): string {
    const objectHash = sha1(objType, rawBytes)
    if (!this.map.has(objectHash)) {
      this.map.set(objectHash, { type: objType, data: rawBytes })
    }
    return objectHash
  }

  get(hash: string): ObjRec | undefined {
    return this.map.get(hash)
  }

  has(hash: string): boolean {
    return this.map.has(hash)
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

export function parseCommit(commitBytes: Buffer): CommitRec {
  const fullText = commitBytes.toString('utf8')
  const splitPoint = fullText.indexOf('\n\n')
  const headerSection = splitPoint === -1 ? fullText : fullText.slice(0, splitPoint)
  const commitMsg = splitPoint === -1 ? '' : fullText.slice(splitPoint + 2)
  let treeOid = ''
  const parentOids: string[] = []
  let authorSig = ''
  let committerSig = ''
  for (const rawLine of headerSection.split('\n')) {
    if (rawLine.startsWith('tree ')) {
      treeOid = rawLine.slice(5).trim()
    } else if (rawLine.startsWith('parent ')) {
      parentOids.push(rawLine.slice(7).trim())
    } else if (rawLine.startsWith('author ')) {
      authorSig = rawLine.slice(7)
    } else if (rawLine.startsWith('committer ')) {
      committerSig = rawLine.slice(10)
    }
  }
  return {
    tree: treeOid,
    parents: parentOids,
    author: authorSig,
    committer: committerSig,
    message: commitMsg,
  }
}

export interface TreeEntry {
  mode: string
  name: string
  sha: string
}

export function isDirMode(entryMode: string): boolean {
  return entryMode === '40000' || entryMode === '040000'
}

export function parseTree(treeBuffer: Buffer): TreeEntry[] {
  const parsedEntries: TreeEntry[] = []
  let cursor = 0
  while (cursor < treeBuffer.length) {
    const spaceOffset = treeBuffer.indexOf(32, cursor)
    const nullOffset = treeBuffer.indexOf(0, spaceOffset)
    if (spaceOffset === -1 || nullOffset === -1 || nullOffset + 21 > treeBuffer.length) {
      break
    }
    const itemMode = treeBuffer.toString('latin1', cursor, spaceOffset)
    const itemName = treeBuffer.toString('utf8', spaceOffset + 1, nullOffset)
    const itemSha = treeBuffer.toString('hex', nullOffset + 1, nullOffset + 21)
    parsedEntries.push({ mode: itemMode, name: itemName, sha: itemSha })
    cursor = nullOffset + 21
  }
  return parsedEntries
}

export function serializeTree(treeItems: TreeEntry[]): Buffer {
  const ordered = [...treeItems].sort((left, right) => {
    const leftPath = left.name + (isDirMode(left.mode) ? '/' : '')
    const rightPath = right.name + (isDirMode(right.mode) ? '/' : '')
    return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0
  })
  const chunks: Buffer[] = []
  for (const item of ordered) {
    chunks.push(Buffer.from(`${item.mode} ${item.name}\0`, 'utf8'))
    chunks.push(Buffer.from(item.sha, 'hex'))
  }
  return Buffer.concat(chunks)
}

export function makeCommit(
  storage: ObjectStore,
  params: { tree: string; parents: string[]; message: string; tsSec: number; who?: string },
): string {
  const authorIdentity = `${params.who ?? 'Forge <forge@forge.local>'} ${params.tsSec} +0000`
  const commitLines = [`tree ${params.tree}`]
  for (const parentSha of params.parents) {
    commitLines.push(`parent ${parentSha}`)
  }
  commitLines.push(`author ${authorIdentity}`, `committer ${authorIdentity}`, '', params.message, '')
  return storage.store('commit', Buffer.from(commitLines.join('\n'), 'utf8'))
}

/** Full recursive closure of a tree: blob paths + all tree shas (memoized). */
export function treeClosure(storage: ObjectStore, rootTreeSha: string): {
  blobs: Map<string, { mode: string; sha: string }>
  trees: Set<string>
} {
  const cache = storage.treeMemo
  const existing = cache.get(rootTreeSha)
  if (existing) return existing
  const collectedBlobs = new Map<string, { mode: string; sha: string }>()
  const collectedTrees = new Set<string>([rootTreeSha])
  const traverse = (currentSha: string, currentPrefix: string): void => {
    const itemRecord = storage.get(currentSha)
    if (!itemRecord) return
    for (const treeElem of parseTree(itemRecord.data)) {
      if (isDirMode(treeElem.mode)) {
        collectedTrees.add(treeElem.sha)
        traverse(treeElem.sha, currentPrefix + treeElem.name + '/')
      } else {
        collectedBlobs.set(currentPrefix + treeElem.name, { mode: treeElem.mode, sha: treeElem.sha })
      }
    }
  }
  traverse(rootTreeSha, '')
  const closureResult = { blobs: collectedBlobs, trees: collectedTrees }
  cache.set(rootTreeSha, closureResult)
  return closureResult
}

/**
 * Update a nested tree along a path. entry=null deletes. Returns the new tree
 * sha of this level, or null when this level becomes empty (callers drop it).
 */
export function updateTreePath(
  storage: ObjectStore,
  currentTreeSha: string | null,
  pathSegments: string[],
  leafEntry: { mode: string; sha: string } | null,
): string | null {
  const record = currentTreeSha ? storage.get(currentTreeSha) : undefined
  const existingList = record ? parseTree(record.data) : []
  const headSegment = pathSegments[0]
  if (pathSegments.length === 1) {
    const filtered = existingList.filter((elem) => elem.name !== headSegment)
    if (leafEntry) {
      filtered.push({ mode: leafEntry.mode, name: headSegment, sha: leafEntry.sha })
    }
    return storage.store('tree', serializeTree(filtered))
  }
  const childSubtree = existingList.find((elem) => elem.name === headSegment && isDirMode(elem.mode))
  const updatedChildSha = updateTreePath(storage, childSubtree ? childSubtree.sha : null, pathSegments.slice(1), leafEntry)
  const remaining = existingList.filter((elem) => elem.name !== headSegment)
  if (updatedChildSha !== null) {
    remaining.push({ mode: '40000', name: headSegment, sha: updatedChildSha })
  }
  return storage.store('tree', serializeTree(remaining))
}

/** Walk a tree path to a blob entry. */
export function lookupPath(
  storage: ObjectStore,
  initialTreeSha: string | null,
  segments: string[],
): { mode: string; sha: string } | null {
  let activeEntry: TreeEntry | null = initialTreeSha ? { mode: '40000', name: '', sha: initialTreeSha } : null
  for (let idx = 0; idx < segments.length; idx++) {
    if (!activeEntry) return null
    const record = storage.get(activeEntry.sha)
    if (!record) return null
    const entries = parseTree(record.data)
    const match = entries.find((elem) => elem.name === segments[idx]) ?? null
    if (!match) return null
    if (idx === segments.length - 1) return { mode: match.mode, sha: match.sha }
    if (!isDirMode(match.mode)) return null
    activeEntry = match
  }
  return activeEntry ? { mode: activeEntry.mode, sha: activeEntry.sha } : null
}

/** All ancestor commit shas of `targetSha` (inclusive), BFS with cap. */
export function ancestors(storage: ObjectStore, targetSha: string, maxCap = 20000): Set<string> {
  const visitedSet = new Set<string>()
  const pendingQueue = [targetSha]
  visitedSet.add(targetSha)
  while (pendingQueue.length && visitedSet.size < maxCap) {
    const commitId = pendingQueue.shift()!
    const rec = storage.get(commitId)
    if (!rec) continue
    const parsed = parseCommit(rec.data)
    for (const pSha of parsed.parents) {
      if (!visitedSet.has(pSha)) {
        visitedSet.add(pSha)
        pendingQueue.push(pSha)
      }
    }
  }
  return visitedSet
}

export function isAncestor(storage: ObjectStore, ancestorCandidate: string, descendantSha: string): boolean {
  if (ancestorCandidate === descendantSha) return true
  const visited = new Set<string>([descendantSha])
  const searchQueue = [descendantSha]
  while (searchQueue.length) {
    const currentSha = searchQueue.shift()!
    if (currentSha === ancestorCandidate) return true
    const rec = storage.get(currentSha)
    if (!rec) continue
    for (const parentId of parseCommit(rec.data).parents) {
      if (!visited.has(parentId)) {
        visited.add(parentId)
        searchQueue.push(parentId)
      }
    }
  }
  return false
}

export function mergeBase(storage: ObjectStore, commitAlpha: string, commitBeta: string): string | null {
  const alphaAncestors = ancestors(storage, commitAlpha)
  const visitedBeta = new Set<string>([commitBeta])
  const betaQueue = [commitBeta]
  while (betaQueue.length) {
    const currentBetaSha = betaQueue.shift()!
    if (alphaAncestors.has(currentBetaSha)) return currentBetaSha
    const rec = storage.get(currentBetaSha)
    if (!rec) continue
    for (const p of parseCommit(rec.data).parents) {
      if (!visitedBeta.has(p)) {
        visitedBeta.add(p)
        betaQueue.push(p)
      }
    }
  }
  return null
}
