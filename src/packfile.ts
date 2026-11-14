// Packfile codec: parse incoming packs (full + delta objects), write packs for clone/fetch.
import zlib from 'node:zlib'
import crypto from 'node:crypto'

export const OBJ_COMMIT = 1
export const OBJ_TREE = 2
export const OBJ_BLOB = 3
export const OBJ_TAG = 4
export const OBJ_OFS_DELTA = 6
export const OBJ_REF_DELTA = 7

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag'

export const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 }
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }

export function sha1(type: string, data: Buffer): string {
  const h = crypto.createHash('sha1')
  h.update(`${type} ${data.length}\0`, 'latin1')
  h.update(data)
  return h.digest('hex')
}

/**
 * Inflate a zlib stream starting at buf[pos]. inflateSync tolerates trailing
 * bytes, so the exact compressed length is found by binary search on the
 * prefix that inflates cleanly to exactly expectedSize bytes.
 */
export function inflateAt(buf: Buffer, pos: number, expectedSize: number): { data: Buffer; end: number } {
  let lo = pos + 2
  let hi = buf.length
  let bestEnd = -1
  let bestData: Buffer | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    let ok = false
    let out: Buffer | null = null
    try {
      out = zlib.inflateSync(buf.subarray(pos, mid))
      ok = out.length === expectedSize
    } catch {
      ok = false
    }
    if (ok && out) {
      bestEnd = mid
      bestData = out
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  if (bestEnd === -1 || !bestData) throw new Error(`inflate failed at ${pos} (want ${expectedSize})`)
  return { data: bestData, end: bestEnd }
}

export interface PackSink {
  get(sha: string): { type: ObjType; data: Buffer } | undefined
  store(type: ObjType, data: Buffer): string
}

/** Parse a pack v2/v3 buffer, applying ofs/ref deltas, storing every object into sink. */
export function unpackPack(buf: Buffer, sink: PackSink): number {
  if (buf.length < 32 || buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('bad pack signature')
  const ver = buf.readUInt32BE(4)
  if (ver !== 2 && ver !== 3) throw new Error(`bad pack version ${ver}`)
  const count = buf.readUInt32BE(8)
  let pos = 12
  const offsetSha = new Map<number, string>()
  for (let i = 0; i < count; i++) {
    const objStart = pos
    let b = buf[pos++]
    const type = (b >> 4) & 7
    let size = b & 0x0f
    let shift = 4
    while (b & 0x80) {
      b = buf[pos++]
      size |= (b & 0x7f) << shift
      shift += 7
    }
    if (type === OBJ_OFS_DELTA) {
      let c = buf[pos++]
      let off = c & 0x7f
      while (c & 0x80) {
        c = buf[pos++]
        off = ((off + 1) << 7) | (c & 0x7f)
      }
      const r = inflateAt(buf, pos, size)
      pos = r.end
      const baseSha = offsetSha.get(objStart - off)
      if (!baseSha) throw new Error('bad ofs-delta base offset')
      const base = sink.get(baseSha)
      if (!base) throw new Error('ofs-delta base missing')
      offsetSha.set(objStart, sink.store(base.type, applyDelta(base.data, r.data)))
    } else if (type === OBJ_REF_DELTA) {
      const baseSha = buf.toString('hex', pos, pos + 20)
      pos += 20
      const r = inflateAt(buf, pos, size)
      pos = r.end
      const base = sink.get(baseSha)
      if (!base) throw new Error(`ref-delta base missing ${baseSha}`)
      offsetSha.set(objStart, sink.store(base.type, applyDelta(base.data, r.data)))
    } else {
      const t = NUM_TYPE[type]
      if (!t) throw new Error(`bad object type ${type}`)
      const r = inflateAt(buf, pos, size)
      pos = r.end
      offsetSha.set(objStart, sink.store(t, r.data))
    }
  }
  return count
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0
  const sizeVarint = (): number => {
    let r = 0
    let s = 0
    for (;;) {
      const b = delta[p++]
      r |= (b & 0x7f) << s
      if (!(b & 0x80)) break
      s += 7
    }
    return r
  }
  const srcSize = sizeVarint()
  const tgtSize = sizeVarint()
  if (srcSize !== base.length) throw new Error('delta base size mismatch')
  const out = Buffer.alloc(tgtSize)
  let o = 0
  while (p < delta.length) {
    const c = delta[p++]
    if (c & 0x80) {
      let off = 0
      let len = 0
      if (c & 0x01) off |= delta[p++]
      if (c & 0x02) off |= delta[p++] << 8
      if (c & 0x04) off |= delta[p++] << 16
      if (c & 0x08) off |= delta[p++] << 24
      if (c & 0x10) len |= delta[p++]
      if (c & 0x20) len |= delta[p++] << 8
      if (c & 0x40) len |= delta[p++] << 16
      if (len === 0) len = 0x10000
      base.copy(out, o, off, off + len)
      o += len
    } else if (c > 0) {
      delta.copy(out, o, p, p + c)
      p += c
      o += c
    } else {
      throw new Error('bad delta opcode 0')
    }
  }
  if (o !== tgtSize) throw new Error('delta target size mismatch')
  return out
}

/** Write a pack (full objects, no deltas) with trailing checksum. */
export function packObjects(objs: { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  const head = Buffer.alloc(12)
  head.write('PACK', 0, 'latin1')
  head.writeUInt32BE(2, 4)
  head.writeUInt32BE(objs.length, 8)
  parts.push(head)
  for (const o of objs) {
    let first = (TYPE_NUM[o.type] << 4) | (o.data.length & 0x0f)
    let size = o.data.length >> 4
    const hb: number[] = []
    while (size > 0) {
      hb.push(first | 0x80)
      first = size & 0x7f
      size >>= 7
    }
    hb.push(first)
    parts.push(Buffer.from(hb))
    parts.push(zlib.deflateSync(o.data, { level: 1 }))
  }
  const body = Buffer.concat(parts)
  const sum = crypto.createHash('sha1').update(body).digest()
  return Buffer.concat([body, sum])
}

// ---- pkt-line helpers ----

export function pkt(s: string | Buffer): Buffer {
  const d = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1')
  const hex = (d.length + 4).toString(16).padStart(4, '0')
  return Buffer.concat([Buffer.from(hex, 'latin1'), d])
}

export const FLUSH = Buffer.from('0000', 'latin1')
export const DELIM = Buffer.from('0001', 'latin1')

export interface PktLine {
  kind: 'data' | 'flush' | 'delim'
  data?: Buffer
}

export function readPkts(buf: Buffer): PktLine[] {
  const out: PktLine[] = []
  let p = 0
  while (p + 4 <= buf.length) {
    const hex = buf.toString('latin1', p, p + 4)
    const len = parseInt(hex, 16)
    if (Number.isNaN(len)) throw new Error('bad pkt-line length')
    if (len === 0) {
      out.push({ kind: 'flush' })
      p += 4
    } else if (len === 1) {
      out.push({ kind: 'delim' })
      p += 4
    } else if (len === 2) {
      out.push({ kind: 'flush' })
      p += 4
    } else {
      if (p + len > buf.length) throw new Error('truncated pkt-line')
      out.push({ kind: 'data', data: buf.subarray(p + 4, p + len) })
      p += len
    }
  }
  return out
}

export function sidebandChunk(band: number, data: Buffer, maxChunk = 65515): Buffer {
  const parts: Buffer[] = []
  for (let o = 0; o < data.length; o += maxChunk) {
    parts.push(pkt(Buffer.concat([Buffer.from([band]), data.subarray(o, o + maxChunk)])))
  }
  parts.push(FLUSH)
  return Buffer.concat(parts)
}
