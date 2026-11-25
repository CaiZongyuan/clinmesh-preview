import { cloudflareTest } from '@cloudflare/vitest-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            // Tests drive the agents with a scripted LLM provider and short patient-turn deadlines, and voice capture
            // with a fake Paraformer service behind a placeholder token.
            miniflare: {
              bindings: {
                LLM_PROVIDER: 'scripted',
                PATIENT_TURN_TIMEOUT_MS: '1500',
                PATIENT_TURN_EXPIRY_GRACE_MS: '400',
                AGENT_STALL_TIMEOUT_MS: '1500',
                BAILIAN_TOKEN: 'test-bailian-token',
                BAILIAN_UPSTREAM: 'scripted',
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/worker/**/*.test.ts'],
          setupFiles: ['test/worker/setup.ts'],
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'web',
          environment: 'jsdom',
          include: ['test/web/**/*.test.tsx'],
          setupFiles: ['test/web/setup.ts'],
        },
      },
    ],
  },
})
