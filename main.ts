// Entrypoint: bind ephemeral port, register with the suite, serve until done, exit 0.
// ForgeTS: High-performance GitHub-compatible git forge (Smart HTTP v2, REST v3, GraphQL v4, MCP)
import http from 'node:http'
import { createForgeServer } from './src/httpd.ts'
import { Store } from './src/store.ts'

const store = new Store()
const server = createForgeServer(store)
const bindPort = Number(process.env.PORT) || 0

server.listen(bindPort, '0.0.0.0', () => {
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  if (port === 0) {
    console.error('failed to bind an ephemeral port')
    process.exit(1)
  }
  console.log(`forge listening on port ${port}`)
  const envUrl = process.env.MAKEFUN_ENV_URL
  if (!envUrl) {
    // local mode: run until terminated
    return
  }
  register(envUrl, port)
})

function register(envUrl: string, port: number): void {
  const base = envUrl.replace(/\/$/, '')
  const attempt = async (): Promise<void> => {
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      })
      if (res.ok) {
        console.log('registered with suite')
        await pollDone(base)
        return
      }
    } catch {
      // suite not ready yet; retry
    }
    setTimeout(() => void attempt(), 200)
  }
  void attempt()
}

async function pollDone(base: string): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${base}/done`)
      const text = await res.text()
      let done = false
      try {
        done = JSON.parse(text)?.done === true
      } catch {
        done = false
      }
      if (done) {
        console.log('suite done; exiting')
        server.close()
        process.exit(0)
        return
      }
    } catch {
      // keep polling
    }
    await new Promise((r) => setTimeout(r, 250))
  }
}

process.on('SIGTERM', () => { server.close(); process.exit(0) })
process.on('SIGINT', () => { server.close(); process.exit(0) })
