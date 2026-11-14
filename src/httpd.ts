// HTTP dispatch plumbing: request body buffering, content negotiation, authentication gate, and API routing.
import http from 'node:http'
import zlib from 'node:zlib'
import { Store } from './store.ts'
import { handleRest } from './rest.ts'
import { handleGraphQL } from './graphql.ts'
import { handleMcp } from './mcp.ts'
import { handleGit } from './smarthttp.ts'

function readIncomingBody(inStream: http.IncomingMessage, byteCap = 512 * 1024 * 1024): Promise<Buffer> {
  return new Promise((fulfill, reject) => {
    const streamChunks: Buffer[] = []
    let totalBytesRead = 0
    inStream.on('data', (dataChunk: Buffer) => {
      totalBytesRead += dataChunk.length
      if (totalBytesRead > byteCap) {
        reject(new Error('Payload exceeds maximum allowed size'))
        inStream.destroy()
        return
      }
      streamChunks.push(dataChunk)
    })
    inStream.on('end', () => fulfill(Buffer.concat(streamChunks)))
    inStream.on('error', reject)
  })
}

export function createForgeServer(dataStore: Store): http.Server {
  const forgeApp = http.createServer((clientReq, clientRes) => {
    void processClientRequest(dataStore, clientReq, clientRes)
  })
  forgeApp.on('checkContinue', (clientReq, clientRes) => {
    clientRes.writeContinue()
    void processClientRequest(dataStore, clientReq, clientRes)
  })
  forgeApp.keepAliveTimeout = 65_000
  forgeApp.requestTimeout = 0
  forgeApp.headersTimeout = 60_000
  return forgeApp
}

async function processClientRequest(
  dataStore: Store,
  incomingReq: http.IncomingMessage,
  outgoingRes: http.ServerResponse,
): Promise<void> {
  try {
    const parsedUrl = new URL(incomingReq.url ?? '/', 'http://localhost')
    const requestPath = parsedUrl.pathname
    let bodyBuffer: Buffer | null = null
    if (incomingReq.method !== 'GET' && incomingReq.method !== 'HEAD') {
      bodyBuffer = await readIncomingBody(incomingReq)
      const contentEncodingHeader = String(incomingReq.headers['content-encoding'] ?? '').toLowerCase()
      if (contentEncodingHeader.includes('gzip') && bodyBuffer.length > 0) {
        try {
          bodyBuffer = zlib.gunzipSync(bodyBuffer)
        } catch {
          sendJsonResponse(outgoingRes, 400, { message: 'Problems parsing JSON' })
          return
        }
      }
    } else {
      bodyBuffer = Buffer.alloc(0)
    }

    // Health probe (env boot check: 200 {"ok":true})
    if (requestPath === '/healthz' && (incomingReq.method === 'GET' || incomingReq.method === 'HEAD')) {
      const healthPayload = Buffer.from(JSON.stringify({ ok: true }) + '\n', 'utf8')
      outgoingRes.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(healthPayload.length),
      })
      outgoingRes.end(healthPayload)
      return
    }

    // Model Context Protocol (MCP) stream endpoint
    if (requestPath === '/mcp') {
      const authHeaderStr = String(incomingReq.headers.authorization ?? '')
      const bearerTokenVal = authHeaderStr.startsWith('Bearer ') ? authHeaderStr.slice(7).trim() : null
      const expectedToken = process.env.MAKEFUN_SHOP_TOKEN
      const isAuthorized =
        bearerTokenVal !== null &&
        bearerTokenVal.length > 0 &&
        (expectedToken === undefined || expectedToken === '' || bearerTokenVal === expectedToken)
      if (!isAuthorized) {
        sendJsonResponse(outgoingRes, 401, { message: 'Requires authentication' })
        return
      }
      if (incomingReq.method !== 'POST') {
        sendJsonResponse(outgoingRes, 405, { message: 'method not allowed' })
        return
      }
      const activeSessionId =
        typeof incomingReq.headers['mcp-session-id'] === 'string'
          ? (incomingReq.headers['mcp-session-id'] as string)
          : null
      handleMcp(dataStore, bodyBuffer.toString('utf8'), outgoingRes, activeSessionId, (statusCode, replyBody, sid) => {
        const replyHeaders: Record<string, string> = { 'Content-Length': String(replyBody.length) }
        if (replyBody.length > 0) replyHeaders['Content-Type'] = 'application/json'
        if (sid) replyHeaders['Mcp-Session-Id'] = sid
        outgoingRes.writeHead(statusCode, replyHeaders)
        outgoingRes.end(replyBody)
      })
      return
    }

    // Git Smart HTTP transport routing: public access
    if (!requestPath.startsWith('/api/')) {
      const hasGitSuffix =
        requestPath.endsWith('.git/info/refs') ||
        requestPath.endsWith('.git/git-upload-pack') ||
        requestPath.endsWith('.git/git-receive-pack') ||
        requestPath.includes('.git/')
      if (hasGitSuffix || /^\/[^/]+\/[^/]+\.git(\/|$)/.test(requestPath)) {
        const gitHandled = handleGit(
          dataStore,
          incomingReq.method ?? 'GET',
          requestPath,
          parsedUrl.searchParams,
          incomingReq.headers,
          bodyBuffer,
          outgoingRes,
        )
        if (gitHandled) return
      }
      sendJsonResponse(outgoingRes, 404, { message: 'Not Found' })
      return
    }

    // Authentication verification for REST and GraphQL surfaces
    const authVal = String(incomingReq.headers.authorization ?? '')
    const tokenCandidate = authVal.startsWith('Bearer ') ? authVal.slice(7).trim() : null
    const targetToken = process.env.MAKEFUN_SHOP_TOKEN
    const hasValidToken =
      tokenCandidate !== null &&
      tokenCandidate.length > 0 &&
      (targetToken === undefined || targetToken === '' || tokenCandidate === targetToken)
    if (!hasValidToken) {
      sendJsonResponse(outgoingRes, 401, { message: 'Requires authentication' })
      return
    }

    if (requestPath === '/api/graphql') {
      if (incomingReq.method !== 'POST') {
        sendJsonResponse(outgoingRes, 404, { message: 'Not Found' })
        return
      }
      handleGraphQL(dataStore, bodyBuffer.toString('utf8'), extractBaseUrl(incomingReq), outgoingRes)
      return
    }

    if (requestPath.startsWith('/api/v3')) {
      const pathSegs = requestPath.slice('/api/v3'.length).split('/').filter((s) => s.length > 0)
      let parsedBodyJson: Record<string, unknown> | null = null
      if (
        incomingReq.method === 'POST' ||
        incomingReq.method === 'PUT' ||
        incomingReq.method === 'PATCH' ||
        incomingReq.method === 'DELETE'
      ) {
        const bodyRawText = bodyBuffer.toString('utf8').trim()
        if (bodyRawText.length > 0) {
          try {
            parsedBodyJson = JSON.parse(bodyRawText) as Record<string, unknown>
            if (parsedBodyJson === null || typeof parsedBodyJson !== 'object' || Array.isArray(parsedBodyJson)) {
              parsedBodyJson = parsedBodyJson as Record<string, unknown>
            }
          } catch {
            sendJsonResponse(outgoingRes, 400, { message: 'Problems parsing JSON' })
            return
          }
        }
      }
      const restHandled = handleRest(
        dataStore,
        incomingReq.method ?? 'GET',
        pathSegs,
        parsedUrl.searchParams,
        parsedBodyJson,
        extractBaseUrl(incomingReq),
        outgoingRes,
      )
      if (restHandled) return
      sendJsonResponse(outgoingRes, 404, { message: 'Not Found' })
      return
    }

    sendJsonResponse(outgoingRes, 404, { message: 'Not Found' })
  } catch (err) {
    try {
      sendJsonResponse(outgoingRes, 500, { message: `Internal Server Error: ${(err as Error).message}` })
    } catch {
      // Stream already committed
    }
  }
}

function extractBaseUrl(reqMsg: http.IncomingMessage): string {
  const hostVal = String(reqMsg.headers.host ?? 'localhost')
  return `http://${hostVal}`
}

function sendJsonResponse(resObj: http.ServerResponse, code: number, payloadObj: unknown): void {
  const binaryPayload = Buffer.from(JSON.stringify(payloadObj), 'utf8')
  resObj.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': 'req-unknown',
    'Content-Length': String(binaryPayload.length),
  })
  resObj.end(binaryPayload)
}
