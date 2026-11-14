// HTTP plumbing: routing, auth, body collection, top-level error handling.
import http from 'node:http'
import zlib from 'node:zlib'
import { Store } from './store.ts'
import { handleRest } from './rest.ts'
import { handleGraphQL } from './graphql.ts'
import { handleMcp } from './mcp.ts'
import { handleGit } from './smarthttp.ts'

function collectBody(req: http.IncomingMessage, limit = 512 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

export function createForgeServer(store: Store): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(store, req, res)
  })
  server.on('checkContinue', (req, res) => {
    res.writeContinue()
    void handleRequest(store, req, res)
  })
  server.keepAliveTimeout = 65_000
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  return server
}

async function handleRequest(store: Store, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    let raw: Buffer | null = null
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      raw = await collectBody(req)
      const enc = String(req.headers['content-encoding'] ?? '').toLowerCase()
      if (enc.includes('gzip') && raw.length > 0) {
        try {
          raw = zlib.gunzipSync(raw)
        } catch {
          sendPlain(res, 400, { message: 'Problems parsing JSON' })
          return
        }
      }
    } else {
      raw = Buffer.alloc(0)
    }

    // Health probe (env boot check: 200 {"ok":true})
    if (pathname === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
      const body = Buffer.from(JSON.stringify({ ok: true }) + '\n', 'utf8')
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': String(body.length),
      })
      res.end(body)
      return
    }

    // MCP endpoint (before git fallback)
    if (pathname === '/mcp') {
      const auth = String(req.headers.authorization ?? '')
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
      const token = process.env.MAKEFUN_SHOP_TOKEN
      const authed = bearer !== null && bearer.length > 0 && (token === undefined || token === '' || bearer === token)
      if (!authed) {
        sendPlain(res, 401, { message: 'Requires authentication' })
        return
      }
      if (req.method !== 'POST') {
        sendPlain(res, 405, { message: 'method not allowed' })
        return
      }
      const sessionId = typeof req.headers['mcp-session-id'] === 'string' ? (req.headers['mcp-session-id'] as string) : null
      handleMcp(store, raw.toString('utf8'), res, sessionId, (status, body, sid) => {
        const headers: Record<string, string> = { 'Content-Length': String(body.length) }
        if (body.length > 0) headers['Content-Type'] = 'application/json'
        if (sid) headers['Mcp-Session-Id'] = sid
        res.writeHead(status, headers)
        res.end(body)
      })
      return
    }

    // git smart HTTP: no auth required
    if (!pathname.startsWith('/api/')) {
      const isGit = pathname.endsWith('.git/info/refs') || pathname.endsWith('.git/git-upload-pack') || pathname.endsWith('.git/git-receive-pack') || pathname.includes('.git/')
      if (isGit || /^\/[^/]+\/[^/]+\.git(\/|$)/.test(pathname)) {
        const handled = handleGit(store, req.method ?? 'GET', pathname, url.searchParams, req.headers, raw, res)
        if (handled) return
      }
      sendPlain(res, 404, { message: 'Not Found' })
      return
    }

    // auth for API surfaces
    const auth = String(req.headers.authorization ?? '')
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null
    const token = process.env.MAKEFUN_SHOP_TOKEN
    const authed = bearer !== null && bearer.length > 0 && (token === undefined || token === '' || bearer === token)
    if (!authed) {
      sendPlain(res, 401, { message: 'Requires authentication' })
      return
    }

    if (pathname === '/api/graphql') {
      if (req.method !== 'POST') {
        sendPlain(res, 404, { message: 'Not Found' })
        return
      }
      handleGraphQL(store, raw.toString('utf8'), baseUrl(req), res)
      return
    }

    if (pathname.startsWith('/api/v3')) {
      const segs = pathname.slice('/api/v3'.length).split('/').filter((s) => s.length > 0)
      let body: Record<string, unknown> | null = null
      if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH' || req.method === 'DELETE') {
        const text = raw.toString('utf8').trim()
        if (text.length > 0) {
          try {
            body = JSON.parse(text) as Record<string, unknown>
            if (body === null || typeof body !== 'object' || Array.isArray(body)) body = body as Record<string, unknown>
          } catch {
            sendPlain(res, 400, { message: 'Problems parsing JSON' })
            return
          }
        }
      }
      const handled = handleRest(store, req.method ?? 'GET', segs, url.searchParams, body, baseUrl(req), res)
      if (handled) return
      sendPlain(res, 404, { message: 'Not Found' })
      return
    }

    sendPlain(res, 404, { message: 'Not Found' })
  } catch (e) {
    try {
      sendPlain(res, 500, { message: `Internal Server Error: ${(e as Error).message}` })
    } catch {
      // response already sent
    }
  }
}

function baseUrl(req: http.IncomingMessage): string {
  const host = String(req.headers.host ?? 'localhost')
  return `http://${host}`
}

function sendPlain(res: http.ServerResponse, status: number, obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': 'req-unknown',
    'Content-Length': String(body.length),
  })
  res.end(body)
}
