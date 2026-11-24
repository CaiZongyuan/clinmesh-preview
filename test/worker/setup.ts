import { reset } from 'cloudflare:test'
import { afterEach } from 'vitest'

// Durable Object storage persists across tests in a file unless it is reset.
afterEach(() => reset())
