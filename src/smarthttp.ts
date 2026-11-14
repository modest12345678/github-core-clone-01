// Git smart HTTP service engine: protocol v2 and v0 advertisements, upload-pack negotiation, pack streaming, and atomic receive-pack processing.
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

const EMPTY_ZERO_OID = '0000000000000000000000000000000000000000'
const FORGE_AGENT_HEADER = 'agent=forge/1.0'

function writeGitResponse(
  clientRes: http.ServerResponse,
  statusCode: number,
  mimeType: string,
  responseContent: Buffer | string,
): void {
  const binaryPayload = Buffer.isBuffer(responseContent) ? responseContent : Buffer.from(responseContent, 'latin1')
  clientRes.writeHead(statusCode, {
    'Content-Type': mimeType,
    'Cache-Control': 'no-cache',
    'Content-Length': String(binaryPayload.length),
  })
  clientRes.end(binaryPayload)
}

const MIME_ADV_UPLOAD = 'application/x-git-upload-pack-advertisement'
const MIME_ADV_RECEIVE = 'application/x-git-receive-pack-advertisement'
const MIME_RESULT_UPLOAD = 'application/x-git-upload-pack-result'
const MIME_RESULT_RECEIVE = 'application/x-git-receive-pack-result'

function getSortedReferences(repository: Repo): Array<{ name: string; sha: string }> {
  const referenceList: Array<{ name: string; sha: string }> = []
  for (const refName of repository.refs.keys()) {
    referenceList.push({ name: refName, sha: repository.refs.get(refName)! })
  }
  referenceList.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return referenceList
}

// ---- advertisements ----

function advertiseUploadProtocolV2(clientRes: http.ServerResponse): void {
  const payloadPkt = Buffer.concat([
    pkt('version 2\n'),
    pkt(FORGE_AGENT_HEADER + '\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    FLUSH,
  ])
  writeGitResponse(clientRes, 200, MIME_ADV_UPLOAD, payloadPkt)
}

function buildReferenceAdvertisement(repository: Repo, capabilitiesStr: string, attachHeadRef: boolean): Buffer {
  const outputPackets: Buffer[] = []
  const sortedRefsList = getSortedReferences(repository)
  const defaultHeadSha = repository.branchSha(repository.defaultBranch)
  let initialCapsEmitted = false
  if (attachHeadRef && defaultHeadSha) {
    outputPackets.push(pkt(`${defaultHeadSha} HEAD\0${capabilitiesStr}\n`))
    initialCapsEmitted = true
  }
  let isFirstRef = true
  for (const refItem of sortedRefsList) {
    if (isFirstRef && !initialCapsEmitted) {
      outputPackets.push(pkt(`${refItem.sha} ${refItem.name}\0${capabilitiesStr}\n`))
      initialCapsEmitted = true
    } else {
      outputPackets.push(pkt(`${refItem.sha} ${refItem.name}\n`))
    }
    isFirstRef = false
  }
  if (!initialCapsEmitted) {
    outputPackets.push(pkt(`${EMPTY_ZERO_OID} capabilities^{}\0${capabilitiesStr}\n`))
  }
  outputPackets.push(FLUSH)
  return Buffer.concat(outputPackets)
}

function advertiseUploadProtocolV0(clientRes: http.ServerResponse, repository: Repo): void {
  const protocolCaps = `symref=HEAD:refs/heads/${repository.defaultBranch} multi_ack_detailed multi_ack side-band-64k thin-pack ofs-delta ${FORGE_AGENT_HEADER}`
  const bodyBuffer = Buffer.concat([
    pkt(`# service=git-upload-pack\n`),
    FLUSH,
    buildReferenceAdvertisement(repository, protocolCaps, true),
  ])
  writeGitResponse(clientRes, 200, MIME_ADV_UPLOAD, bodyBuffer)
}

function advertiseReceiveProtocolV0(clientRes: http.ServerResponse, repository: Repo): void {
  const protocolCaps = `report-status delete-refs side-band-64k ofs-delta quiet ${FORGE_AGENT_HEADER}`
  const bodyBuffer = Buffer.concat([
    pkt(`# service=git-receive-pack\n`),
    FLUSH,
    buildReferenceAdvertisement(repository, protocolCaps, false),
  ])
  writeGitResponse(clientRes, 200, MIME_ADV_RECEIVE, bodyBuffer)
}

// ---- v2 ls-refs ----

function peelAnnotatedTag(storage: ObjectStore, sourceSha: string): string | null {
  let inspectOid = sourceSha
  for (let step = 0; step < 10; step++) {
    const objRec = storage.get(inspectOid)
    if (!objRec || objRec.type !== 'tag') {
      return inspectOid !== sourceSha ? inspectOid : null
    }
    const targetMatch = objRec.data.toString('utf8').match(/^object ([0-9a-f]{40})/m)
    if (!targetMatch) return null
    inspectOid = targetMatch[1]
  }
  return null
}

function handleLsRefsCommand(dataStore: Store, repository: Repo, argumentsList: string[], clientRes: http.ServerResponse): void {
  const filterPrefixes: string[] = []
  let wantSymrefs = false
  let wantPeel = false
  let wantUnborn = false
  for (const item of argumentsList) {
    if (item.startsWith('ref-prefix ')) filterPrefixes.push(item.slice('ref-prefix '.length))
    else if (item === 'symrefs') wantSymrefs = true
    else if (item === 'peel') wantPeel = true
    else if (item === 'unborn') wantUnborn = true
  }
  const prefixPredicate = (candidateName: string): boolean => {
    if (filterPrefixes.length === 0) return true
    return filterPrefixes.some((pfx) => candidateName.startsWith(pfx))
  }
  const responseChunks: Buffer[] = []
  const defaultBranchSha = repository.branchSha(repository.defaultBranch)
  if (defaultBranchSha) {
    if (prefixPredicate('HEAD')) {
      const symrefSuffix = wantSymrefs ? ` symref-target:refs/heads/${repository.defaultBranch}` : ''
      responseChunks.push(pkt(`${defaultBranchSha} HEAD${symrefSuffix}\n`))
    }
  } else if (wantUnborn && prefixPredicate('HEAD')) {
    const symrefSuffix = wantSymrefs ? ` symref-target:refs/heads/${repository.defaultBranch}` : ''
    responseChunks.push(pkt(`unborn HEAD${symrefSuffix}\n`))
  }
  for (const refEntry of getSortedReferences(repository)) {
    if (!prefixPredicate(refEntry.name)) continue
    const peeledTarget = wantPeel ? peelAnnotatedTag(dataStore.objects, refEntry.sha) : null
    const peelAnnotation = peeledTarget ? ` peeled:${peeledTarget}` : ''
    responseChunks.push(pkt(`${refEntry.sha} ${refEntry.name}${peelAnnotation}\n`))
  }
  responseChunks.push(FLUSH)
  writeGitResponse(clientRes, 200, MIME_RESULT_UPLOAD, Buffer.concat(responseChunks))
}

// ---- pack assembly for fetch ----

function collectTransferObjects(
  dataStore: Store,
  repository: Repo,
  requestedTips: string[],
  excludedTips: string[],
  shallowLimitDepth: number,
): {
  objs: Array<{ type: ObjType; data: Buffer }>
  shallow: string[]
} {
  const storage = dataStore.objects
  const commitCollection: string[] = []
  const shallowCutoffs: string[] = []
  if (shallowLimitDepth > 0) {
    const commitDepths = new Map<string, number>()
    const traversalQueue: string[] = []
    for (const tip of requestedTips) {
      if (!commitDepths.has(tip) && storage.has(tip)) {
        commitDepths.set(tip, 1)
        traversalQueue.push(tip)
      }
    }
    while (traversalQueue.length) {
      const currentCommit = traversalQueue.shift()!
      const currentDepth = commitDepths.get(currentCommit)!
      if (currentDepth >= shallowLimitDepth) {
        shallowCutoffs.push(currentCommit)
        commitCollection.push(currentCommit)
        continue
      }
      commitCollection.push(currentCommit)
      const objRec = storage.get(currentCommit)
      if (!objRec) continue
      for (const line of objRec.data.toString('utf8').split('\n')) {
        if (line === '') break
        if (line.startsWith('parent ')) {
          const parentOid = line.slice(7).trim()
          if (!commitDepths.has(parentOid) && storage.has(parentOid)) {
            commitDepths.set(parentOid, currentDepth + 1)
            traversalQueue.push(parentOid)
          }
        }
      }
    }
  } else {
    for (const tip of requestedTips) {
      const visitedCommits = new Set<string>([tip])
      const bfsQueue = [tip]
      while (bfsQueue.length) {
        const curOid = bfsQueue.shift()!
        commitCollection.push(curOid)
        const objRec = storage.get(curOid)
        if (!objRec) continue
        for (const line of objRec.data.toString('utf8').split('\n')) {
          if (line === '') break
          if (line.startsWith('parent ')) {
            const parentOid = line.slice(7).trim()
            if (!visitedCommits.has(parentOid) && storage.has(parentOid)) {
              visitedCommits.add(parentOid)
              bfsQueue.push(parentOid)
            }
          }
        }
      }
    }
  }
  const excludedObjectSet = new Set<string>()
  if (shallowLimitDepth === 0) {
    for (const haveTip of excludedTips) {
      const ancSet = new Set<string>([haveTip])
      const ancQueue = [haveTip]
      while (ancQueue.length) {
        const curOid = ancQueue.shift()!
        excludedObjectSet.add(curOid)
        const objRec = storage.get(curOid)
        if (!objRec) continue
        for (const line of objRec.data.toString('utf8').split('\n')) {
          if (line === '') break
          if (line.startsWith('parent ')) {
            const parentOid = line.slice(7).trim()
            if (!ancSet.has(parentOid) && storage.has(parentOid)) {
              ancSet.add(parentOid)
              ancQueue.push(parentOid)
            }
          }
        }
        const commitTreeOid = dataStore.commitTree(curOid)
        if (storage.has(commitTreeOid)) {
          const treeData = treeClosure(storage, commitTreeOid)
          for (const subTreeSha of treeData.trees) excludedObjectSet.add(subTreeSha)
          for (const blobMeta of treeData.blobs.values()) excludedObjectSet.add(blobMeta.sha)
        }
      }
    }
  } else {
    for (const haveTip of excludedTips) {
      excludedObjectSet.add(haveTip)
    }
  }
  const includedSet = new Set<string>()
  const finalObjectPack: Array<{ type: ObjType; data: Buffer }> = []
  const appendObject = (targetSha: string): void => {
    if (includedSet.has(targetSha) || excludedObjectSet.has(targetSha)) return
    const rec = storage.get(targetSha)
    if (!rec) return
    includedSet.add(targetSha)
    finalObjectPack.push({ type: rec.type, data: rec.data })
  }
  for (const cSha of commitCollection) {
    appendObject(cSha)
    const commitTreeSha = dataStore.commitTree(cSha)
    const closureData = treeClosure(storage, commitTreeSha)
    for (const treeSha of closureData.trees) appendObject(treeSha)
    for (const blobInfo of closureData.blobs.values()) appendObject(blobInfo.sha)
  }
  return { objs: finalObjectPack, shallow: shallowCutoffs }
}

function handleV2FetchCommand(
  dataStore: Store,
  repository: Repo,
  commandArgs: string[],
  clientRes: http.ServerResponse,
): void {
  const wantsOids: string[] = []
  const havesOids: string[] = []
  let isDoneAcknowledged = false
  let requestedDeepen = 0
  let sidebandEnabled = false
  for (const argItem of commandArgs) {
    if (argItem.startsWith('want ')) wantsOids.push(argItem.slice(5).trim())
    else if (argItem.startsWith('have ')) havesOids.push(argItem.slice(5).trim())
    else if (argItem === 'done') isDoneAcknowledged = true
    else if (argItem.startsWith('deepen ')) requestedDeepen = parseInt(argItem.slice(7), 10)
    else if (argItem === 'sideband-64k') sidebandEnabled = true
    else if (
      argItem === 'thin-pack' ||
      argItem === 'no-progress' ||
      argItem === 'include-tag' ||
      argItem === 'ofs-delta' ||
      argItem.startsWith('filter ') ||
      argItem.startsWith('shallow ') ||
      argItem === 'deepen-relative' ||
      argItem.startsWith('deepen-not ') ||
      argItem === 'wait-for-done' ||
      argItem === 'sideband-all'
    ) {
      // Ignored non-affecting protocol v2 capability flags
    }
  }
  const existingWants = wantsOids.filter((wSha) => dataStore.objects.has(wSha))
  if (!isDoneAcknowledged) {
    const ackBody = Buffer.concat([pkt('acknowledgments\n'), pkt('nak\n'), FLUSH])
    writeGitResponse(clientRes, 200, MIME_RESULT_UPLOAD, ackBody)
    return
  }
  const { objs, shallow } = collectTransferObjects(
    dataStore,
    repository,
    existingWants,
    havesOids,
    requestedDeepen > 0 ? requestedDeepen : 0,
  )
  const responseParts: Buffer[] = []
  if (shallow.length > 0) {
    responseParts.push(pkt('shallow-info\n'))
    for (const cutSha of shallow) responseParts.push(pkt(`shallow ${cutSha}\n`))
    responseParts.push(DELIM)
  }
  responseParts.push(pkt('packfile\n'))
  const binaryPack = packObjects(objs)
  responseParts.push(sidebandChunk(1, binaryPack))
  writeGitResponse(clientRes, 200, MIME_RESULT_UPLOAD, Buffer.concat(responseParts))
}

// ---- v0 upload-pack ----

function handleV0UploadPack(dataStore: Store, repository: Repo, requestBuffer: Buffer, clientRes: http.ServerResponse): void {
  const parsedLines = readPkts(requestBuffer)
  const wantList: string[] = []
  const haveList: string[] = []
  let useSideband = false
  let receivedDone = false
  for (const pktLine of parsedLines) {
    if (pktLine.kind !== 'data' || !pktLine.data) continue
    const lineText = pktLine.data.toString('latin1').replace(/\n$/, '')
    if (lineText.startsWith('want ')) {
      const remainder = lineText.slice(5)
      const spaceIdx = remainder.indexOf(' ')
      const targetSha = spaceIdx === -1 ? remainder : remainder.slice(0, spaceIdx)
      const capsSuffix = spaceIdx === -1 ? '' : remainder.slice(spaceIdx + 1)
      if (capsSuffix.includes('side-band-64k')) useSideband = true
      wantList.push(targetSha)
    } else if (lineText.startsWith('have ')) {
      haveList.push(lineText.slice(5).trim())
    } else if (lineText === 'done') {
      receivedDone = true
    }
  }
  const outputBuffers: Buffer[] = []
  outputBuffers.push(pkt('nak\n'))
  const resolvedWants = wantList.filter((oid) => dataStore.objects.has(oid))
  const { objs } = collectTransferObjects(dataStore, repository, resolvedWants, haveList, 0)
  const assembledPack = packObjects(objs)
  if (useSideband) {
    outputBuffers.push(sidebandChunk(1, assembledPack))
  } else {
    outputBuffers.push(assembledPack)
  }
  writeGitResponse(clientRes, 200, MIME_RESULT_UPLOAD, Buffer.concat(outputBuffers))
  void receivedDone
}

// ---- receive-pack ----

interface IncomingPushCommand {
  old: string
  new: string
  ref: string
}

function handleReceivePack(dataStore: Store, repository: Repo, requestBuffer: Buffer, clientRes: http.ServerResponse): void {
  const pushCommands: IncomingPushCommand[] = []
  let clientCapabilities = ''
  let parsePos = 0
  let encounteredFlush = false
  while (parsePos + 4 <= requestBuffer.length) {
    const segmentLength = parseInt(requestBuffer.toString('latin1', parsePos, parsePos + 4), 16)
    if (Number.isNaN(segmentLength)) break
    if (segmentLength === 0) {
      parsePos += 4
      encounteredFlush = true
      break
    }
    if (segmentLength === 1) {
      parsePos += 4
      continue
    }
    if (segmentLength === 2) {
      parsePos += 4
      encounteredFlush = true
      break
    }
    if (segmentLength < 4) break
    if (parsePos + segmentLength > requestBuffer.length) break
    const packetContent = requestBuffer.toString('latin1', parsePos + 4, parsePos + segmentLength)
    parsePos += segmentLength
    const nulByteIdx = packetContent.indexOf('\0')
    const primaryStr = nulByteIdx === -1 ? packetContent : packetContent.slice(0, nulByteIdx)
    if (nulByteIdx !== -1 && clientCapabilities === '') {
      clientCapabilities = packetContent.slice(nulByteIdx + 1).replace(/\n$/, '')
    }
    const sanitizedCmd = primaryStr.replace(/\n$/, '')
    if (sanitizedCmd.startsWith('shallow ') || sanitizedCmd.startsWith('unshallow ')) continue
    const cmdMatch = sanitizedCmd.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/)
    if (cmdMatch) {
      pushCommands.push({ old: cmdMatch[1], new: cmdMatch[2], ref: cmdMatch[3] })
    }
  }
  const packPayloadBuffer = encounteredFlush ? requestBuffer.subarray(parsePos) : null
  const expectsStatusReport = clientCapabilities.includes('report-status')
  const expectsSidebandStream = clientCapabilities.includes('side-band-64k')
  const statusReportLines: string[] = []
  let unpackSucceeded = true
  if (packPayloadBuffer && packPayloadBuffer.length >= 32) {
    try {
      unpackPack(packPayloadBuffer, {
        get: (sha) => dataStore.objects.get(sha),
        store: (type: ObjType, data: Buffer) => dataStore.objects.store(type, data),
      })
    } catch (unpackErr) {
      unpackSucceeded = false
      statusReportLines.push(`unpack ${(unpackErr as Error).message}\n`)
      for (const cmd of pushCommands) {
        statusReportLines.push(`ng ${cmd.ref} n/a (unpack error)\n`)
      }
    }
  }
  if (unpackSucceeded) {
    statusReportLines.push('unpack ok\n')
    for (const cmd of pushCommands) {
      const activeOid = repository.refs.get(cmd.ref) ?? EMPTY_ZERO_OID
      let commandOk = false
      if (cmd.new === EMPTY_ZERO_OID) {
        if (activeOid !== EMPTY_ZERO_OID && cmd.old === activeOid) {
          repository.deleteRef(cmd.ref)
          commandOk = true
        }
        if (!commandOk) statusReportLines.push(`ng ${cmd.ref} non-fast-forward\n`)
      } else if (activeOid === EMPTY_ZERO_OID) {
        if (!repository.refs.has(cmd.ref)) {
          repository.setRef(cmd.ref, cmd.new)
          commandOk = true
        }
        if (!commandOk) statusReportLines.push(`ng ${cmd.ref} non-fast-forward\n`)
      } else if (cmd.old !== activeOid) {
        statusReportLines.push(`ng ${cmd.ref} non-fast-forward\n`)
      } else if (cmd.new === cmd.old) {
        commandOk = true
      } else if (isAncestor(dataStore.objects, cmd.old, cmd.new)) {
        repository.setRef(cmd.ref, cmd.new)
        commandOk = true
      } else {
        statusReportLines.push(`ng ${cmd.ref} non-fast-forward\n`)
      }
      if (commandOk) statusReportLines.push(`ok ${cmd.ref}\n`)
    }
  }
  if (!expectsStatusReport) {
    writeGitResponse(clientRes, 200, MIME_RESULT_RECEIVE, FLUSH)
    return
  }
  const reportPayloadBuffer = Buffer.concat([...statusReportLines.map((line) => pkt(line)), FLUSH])
  const finalOutput = expectsSidebandStream ? sidebandChunk(1, reportPayloadBuffer) : reportPayloadBuffer
  writeGitResponse(clientRes, 200, MIME_RESULT_RECEIVE, finalOutput)
}

// ---- v2 command dispatch ----

function handleV2UploadPack(
  dataStore: Store,
  repository: Repo,
  requestBuffer: Buffer,
  clientRes: http.ServerResponse,
): void {
  const parsedPackets = readPkts(requestBuffer)
  let subCommandName = ''
  const parsedArguments: string[] = []
  let readingArguments = false
  for (const packetItem of parsedPackets) {
    if (packetItem.kind === 'delim') {
      readingArguments = true
      continue
    }
    if (packetItem.kind === 'flush') break
    if (packetItem.kind === 'data' && packetItem.data) {
      const packetStr = packetItem.data.toString('latin1').replace(/\n$/, '')
      if (!readingArguments && packetStr.startsWith('command=')) {
        subCommandName = packetStr.slice(8)
      } else if (readingArguments) {
        parsedArguments.push(packetStr)
      }
    }
  }
  if (subCommandName === 'ls-refs') {
    handleLsRefsCommand(dataStore, repository, parsedArguments, clientRes)
  } else if (subCommandName === 'fetch') {
    handleV2FetchCommand(dataStore, repository, parsedArguments, clientRes)
  } else {
    writeGitResponse(clientRes, 400, MIME_RESULT_UPLOAD, pkt(`err unknown command ${subCommandName}\n`) + FLUSH)
  }
}

// ---- entry ----

export function handleGit(
  dataStore: Store,
  httpVerb: string,
  urlPath: string,
  urlQueryParams: URLSearchParams,
  reqHeaders: http.IncomingHttpHeaders,
  requestBuffer: Buffer,
  clientRes: http.ServerResponse,
): boolean {
  const routeMatch = urlPath.match(/^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/)
  if (!routeMatch) return false
  const [, repoOwner, repoName, requestedAction] = routeMatch
  const protocolHeaderStr = String(reqHeaders['git-protocol'] ?? '')
  const isV2Protocol = protocolHeaderStr.includes('version=2')
  if (requestedAction === 'info/refs') {
    if (httpVerb !== 'GET') {
      writeGitResponse(clientRes, 405, 'application/json', JSON.stringify({ message: 'method not allowed' }))
      return true
    }
    const requestedService = urlQueryParams.get('service')
    const targetRepo = dataStore.getRepo(repoOwner, repoName)
    if (!targetRepo) {
      writeGitResponse(clientRes, 404, 'application/json', JSON.stringify({ message: 'Not Found' }))
      return true
    }
    if (requestedService === 'git-upload-pack') {
      if (isV2Protocol) advertiseUploadProtocolV2(clientRes)
      else advertiseUploadProtocolV0(clientRes, targetRepo)
    } else if (requestedService === 'git-receive-pack') {
      advertiseReceiveProtocolV0(clientRes, targetRepo)
    } else {
      writeGitResponse(clientRes, 400, 'application/json', JSON.stringify({ message: 'dumb http protocol not supported' }))
    }
    return true
  }
  const targetRepo = dataStore.getRepo(repoOwner, repoName)
  if (!targetRepo) {
    writeGitResponse(clientRes, 404, 'application/json', JSON.stringify({ message: 'Not Found' }))
    return true
  }
  if (requestedAction === 'git-upload-pack') {
    if (httpVerb !== 'POST') {
      writeGitResponse(clientRes, 405, 'application/json', JSON.stringify({ message: 'method not allowed' }))
      return true
    }
    const leadBytesLen = parseInt(requestBuffer.toString('latin1', 0, 4), 16)
    const initialLine = leadBytesLen > 4 ? requestBuffer.toString('latin1', 4, Math.min(leadBytesLen, requestBuffer.length)) : ''
    if (initialLine.startsWith('command=')) {
      handleV2UploadPack(dataStore, targetRepo, requestBuffer, clientRes)
    } else {
      handleV0UploadPack(dataStore, targetRepo, requestBuffer, clientRes)
    }
    return true
  }
  if (requestedAction === 'git-receive-pack') {
    if (httpVerb !== 'POST') {
      writeGitResponse(clientRes, 405, 'application/json', JSON.stringify({ message: 'method not allowed' }))
      return true
    }
    handleReceivePack(dataStore, targetRepo, requestBuffer, clientRes)
    return true
  }
  return false
}
