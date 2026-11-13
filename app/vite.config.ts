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
      server.middlewares.use('/api/near/create-player', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
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
            const accountId = await relayer.callFunction({
              contractId: CONTRACT_ID,
              methodName: 'create_player_account',
              args: { name, owner_key: ownerKey, game_key: gameKey },
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
