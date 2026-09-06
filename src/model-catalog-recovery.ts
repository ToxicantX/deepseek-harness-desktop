const MAX_ATTEMPTS = 2
const FAILURE = /session\/modelCatalog failed:\s*Failed to fetch/u

export function shouldRecoverModelCatalog(message: string, attempts: number): boolean {
  return attempts < MAX_ATTEMPTS && FAILURE.test(message)
}

export const maxModelCatalogRecoveryAttempts = MAX_ATTEMPTS
