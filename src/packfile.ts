// Packfile binary codec: delta unpacking, object inflation, pack assembly, and pkt-line transport framing.
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
const NUM_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' }

export function sha1(objectKind: string, payload: Buffer): string {
  const hasher = crypto.createHash('sha1')
  hasher.update(`${objectKind} ${payload.length}\0`, 'latin1')
  hasher.update(payload)
  return hasher.digest('hex')
}

/**
 * Inflate a zlib stream starting at inputBuffer[offset]. inflateSync tolerates trailing
 * bytes, so the exact compressed length is found by binary search on the
 * prefix that inflates cleanly to exactly targetSize bytes.
 */
export function inflateAt(
  inputBuffer: Buffer,
  startOffset: number,
  targetSize: number,
): { data: Buffer; end: number } {
  let lowerBound = startOffset + 2
  let upperBound = inputBuffer.length
  let finalEnd = -1
  let decompressedBytes: Buffer | null = null
  while (lowerBound <= upperBound) {
    const candidateEnd = (lowerBound + upperBound) >> 1
    let success = false
    let candidateOut: Buffer | null = null
    try {
      candidateOut = zlib.inflateSync(inputBuffer.subarray(startOffset, candidateEnd))
      success = candidateOut.length === targetSize
    } catch {
      success = false
    }
    if (success && candidateOut) {
      finalEnd = candidateEnd
      decompressedBytes = candidateOut
      upperBound = candidateEnd - 1
    } else {
      lowerBound = candidateEnd + 1
    }
  }
  if (finalEnd === -1 || !decompressedBytes) {
    throw new Error(`inflate failed at ${startOffset} (want ${targetSize})`)
  }
  return { data: decompressedBytes, end: finalEnd }
}

export interface PackSink {
  get(sha: string): { type: ObjType; data: Buffer } | undefined
  store(type: ObjType, data: Buffer): string
}

/** Parse a pack v2/v3 buffer, applying ofs/ref deltas, storing every object into sink. */
export function unpackPack(packRaw: Buffer, targetSink: PackSink): number {
  if (packRaw.length < 32 || packRaw.toString('latin1', 0, 4) !== 'PACK') {
    throw new Error('bad pack signature')
  }
  const packVersion = packRaw.readUInt32BE(4)
  if (packVersion !== 2 && packVersion !== 3) {
    throw new Error(`bad pack version ${packVersion}`)
  }
  const totalObjects = packRaw.readUInt32BE(8)
  let readPos = 12
  const offsetToShaMap = new Map<number, string>()
  for (let itemIdx = 0; itemIdx < totalObjects; itemIdx++) {
    const objectStartPos = readPos
    let byteVal = packRaw[readPos++]
    const rawType = (byteVal >> 4) & 7
    let uncompressedSize = byteVal & 0x0f
    let bitShift = 4
    while (byteVal & 0x80) {
      byteVal = packRaw[readPos++]
      uncompressedSize |= (byteVal & 0x7f) << bitShift
      bitShift += 7
    }
    if (rawType === OBJ_OFS_DELTA) {
      let deltaByte = packRaw[readPos++]
      let negativeOffset = deltaByte & 0x7f
      while (deltaByte & 0x80) {
        deltaByte = packRaw[readPos++]
        negativeOffset = ((negativeOffset + 1) << 7) | (deltaByte & 0x7f)
      }
      const inflation = inflateAt(packRaw, readPos, uncompressedSize)
      readPos = inflation.end
      const baseObjectSha = offsetToShaMap.get(objectStartPos - negativeOffset)
      if (!baseObjectSha) throw new Error('bad ofs-delta base offset')
      const baseRec = targetSink.get(baseObjectSha)
      if (!baseRec) throw new Error('ofs-delta base missing')
      const reconstructed = applyDelta(baseRec.data, inflation.data)
      offsetToShaMap.set(objectStartPos, targetSink.store(baseRec.type, reconstructed))
    } else if (rawType === OBJ_REF_DELTA) {
      const baseRefSha = packRaw.toString('hex', readPos, readPos + 20)
      readPos += 20
      const inflation = inflateAt(packRaw, readPos, uncompressedSize)
      readPos = inflation.end
      const baseRec = targetSink.get(baseRefSha)
      if (!baseRec) throw new Error(`ref-delta base missing ${baseRefSha}`)
      const reconstructed = applyDelta(baseRec.data, inflation.data)
      offsetToShaMap.set(objectStartPos, targetSink.store(baseRec.type, reconstructed))
    } else {
      const resolvedKind = NUM_TO_TYPE[rawType]
      if (!resolvedKind) throw new Error(`bad object type ${rawType}`)
      const inflation = inflateAt(packRaw, readPos, uncompressedSize)
      readPos = inflation.end
      offsetToShaMap.set(objectStartPos, targetSink.store(resolvedKind, inflation.data))
    }
  }
  return totalObjects
}

export function applyDelta(baseBuffer: Buffer, deltaInstructions: Buffer): Buffer {
  let deltaIdx = 0
  const readVarint = (): number => {
    let accumulated = 0
    let shiftAmount = 0
    for (;;) {
      const byte = deltaInstructions[deltaIdx++]
      accumulated |= (byte & 0x7f) << shiftAmount
      if (!(byte & 0x80)) break
      shiftAmount += 7
    }
    return accumulated
  }
  const sourceLen = readVarint()
  const targetLen = readVarint()
  if (sourceLen !== baseBuffer.length) {
    throw new Error('delta base size mismatch')
  }
  const resultBuffer = Buffer.alloc(targetLen)
  let outCursor = 0
  while (deltaIdx < deltaInstructions.length) {
    const opcode = deltaInstructions[deltaIdx++]
    if (opcode & 0x80) {
      let copyOffset = 0
      let copyLength = 0
      if (opcode & 0x01) copyOffset |= deltaInstructions[deltaIdx++]
      if (opcode & 0x02) copyOffset |= deltaInstructions[deltaIdx++] << 8
      if (opcode & 0x04) copyOffset |= deltaInstructions[deltaIdx++] << 16
      if (opcode & 0x08) copyOffset |= deltaInstructions[deltaIdx++] << 24
      if (opcode & 0x10) copyLength |= deltaInstructions[deltaIdx++]
      if (opcode & 0x20) copyLength |= deltaInstructions[deltaIdx++] << 8
      if (opcode & 0x40) copyLength |= deltaInstructions[deltaIdx++] << 16
      if (copyLength === 0) copyLength = 0x10000
      baseBuffer.copy(resultBuffer, outCursor, copyOffset, copyOffset + copyLength)
      outCursor += copyLength
    } else if (opcode > 0) {
      deltaInstructions.copy(resultBuffer, outCursor, deltaIdx, deltaIdx + opcode)
      deltaIdx += opcode
      outCursor += opcode
    } else {
      throw new Error('bad delta opcode 0')
    }
  }
  if (outCursor !== targetLen) {
    throw new Error('delta target size mismatch')
  }
  return resultBuffer
}

/** Write a pack (full objects, no deltas) with trailing checksum. */
export function packObjects(items: { type: ObjType; data: Buffer }[]): Buffer {
  const binaryParts: Buffer[] = []
  const packHeader = Buffer.alloc(12)
  packHeader.write('PACK', 0, 'latin1')
  packHeader.writeUInt32BE(2, 4)
  packHeader.writeUInt32BE(items.length, 8)
  binaryParts.push(packHeader)
  for (const obj of items) {
    let initialByte = (TYPE_NUM[obj.type] << 4) | (obj.data.length & 0x0f)
    let remainingSize = obj.data.length >> 4
    const headerBytes: number[] = []
    while (remainingSize > 0) {
      headerBytes.push(initialByte | 0x80)
      initialByte = remainingSize & 0x7f
      remainingSize >>= 7
    }
    headerBytes.push(initialByte)
    binaryParts.push(Buffer.from(headerBytes))
    binaryParts.push(zlib.deflateSync(obj.data, { level: 1 }))
  }
  const packContent = Buffer.concat(binaryParts)
  const checksum = crypto.createHash('sha1').update(packContent).digest()
  return Buffer.concat([packContent, checksum])
}

// ---- pkt-line helpers ----

export function pkt(linePayload: string | Buffer): Buffer {
  const bufData = Buffer.isBuffer(linePayload) ? linePayload : Buffer.from(linePayload, 'latin1')
  const hexLen = (bufData.length + 4).toString(16).padStart(4, '0')
  return Buffer.concat([Buffer.from(hexLen, 'latin1'), bufData])
}

export const FLUSH = Buffer.from('0000', 'latin1')
export const DELIM = Buffer.from('0001', 'latin1')

export interface PktLine {
  kind: 'data' | 'flush' | 'delim'
  data?: Buffer
}

export function readPkts(rawInput: Buffer): PktLine[] {
  const pktResults: PktLine[] = []
  let readPtr = 0
  while (readPtr + 4 <= rawInput.length) {
    const lenHex = rawInput.toString('latin1', readPtr, readPtr + 4)
    const lineLen = parseInt(lenHex, 16)
    if (Number.isNaN(lineLen)) throw new Error('bad pkt-line length')
    if (lineLen === 0) {
      pktResults.push({ kind: 'flush' })
      readPtr += 4
    } else if (lineLen === 1) {
      pktResults.push({ kind: 'delim' })
      readPtr += 4
    } else if (lineLen === 2) {
      pktResults.push({ kind: 'flush' })
      readPtr += 4
    } else {
      if (readPtr + lineLen > rawInput.length) throw new Error('truncated pkt-line')
      pktResults.push({ kind: 'data', data: rawInput.subarray(readPtr + 4, readPtr + lineLen) })
      readPtr += lineLen
    }
  }
  return pktResults
}

export function sidebandChunk(channelBand: number, payloadData: Buffer, chunkSize = 65515): Buffer {
  const streamChunks: Buffer[] = []
  for (let offset = 0; offset < payloadData.length; offset += chunkSize) {
    const slice = payloadData.subarray(offset, offset + chunkSize)
    streamChunks.push(pkt(Buffer.concat([Buffer.from([channelBand]), slice])))
  }
  streamChunks.push(FLUSH)
  return Buffer.concat(streamChunks)
}
