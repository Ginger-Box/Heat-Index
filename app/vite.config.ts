import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONTRACT_ID = 'heat-index-game.testnet'

/**
 * Dev-only "relayer" for the email login: POST /api/near/create-player { name, ownerKey, gameKey } calls the
 * contract's create_player_account, signed with the contract account's key from the local near CLI credentials
 * (~/.near-credentials/testnet/heat-index-game.testnet.json). The key never reaches the browser or the repo.
 * The email login itself only works on http://localhost:3000 (the shared testnet NEAR Auth app), so a dev-server
 * endpoint is all it needs.
 */
function nearRelayer(): Plugin {
  return {
    name: 'heat-index-near-relayer',
    apply: 'serve',
    configureServer(server) {
      // One-off account linking (tools/LinkAccount on localhost): submit a NEAR Auth signature request to the
      // fast-auth contract and return the MPC signature (base64). The relayer only pays gas; what gets signed is
      // a transaction the player approved in the NEAR Auth window.
      server.middlewares.use('/api/near/fastauth-sign', (req, res) => {
        const origin = req.headers.origin ?? ''
        if (
          req.method !== 'POST' ||
          !/^http:\/\/(localhost|127\.0\.0\.1):3000$/.test(origin) ||
          !String(req.headers['content-type'] ?? '').startsWith('application/json')
        ) {
          res.statusCode = 403
          return res.end()
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json')
          try {
            const r = JSON.parse(body || '{}') as { guardId: string; verifyPayload: string; signPayload: number[]; algorithm?: string }
            const creds = JSON.parse(
              readFileSync(join(homedir(), '.near-credentials', 'testnet', `${CONTRACT_ID}.json`), 'utf8'),
            )
            const { Account, JsonRpcProvider } = await import('near-api-js')
            const provider = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' })
            const relayer = new Account(CONTRACT_ID, provider, creds.private_key)
            let lastErr: unknown
            // the MPC signer needs 1 yoctoNEAR attached (fast-auth forwards it); without it the call returns null
            for (const deposit of [1n]) {
              try {
                const out = await relayer.callFunctionRaw({
                  contractId: 'fast-auth.testnet',
                  methodName: 'sign',
                  args: {
                    guard_id: r.guardId,
                    verify_payload: r.verifyPayload,
                    sign_payload: r.signPayload,
                    algorithm: r.algorithm ?? 'eddsa',
                  },
                  gas: 300_000_000_000_000n,
                  deposit,
                })
                const st = out.status as { SuccessValue?: string }
                if (st && typeof st === 'object' && st.SuccessValue && st.SuccessValue !== 'bnVsbA==')
                  return res.end(JSON.stringify({ signature: st.SuccessValue }))
                throw new Error(`No signature in the result: ${JSON.stringify(out.status).slice(0, 300)}`)
              } catch (e) {
                lastErr = e
                if (!/deposit/i.test(String(e))) break
              }
            }
            throw lastErr
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
          }
        })
      })
      server.middlewares.use('/api/near/create-player', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          return res.end()
        }
        // only the game itself: same origin and a JSON body (a JSON content type forces a CORS preflight, which
        // another site's page can't pass) — so a web page open in the same browser can't drive this relayer
        const origin = req.headers.origin ?? ''
        const okOrigin = /^http:\/\/(localhost|127\.0\.0\.1):3000$/.test(origin)
        if (!okOrigin || !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          res.statusCode = 403
          return res.end()
        }
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', async () => {
          res.setHeader('Content-Type', 'application/json')
          try {
            const { name, ownerKey, gameKey } = JSON.parse(body || '{}')
            const creds = JSON.parse(
              readFileSync(join(homedir(), '.near-credentials', 'testnet', `${CONTRACT_ID}.json`), 'utf8'),
            )
            const { Account, JsonRpcProvider } = await import('near-api-js')
            const provider = new JsonRpcProvider({ url: 'https://rpc.testnet.near.org' })
            const relayer = new Account(CONTRACT_ID, provider, creds.private_key)
            const view = (method: string, args: Record<string, unknown>) =>
              provider.callFunction({ contractId: CONTRACT_ID, method, args })
            // this login already has an account, but the browser lost its game key (e.g. another device):
            // release the old link so the login gets a fresh account
            if (await view('account_for_owner_key', { owner_key: ownerKey })) {
              await relayer.callFunction({
                contractId: CONTRACT_ID,
                methodName: 'forget_owner_key',
                args: { owner_key: ownerKey },
              })
            }
            // first free name: max, max-2, max-3…
            const exists = async (id: string) => {
              try {
                await provider.query({ request_type: 'view_account', finality: 'final', account_id: id })
                return true
              } catch {
                return false
              }
            }
            let free = name
            for (let i = 2; await exists(`${free}.${CONTRACT_ID}`) && i < 50; i++) free = `${name}-${i}`
            const accountId = await relayer.callFunction({
              contractId: CONTRACT_ID,
              methodName: 'create_player_account',
              args: { name: free, owner_key: ownerKey, game_key: gameKey },
              gas: 150_000_000_000_000n,
            })
            if (!accountId) throw new Error('The account was not created (is the name taken?)')
            res.end(JSON.stringify({ accountId }))
          } catch (e) {
            res.statusCode = 400
            res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
          }
        })
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), nearRelayer()],
  // the shared testnet NEAR Auth (email login) app only accepts http://localhost:3000 as a callback
  server: { port: 3000, strictPort: true },
  define: { global: 'globalThis' },
})
