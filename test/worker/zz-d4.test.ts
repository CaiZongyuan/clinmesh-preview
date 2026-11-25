import { describe, expect, it } from 'vitest'
import { ask, startEncounter } from './support/clinic'
import { installScripted } from './support/scripted-llm'

describe('d4', () => {
  it('ask with gate', async () => {
    const llm = installScripted('patient')
    const held = llm.gate('医生，我这三天一直', '发烧。')
    llm.reply('青霉素过敏。')
    const encounterId = await startEncounter()
    const r = await ask(encounterId, '您哪里不舒服？')
    console.log('ASK', r.status, JSON.stringify(r.ok ? null : await r.text()))
    await held.reached
    console.log('reached')
  })
})
