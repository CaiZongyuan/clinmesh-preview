import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ViteDevServer } from 'vite'
import { unstable_getVarsForDev, unstable_readConfig } from 'wrangler'
import { startDevProviderProxy } from './scripts/dev-provider-proxy'

export default defineConfig(async ({ command, isPreview }) => {
  const plugins = [react(), tailwindcss()]
  if (command === 'serve' && !isPreview) {
    const env = process.env.CLOUDFLARE_ENV
    const config = unstable_readConfig({ config: 'wrangler.jsonc', env })
    const bindings = unstable_getVarsForDev(config.configPath, undefined, config.vars, env, true)
    const vars = Object.fromEntries(Object.entries(bindings).map(([name, binding]) => [name, binding.value]))
    const relay = await startDevProviderProxy(vars)
    if (relay) {
      return { plugins: [...plugins, cloudflare({ config: { vars: { CLINMESH_DEV_PROVIDER_ORIGIN: relay.origin } } }), {
        name: 'clinmesh-dev-providers',
        configureServer(server: ViteDevServer) { server.httpServer?.once('close', relay.close) },
        closeBundle: relay.close,
      }] }
    }
  }
  return { plugins: [...plugins, cloudflare()] }
})
