// Git smart HTTP: upload-pack v2 (+v0 fallback), receive-pack v0, info/refs advertisements.
import type http from 'node:http'
import {
  pkt,
  FLUSH,
  DELIM,
  readPkts,
  packObjects,
  unpackPack,
  sidebandChunk,
  type ObjType,
} from './packfile.ts'
import { treeClosure, isAncestor, type ObjectStore } from './objects.ts'
import type { Store, Repo } from './store.ts'

const ZERO = '0000000000000000000000000000000000000000'
const AGENT = 'agent=forge/1.0'

function gitRes(res: http.ServerResponse, status: number, contentType: string, body: Buffer | string): void {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Content-Length': String(buf.length),
  })
  res.end(buf)
}

const ADV_CONTENT_UPLOAD = 'application/x-git-upload-pack-advertisement'
const ADV_CONTENT_RECEIVE = 'application/x-git-receive-pack-advertisement'
const UPLOAD_CONTENT = 'application/x-git-upload-pack-result'
const RECEIVE_CONTENT = 'application/x-git-receive-pack-result'

function sortedRefs(repo: Repo): Array<{ name: string; sha: string }> {
  const out: Array<{ name: string; sha: string }> = []
  for (const name of repo.refs.keys()) out.push({ name, sha: repo.refs.get(name)! })
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

// ---- advertisements ----

function advUploadV2(res: http.ServerResponse): void {
  const body = Buffer.concat([
    pkt('version 2\n'),
    pkt(AGENT + '\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    FLUSH,
  ])
  gitRes(res, 200, ADV_CONTENT_UPLOAD, body)
}

function refAdvertisement(repo: Repo, caps: string, includeHead: boolean): Buffer {
  const parts: Buffer[] = []
  const refs = sortedRefs(repo)
  const mainSha = repo.branchSha(repo.defaultBranch)
  let capsSent = false
  if (includeHead && mainSha) {
    parts.push(pkt(`${mainSha} HEAD\0${caps}\n`))
    capsSent = true
  }
  let first = true
  for (const r of refs) {
    if (first && !capsSent) {
      parts.push(pkt(`${r.sha} ${r.name}\0${caps}\n`))
      capsSent = true
    } else {
      parts.push(pkt(`${r.sha} ${r.name}\n`))
    }
    first = false
  }
  if (!capsSent) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`))
  }
  parts.push(FLUSH)
  return Buffer.concat(parts)
}

function advUploadV0(res: http.ServerResponse, repo: Repo): void {
  const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta ${AGENT}`
  const body = Buffer.concat([pkt(`# service=git-upload-pack\n`), FLUSH, refAdvertisement(repo, caps, true)])
  gitRes(res, 200, ADV_CONTENT_UPLOAD, body)
}

function advReceiveV0(res: http.ServerResponse, repo: Repo): void {
  const caps = `report-status delete-refs side-band-64k ofs-delta quiet ${AGENT}`
  const body = Buffer.concat([pkt(`# service=git-receive-pack\n`), FLUSH, refAdvertisement(repo, caps, false)])
  gitRes(res, 200, ADV_CONTENT_RECEIVE, body)
}

// ---- v2 ls-refs ----

function peelRef(objects: ObjectStore, sha: string): string | null {
  let cur = sha
  for (let i = 0; i < 10; i++) {
    const obj = objects.get(cur)
    if (!obj || obj.type !== 'tag') {
      return cur !== sha ? cur : null
    }
    const m = obj.data.toString('utf8').match(/^object ([0-9a-f]{40})/m)
    if (!m) return null
    cur = m[1]
  }
  return null
}

function lsRefs(store: Store, repo: Repo, args: string[], res: http.ServerResponse): void {
  const prefixes: string[] = []
  let symrefs = false
  let peel = false
  let unborn = false
  for (const a of args) {
    if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length))
    else if (a === 'symrefs') symrefs = true
    else if (a === 'peel') peel = true
    else if (a === 'unborn') unborn = true
  }
  const match = (name: string): boolean => {
    if (prefixes.length === 0) return true
    return prefixes.some((p) => name.startsWith(p))
  }
  const parts: Buffer[] = []
  const mainSha = repo.branchSha(repo.defaultBranch)
  if (mainSha) {
    if (match('HEAD')) {
      const sym = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''
      parts.push(pkt(`${mainSha} HEAD${sym}\n`))
    }
  } else if (unborn && match('HEAD')) {
    const sym = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''
    parts.push(pkt(`unborn HEAD${sym}\n`))
  }
  for (const r of sortedRefs(repo)) {
    if (!match(r.name)) continue
    const peeled = peel ? peelRef(store.objects, r.sha) : null
    const peelPart = peeled ? ` peeled:${peeled}` : ''
    parts.push(pkt(`${r.sha} ${r.name}${peelPart}\n`))
  }
  parts.push(FLUSH)
  gitRes(res, 200, UPLOAD_CONTENT, Buffer.concat(parts))
}

// ---- pack assembly for fetch ----

function gatherObjects(store: Store, repo: Repo, wantTips: string[], excludeTips: string[], maxDepth: number): {
  objs: Array<{ type: ObjType; data: Buffer }>
  shallow: string[]
} {
  const objects = store.objects
  const commits: string[] = []
  const shallow: string[] = []
  if (maxDepth > 0) {
    const depth = new Map<string, number>()
    const queue: string[] = []
    for (const w of wantTips) {
      if (!depth.has(w) && objects.has(w)) {
        depth.set(w, 1)
        queue.push(w)
      }
    }
    while (queue.length) {
      const c = queue.shift()!
      const d = depth.get(c)!
      if (d >= maxDepth) {
        shallow.push(c)
        commits.push(c)
        continue
      }
      commits.push(c)
      const rec = objects.get(c)
      if (!rec) continue
      for (const line of rec.data.toString('utf8').split('\n')) {
        if (line === '') break
        if (line.startsWith('parent ')) {
          const p = line.slice(7).trim()
          if (!depth.has(p) && objects.has(p)) {
            depth.set(p, d + 1)
            queue.push(p)
          }
        }
      }
    }
  } else {
    for (const w of wantTips) {
      const anc = new Set<string>([w])
      const q = [w]
      while (q.length) {
        const c = q.shift()!
        commits.push(c)
        const rec = objects.get(c)
        if (!rec) continue
        for (const line of rec.data.toString('utf8').split('\n')) {
          if (line === '') break
          if (line.startsWith('parent ')) {
            const p = line.slice(7).trim()
            if (!anc.has(p) && objects.has(p)) {
              anc.add(p)
              q.push(p)
            }
          }
        }
      }
    }
  }
  const exclude = new Set<string>()
  if (maxDepth === 0) {
    for (const h of excludeTips) {
      const anc = new Set<string>([h])
      const q = [h]
      while (q.length) {
        const c = q.shift()!
        exclude.add(c)
        const rec = objects.get(c)
        if (!rec) continue
        for (const line of rec.data.toString('utf8').split('\n')) {
          if (line === '') break
          if (line.startsWith('parent ')) {
            const p = line.slice(7).trim()
            if (!anc.has(p) && objects.has(p)) {
              anc.add(p)
              q.push(p)
            }
          }
        }
        const tree = store.commitTree(c)
        if (objects.has(tree)) {
          const closure = treeClosure(objects, tree)
          for (const t of closure.trees) exclude.add(t)
          for (const blob of closure.blobs.values()) exclude.add(blob.sha)
        }
      }
    }
  } else {
    for (const h of excludeTips) {
      exclude.add(h)
    }
  }
  const seen = new Set<string>()
  const objs: Array<{ type: ObjType; data: Buffer }> = []
  const pushObj = (sha: string): void => {
    if (seen.has(sha) || exclude.has(sha)) return
    const rec = objects.get(sha)
    if (!rec) return
    seen.add(sha)
    objs.push({ type: rec.type, data: rec.data })
  }
  for (const c of commits) {
    pushObj(c)
    const tree = store.commitTree(c)
    const closure = treeClosure(objects, tree)
    for (const t of closure.trees) pushObj(t)
    for (const b of closure.blobs.values()) pushObj(b.sha)
  }
  return { objs, shallow }
}

function v2Fetch(store: Store, repo: Repo, args: string[], res: http.ServerResponse): void {
  const wants: string[] = []
  const haves: string[] = []
  let done = false
  let deepen = 0
  let sideband = false
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim())
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim())
    else if (a === 'done') done = true
    else if (a.startsWith('deepen ')) deepen = parseInt(a.slice(7), 10)
    else if (a === 'sideband-64k') sideband = true
    else if (a === 'thin-pack' || a === 'no-progress' || a === 'include-tag' || a === 'ofs-delta' || a.startsWith('filter ') || a.startsWith('shallow ') || a === 'deepen-relative' || a.startsWith('deepen-not ') || a === 'wait-for-done' || a === 'sideband-all') {
      // accepted, no special handling needed
    }
  }
  const validWants = wants.filter((w) => store.objects.has(w))
  if (!done) {
    const body = Buffer.concat([pkt('acknowledgments\n'), pkt('nak\n'), FLUSH])
    gitRes(res, 200, UPLOAD_CONTENT, body)
    return
  }
  const { objs, shallow } = gatherObjects(store, repo, validWants, haves, deepen > 0 ? deepen : 0)
  const parts: Buffer[] = []
  if (shallow.length > 0) {
    parts.push(pkt('shallow-info\n'))
    for (const s of shallow) parts.push(pkt(`shallow ${s}\n`))
    parts.push(DELIM)
  }
  parts.push(pkt('packfile\n'))
  const pack = packObjects(objs)
  parts.push(sidebandChunk(1, pack))
  gitRes(res, 200, UPLOAD_CONTENT, Buffer.concat(parts))
}

// ---- v0 upload-pack ----

function v0UploadPack(store: Store, repo: Repo, body: Buffer, res: http.ServerResponse): void {
  const lines = readPkts(body)
  const wants: string[] = []
  const haves: string[] = []
  let sideband = false
  let done = false
  for (const l of lines) {
    if (l.kind !== 'data' || !l.data) continue
    const s = l.data.toString('latin1').replace(/\n$/, '')
    if (s.startsWith('want ')) {
      const rest = s.slice(5)
      const sp = rest.indexOf(' ')
      const sha = sp === -1 ? rest : rest.slice(0, sp)
      const caps = sp === -1 ? '' : rest.slice(sp + 1)
      if (caps.includes('side-band-64k')) sideband = true
      wants.push(sha)
    } else if (s.startsWith('have ')) {
      haves.push(s.slice(5).trim())
    } else if (s === 'done') {
      done = true
    }
  }
  const parts: Buffer[] = []
  parts.push(pkt('nak\n'))
  const valid = wants.filter((w) => store.objects.has(w))
  const { objs } = gatherObjects(store, repo, valid, haves, 0)
  const pack = packObjects(objs)
  if (sideband) parts.push(sidebandChunk(1, pack))
  else parts.push(pack)
  gitRes(res, 200, UPLOAD_CONTENT, Buffer.concat(parts))
  void done
}

// ---- receive-pack ----

interface RecvCmd {
  old: string
  new: string
  ref: string
}

function receivePack(store: Store, repo: Repo, body: Buffer, res: http.ServerResponse): void {
  // scan command pkt-lines manually; raw pack bytes follow the first flush
  const cmds: RecvCmd[] = []
  let caps = ''
  let p = 0
  let sawFlush = false
  while (p + 4 <= body.length) {
    const len = parseInt(body.toString('latin1', p, p + 4), 16)
    if (Number.isNaN(len)) break
    if (len === 0) {
      p += 4
      sawFlush = true
      break
    }
    if (len === 1) {
      p += 4
      continue
    }
    if (len === 2) {
      p += 4
      sawFlush = true
      break
    }
    if (len < 4) break
    if (p + len > body.length) break
    const s = body.toString('latin1', p + 4, p + len)
    p += len
    const nul = s.indexOf('\0')
    const base = nul === -1 ? s : s.slice(0, nul)
    if (nul !== -1 && caps === '') caps = s.slice(nul + 1).replace(/\n$/, '')
    const clean = base.replace(/\n$/, '')
    if (clean.startsWith('shallow ') || clean.startsWith('unshallow ')) continue
    const m = clean.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/)
    if (m) cmds.push({ old: m[1], new: m[2], ref: m[3] })
  }
  const packBuf = sawFlush ? body.subarray(p) : null
  if (process.env.FORGE_DEBUG) {
    console.error(`[recv] bodyLen=${body.length} p=${p} sawFlush=${sawFlush} packLen=${packBuf ? packBuf.length : -1} head=${packBuf ? packBuf.toString('latin1', 0, 12) : ''}`)
  }
  const wantReport = caps.includes('report-status')
  const wantSideband = caps.includes('side-band-64k')
  const report: string[] = []
  let unpackOk = true
  if (packBuf && packBuf.length >= 32) {
    try {
      unpackPack(packBuf, {
        get: (sha) => store.objects.get(sha),
        store: (type: ObjType, data: Buffer) => store.objects.store(type, data),
      })
    } catch (e) {
      unpackOk = false
      report.push(`unpack ${(e as Error).message}\n`)
      for (const c of cmds) report.push(`ng ${c.ref} n/a (unpack error)\n`)
    }
  }
  if (unpackOk) {
    report.push('unpack ok\n')
    let touched = false
    for (const c of cmds) {
      const cur = repo.refs.get(c.ref) ?? ZERO
      if (process.env.FORGE_DEBUG) {
        console.error(`[recv] cmd old=${c.old.slice(0, 8)} new=${c.new.slice(0, 8)} ref=${c.ref} cur=${cur.slice(0, 8)} hasNew=${store.objects.has(c.new)} hasOld=${store.objects.has(c.old)}`)
      }
      let ok = false
      if (c.new === ZERO) {
        if (cur !== ZERO && c.old === cur) {
          repo.deleteRef(c.ref)
          ok = true
        }
        if (!ok) report.push(`ng ${c.ref} non-fast-forward\n`)
      } else if (cur === ZERO) {
        if (!repo.refs.has(c.ref)) {
          repo.setRef(c.ref, c.new)
          ok = true
        }
        if (!ok) report.push(`ng ${c.ref} non-fast-forward\n`)
      } else if (c.old !== cur) {
        report.push(`ng ${c.ref} non-fast-forward\n`)
      } else if (c.new === c.old) {
        ok = true
      } else if (isAncestor(store.objects, c.old, c.new)) {
        repo.setRef(c.ref, c.new)
        ok = true
      } else {
        report.push(`ng ${c.ref} non-fast-forward\n`)
      }
      if (ok) report.push(`ok ${c.ref}\n`)
    }
    if (touched) {
      void touched
    }
  }
  if (!wantReport) {
    gitRes(res, 200, RECEIVE_CONTENT, FLUSH)
    return
  }
  const reportBuf = Buffer.concat([...report.map((s) => pkt(s)), FLUSH])
  const out = wantSideband ? sidebandChunk(1, reportBuf) : reportBuf
  gitRes(res, 200, RECEIVE_CONTENT, out)
}

// ---- v2 command dispatch ----

function v2UploadPack(store: Store, repo: Repo, body: Buffer, res: http.ServerResponse): void {
  const lines = readPkts(body)
  let command = ''
  const args: string[] = []
  let inArgs = false
  for (const l of lines) {
    if (l.kind === 'delim') {
      inArgs = true
      continue
    }
    if (l.kind === 'flush') break
    if (l.kind === 'data' && l.data) {
      const s = l.data.toString('latin1').replace(/\n$/, '')
      if (!inArgs && s.startsWith('command=')) command = s.slice(8)
      else if (inArgs) args.push(s)
    }
  }
  if (command === 'ls-refs') lsRefs(store, repo, args, res)
  else if (command === 'fetch') v2Fetch(store, repo, args, res)
  else gitRes(res, 400, UPLOAD_CONTENT, pkt(`err unknown command ${command}\n`) + FLUSH)
}

// ---- entry ----

export function handleGit(
  store: Store,
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: http.IncomingHttpHeaders,
  body: Buffer,
  res: http.ServerResponse,
): boolean {
  const m = pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/)
  if (!m) return false
  const [, owner, name, action] = m
  const proto = String(headers['git-protocol'] ?? '')
  const v2 = proto.includes('version=2')
  if (action === 'info/refs') {
    if (method !== 'GET') {
      gitRes(res, 405, 'application/json', JSON.stringify({ message: 'method not allowed' }))
      return true
    }
    const service = query.get('service')
    const repo = store.getRepo(owner, name)
    if (!repo) {
      gitRes(res, 404, 'application/json', JSON.stringify({ message: 'Not Found' }))
      return true
    }
    if (service === 'git-upload-pack') {
      if (v2) advUploadV2(res)
      else advUploadV0(res, repo)
    } else if (service === 'git-receive-pack') {
      advReceiveV0(res, repo)
    } else {
      gitRes(res, 400, 'application/json', JSON.stringify({ message: 'dumb http protocol not supported' }))
    }
    return true
  }
  const repo = store.getRepo(owner, name)
  if (!repo) {
    gitRes(res, 404, 'application/json', JSON.stringify({ message: 'Not Found' }))
    return true
  }
  if (action === 'git-upload-pack') {
    if (method !== 'POST') {
      gitRes(res, 405, 'application/json', JSON.stringify({ message: 'method not allowed' }))
      return true
    }
    // v2 request bodies start with a "command=..." pkt-line
    const firstLen = parseInt(body.toString('latin1', 0, 4), 16)
    const firstLine = firstLen > 4 ? body.toString('latin1', 4, Math.min(firstLen, body.length)) : ''
    if (firstLine.startsWith('command=')) v2UploadPack(store, repo, body, res)
    else v0UploadPack(store, repo, body, res)
    return true
  }
  if (action === 'git-receive-pack') {
    if (method !== 'POST') {
      gitRes(res, 405, 'application/json', JSON.stringify({ message: 'method not allowed' }))
      return true
    }
    receivePack(store, repo, body, res)
    return true
  }
  return false
}
