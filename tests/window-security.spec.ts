import { describe, expect, it } from 'vitest'
import { allowDshWebPermission, shouldOpenInSystemBrowser } from '../src/window-security.ts'

const trusted = 'http://127.0.0.1:43120'
const base = { permission: 'clipboard-sanitized-write', requestingUrl: trusted + '/chat', currentUrl: trusted + '/session/1', trustedOrigin: trusted, mainWindow: true }

describe('shouldOpenInSystemBrowser', () => {
  it('suppresses trusted DSH popups while preserving external links', () => {
    expect(shouldOpenInSystemBrowser(trusted + '/', trusted)).toBe(false)
    expect(shouldOpenInSystemBrowser(trusted + '/session/1', trusted)).toBe(false)
    expect(shouldOpenInSystemBrowser('https://example.com/docs', trusted)).toBe(true)
    expect(shouldOpenInSystemBrowser('http://127.0.0.1:43121/', trusted)).toBe(false)
    expect(shouldOpenInSystemBrowser('http://127.12.34.56:8080/', undefined)).toBe(false)
    expect(shouldOpenInSystemBrowser('http://localhost:8080/', undefined)).toBe(false)
    expect(shouldOpenInSystemBrowser('http://[::1]:8080/', undefined)).toBe(false)
    expect(shouldOpenInSystemBrowser('file:///C:/secret.txt', trusted)).toBe(false)
    expect(shouldOpenInSystemBrowser('not a url', trusted)).toBe(false)
  })
})

describe('allowDshWebPermission', () => {
  it('allows only clipboard writes from the trusted DSH main window', () => {
    expect(allowDshWebPermission(base)).toBe(true)
    expect(allowDshWebPermission({ ...base, permission: 'clipboard-read' })).toBe(false)
    expect(allowDshWebPermission({ ...base, mainWindow: false })).toBe(false)
    expect(allowDshWebPermission({ ...base, requestingUrl: 'https://attacker.test/' })).toBe(false)
    expect(allowDshWebPermission({ ...base, trustedOrigin: undefined })).toBe(false)
  })
})
