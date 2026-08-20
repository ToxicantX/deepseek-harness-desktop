export interface WebPermissionRequest {
  permission: string
  requestingUrl: string
  currentUrl: string
  trustedOrigin: string | undefined
  mainWindow: boolean
}

export function shouldOpenInSystemBrowser(candidate: string, trustedOrigin: string | undefined): boolean {
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)
    if (loopback) return false
    return trustedOrigin === undefined || url.origin !== trustedOrigin
  } catch {
    return false
  }
}

export function allowDshWebPermission(request: WebPermissionRequest): boolean {
  if (!request.mainWindow || request.permission !== 'clipboard-sanitized-write' || request.trustedOrigin === undefined) return false
  try {
    return new URL(request.requestingUrl).origin === request.trustedOrigin
      && new URL(request.currentUrl).origin === request.trustedOrigin
  } catch {
    return false
  }
}
