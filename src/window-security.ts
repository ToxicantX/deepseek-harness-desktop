export interface WebPermissionRequest {
  permission: string
  requestingUrl: string
  currentUrl: string
  trustedOrigin: string | undefined
  mainWindow: boolean
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
