import { describe, expect, it } from 'vitest'
import { allowDshWebPermission } from '../src/window-security.ts'

const trusted = 'http://127.0.0.1:43120'
const base = { permission: 'clipboard-sanitized-write', requestingUrl: trusted + '/chat', currentUrl: trusted + '/session/1', trustedOrigin: trusted, mainWindow: true }

describe('allowDshWebPermission', () => {
  it('allows only clipboard writes from the trusted DSH main window', () => {
    expect(allowDshWebPermission(base)).toBe(true)
    expect(allowDshWebPermission({ ...base, permission: 'clipboard-read' })).toBe(false)
    expect(allowDshWebPermission({ ...base, mainWindow: false })).toBe(false)
    expect(allowDshWebPermission({ ...base, requestingUrl: 'https://attacker.test/' })).toBe(false)
    expect(allowDshWebPermission({ ...base, trustedOrigin: undefined })).toBe(false)
  })
})
