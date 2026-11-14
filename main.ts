// Forge entrypoint: start HTTP server, bind listening port, register with harness, wait for completion.
import http from 'node:http'
import { createForgeServer } from './src/httpd.ts'
import { Store } from './src/store.ts'

const forgeState = new Store()
const forgeHttpApp = createForgeServer(forgeState)
const targetPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 0

forgeHttpApp.listen(targetPort, '0.0.0.0', () => {
  const addressInfo = forgeHttpApp.address()
  const activePort = typeof addressInfo === 'object' && addressInfo !== null ? addressInfo.port : 0
  if (activePort <= 0) {
    console.error('Fatal: unable to acquire valid listening port')
    process.exit(1)
  }
  console.log(`[forge] daemon online, port=${activePort}`)
  const harnessEndpoint = process.env.MAKEFUN_ENV_URL
  if (!harnessEndpoint) {
    return
  }
  executeHarnessRegistration(harnessEndpoint, activePort)
})

function executeHarnessRegistration(harnessUrl: string, boundPort: number): void {
  const normalizedBase = harnessUrl.replace(/\/+$/, '')
  const dispatch = async (): Promise<void> => {
    try {
      const response = await fetch(`${normalizedBase}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: boundPort }),
      })
      if (response.ok) {
        console.log('[forge] successfully registered with evaluation suite')
        await monitorSuiteCompletion(normalizedBase)
        return
      }
    } catch {
      // Suite listener not ready; retry connection
    }
    setTimeout(() => void dispatch(), 200)
  }
  void dispatch()
}

async function monitorSuiteCompletion(normalizedBase: string): Promise<void> {
  for (;;) {
    try {
      const checkRes = await fetch(`${normalizedBase}/done`)
      const payload = await checkRes.text()
      let isDone = false
      try {
        const parsed = JSON.parse(payload) as { done?: boolean }
        isDone = parsed?.done === true
      } catch {
        isDone = false
      }
      if (isDone) {
        console.log('[forge] test run finished; shutting down')
        forgeHttpApp.close()
        process.exit(0)
        return
      }
    } catch {
      // Continue polling until done
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

process.on('SIGTERM', () => {
  forgeHttpApp.close()
  process.exit(0)
})

process.on('SIGINT', () => {
  forgeHttpApp.close()
  process.exit(0)
})

export { forgeHttpApp, forgeState }
