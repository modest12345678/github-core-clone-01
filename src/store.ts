// Deterministic in-memory database engine: state tree, repository metadata, refs, issues, PRs, and monotonic logical clock.
import {
  ObjectStore,
  EMPTY_TREE,
  makeCommit,
  serializeTree,
  treeClosure,
  updateTreePath,
  parseTree,
  isDirMode,
  type TreeEntry,
} from './objects.ts'
import type { ObjType } from './packfile.ts'

// Monotonic logical epoch base: 2026-01-01T00:00:00.000Z
const BASE_TIMESTAMP_MS = 1767225600000

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
  readonly owner: string
  readonly name: string
  readonly dbId: number
  description = ''
  defaultBranch = 'main'
  isPrivate = false
  createdAt: Date
  updatedAt: Date
  pushedAt: Date
  numSeq = 0
  readonly issues = new Map<number, IssueRec>()
  readonly pulls = new Map<number, PullRec>()
  readonly labels = new Map<string, LabelRec>()
  readonly refs = new Map<string, string>()
  readonly packCache = new Map<string, Buffer>()

  constructor(repoOwner: string, repoName: string, initDate: Date, databaseId: number) {
    this.owner = repoOwner
    this.name = repoName
    this.createdAt = initDate
    this.updatedAt = initDate
    this.pushedAt = initDate
    this.dbId = databaseId
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`
  }

  refSha(refName: string): string | null {
    if (refName.startsWith('refs/')) {
      return this.refs.get(refName) ?? null
    }
    return null
  }

  branchSha(branchIdentifier: string): string | null {
    return this.refs.get(`refs/heads/${branchIdentifier}`) ?? null
  }

  setRef(referenceName: string, commitOid: string): void {
    this.refs.set(referenceName, commitOid)
    this.packCache.clear()
  }

  deleteRef(referenceName: string): void {
    this.refs.delete(referenceName)
    this.packCache.clear()
  }
}

export class Store {
  readonly objects = new ObjectStore()
  readonly repos = new Map<string, Repo>()
  clock = BASE_TIMESTAMP_MS
  reqCounter = 0
  repoId = 1000
  issueId = 2000
  pullId = 3000
  labelId = 4000
  commentId = 5000
  readonly login = process.env.MAKEFUN_LOGIN || 'adaiversen'
  readonly nodes = new Map<string, { kind: 'Repository' | 'Issue' | 'PullRequest'; repo: Repo; id: number }>()

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

  nodeId(typeName: string, entityId: number): string {
    return Buffer.from(`${typeName}:${entityId}`, 'latin1').toString('base64')
  }

  getRepo(userLogin: string, projectSlug: string): Repo | null {
    return this.repos.get(`${userLogin}/${projectSlug}`) ?? null
  }

  createRepo(
    repoSlug: string,
    descSummary = '',
    privateVisibility = false,
    creationTimestamp = this.tick(),
  ): Repo {
    this.repoId += 1
    const newRepoInstance = new Repo(this.login, repoSlug, creationTimestamp, this.repoId)
    newRepoInstance.description = descSummary
    newRepoInstance.isPrivate = privateVisibility
    this.repos.set(newRepoInstance.fullName, newRepoInstance)
    return newRepoInstance
  }

  // ---- contents / commit helpers ----

  writeFile(
    repository: Repo,
    targetBranch: string,
    filePath: string,
    fileBytes: Buffer | null,
    commitLogMessage: string,
    unixSeconds: number,
  ): { commit: string; blob: string | null } {
    const splitSegments = filePath.split('/').filter((seg) => seg.length > 0)
    let createdBlobSha: string | null = null
    if (fileBytes !== null) {
      createdBlobSha = this.objects.store('blob', fileBytes)
    }
    const currentTip = repository.branchSha(targetBranch)
    const rootTreeSha = currentTip ? this.commitTree(currentTip) : null
    const entrySpec = fileBytes === null ? null : { mode: '100644', sha: createdBlobSha! }
    const updatedTreeSha = updateTreePath(this.objects, rootTreeSha, splitSegments, entrySpec) ?? EMPTY_TREE
    const synthesizedCommit = makeCommit(this.objects, {
      tree: updatedTreeSha,
      parents: currentTip ? [currentTip] : [],
      message: commitLogMessage,
      tsSec: unixSeconds,
    })
    repository.setRef(`refs/heads/${targetBranch}`, synthesizedCommit)
    return { commit: synthesizedCommit, blob: createdBlobSha }
  }

  commitTree(commitOid: string): string {
    const commitObj = this.objects.get(commitOid)
    if (!commitObj) return EMPTY_TREE
    const match = commitObj.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m)
    return match ? match[1] : EMPTY_TREE
  }

  fileAt(repository: Repo, branchName: string, targetPath: string): { mode: string; sha: string } | null {
    const headTip = repository.branchSha(branchName)
    if (!headTip) return null
    const rootTree = this.commitTree(headTip)
    const pathParts = targetPath.split('/').filter((p) => p.length > 0)
    let currentLevel: TreeEntry | null = { mode: '40000', name: '', sha: rootTree }
    for (let i = 0; i < pathParts.length; i++) {
      if (!currentLevel) return null
      const treeRec = this.objects.get(currentLevel.sha)
      if (!treeRec) return null
      const matchedEntry = parseTree(treeRec.data).find((e) => e.name === pathParts[i])
      if (!matchedEntry) return null
      if (i === pathParts.length - 1) return { mode: matchedEntry.mode, sha: matchedEntry.sha }
      if (!isDirMode(matchedEntry.mode)) return null
      currentLevel = matchedEntry
    }
    return currentLevel ? { mode: currentLevel.mode, sha: currentLevel.sha } : null
  }

  listDir(repository: Repo, branchName: string, folderPath: string): Array<{ mode: string; name: string; sha: string; kind: 'file' | 'dir' }> {
    const headTip = repository.branchSha(branchName)
    if (!headTip) return []
    const rootTree = this.commitTree(headTip)
    const folderSegments = folderPath.split('/').filter((s) => s.length > 0)
    let activeDirSha = rootTree
    for (const folderSeg of folderSegments) {
      const treeRec = this.objects.get(activeDirSha)
      if (!treeRec) return []
      const childDir = parseTree(treeRec.data).find((e) => e.name === folderSeg && isDirMode(e.mode))
      if (!childDir) return []
      activeDirSha = childDir.sha
    }
    const finalTree = this.objects.get(activeDirSha)
    if (!finalTree) return []
    return parseTree(finalTree.data).map((entry) => ({
      mode: entry.mode,
      name: entry.name,
      sha: entry.sha,
      kind: isDirMode(entry.mode) ? 'dir' : 'file',
    }))
  }

  // ---- merge helpers ----

  /** Squash-merge `pull`: tree from head, single parent = base tip, onto base branch. */
  squashMerge(repository: Repo, pullRequest: PullRec, mergeMsg: string, unixTimestamp: number): string {
    const headCommit = repository.branchSha(pullRequest.headRef)
    if (!headCommit) throw new Error('head branch missing')
    const headTreeSha = this.commitTree(headCommit)
    const baseCommit = repository.branchSha(pullRequest.baseRef) ?? ''
    const mergedSha = makeCommit(this.objects, {
      tree: headTreeSha,
      parents: [baseCommit],
      message: mergeMsg,
      tsSec: unixTimestamp,
    })
    repository.setRef(`refs/heads/${pullRequest.baseRef}`, mergedSha)
    return mergedSha
  }

  changedPathsBetween(
    sourceTreeSha: string | null,
    targetTreeSha: string | null,
  ): Map<string, { a: { mode: string; sha: string } | null; b: { mode: string; sha: string } | null }> {
    const pathMap = new Map<string, { a: { mode: string; sha: string } | null; b: { mode: string; sha: string } | null }>()
    const recordFileSide = (fPath: string, branchSide: 'a' | 'b', entryVal: { mode: string; sha: string } | null): void => {
      const existingRecord = pathMap.get(fPath) ?? { a: null, b: null }
      existingRecord[branchSide] = entryVal
      pathMap.set(fPath, existingRecord)
    }
    if (sourceTreeSha) {
      for (const [blobPath, blobData] of treeClosure(this.objects, sourceTreeSha).blobs) {
        recordFileSide(blobPath, 'a', blobData)
      }
    }
    if (targetTreeSha) {
      for (const [blobPath, blobData] of treeClosure(this.objects, targetTreeSha).blobs) {
        recordFileSide(blobPath, 'b', blobData)
      }
    }
    return pathMap
  }

  /** 3-way conflict check for a pull request. Returns true when conflicted. */
  isConflicted(repository: Repo, pullRequest: PullRec): boolean {
    const headCommitSha = repository.branchSha(pullRequest.headRef)
    const baseCommitSha = repository.branchSha(pullRequest.baseRef)
    if (!headCommitSha || !baseCommitSha) return false
    const baseAncestorSet = new Set<string>([baseCommitSha])
    const searchQueue = [baseCommitSha]
    while (searchQueue.length) {
      const currentOid = searchQueue.shift()!
      const rec = this.objects.get(currentOid)
      if (!rec) continue
      for (const line of rec.data.toString('utf8').split('\n')) {
        if (line.startsWith('parent ')) {
          const p = line.slice(7).trim()
          if (!baseAncestorSet.has(p)) {
            baseAncestorSet.add(p)
            searchQueue.push(p)
          }
        } else if (line === '') break
      }
    }
    let commonBaseOid: string | null = null
    const headVisited = new Set<string>([headCommitSha])
    const headQueue = [headCommitSha]
    while (headQueue.length) {
      const curHeadOid = headQueue.shift()!
      if (baseAncestorSet.has(curHeadOid)) {
        commonBaseOid = curHeadOid
        break
      }
      const rec = this.objects.get(curHeadOid)
      if (!rec) continue
      for (const line of rec.data.toString('utf8').split('\n')) {
        if (line.startsWith('parent ')) {
          const p = line.slice(7).trim()
          if (!headVisited.has(p)) {
            headVisited.add(p)
            headQueue.push(p)
          }
        } else if (line === '') break
      }
    }
    const baseTreeOid = this.commitTree(baseCommitSha)
    const headTreeOid = this.commitTree(headCommitSha)
    const commonTreeOid = commonBaseOid ? this.commitTree(commonBaseOid) : null
    const baseDiff = this.changedPathsBetween(commonTreeOid, baseTreeOid)
    const headDiff = this.changedPathsBetween(commonTreeOid, headTreeOid)
    for (const [diffPath, headBlob] of headDiff) {
      const baseBlob = baseDiff.get(diffPath)
      if (!baseBlob) continue
      const baseModified = (baseBlob.a?.sha ?? null) !== (baseBlob.b?.sha ?? null)
      const headModified = (headBlob.a?.sha ?? null) !== (headBlob.b?.sha ?? null)
      if (!baseModified || !headModified) continue
      const baseVersionSha = baseBlob.b?.sha ?? null
      const headVersionSha = headBlob.b?.sha ?? null
      if (baseVersionSha !== headVersionSha) return true
    }
    return false
  }
}

export function storeObject(targetStore: Store, objectKind: ObjType, binaryPayload: Buffer): string {
  return targetStore.objects.store(objectKind, binaryPayload)
}

export function emptyTreeSha(targetStore: Store): string {
  if (!targetStore.objects.has(EMPTY_TREE)) {
    targetStore.objects.store('tree', serializeTree([]))
  }
  return EMPTY_TREE
}
