import { describe, expect, it } from 'vitest'
import { maxModelCatalogRecoveryAttempts, shouldRecoverModelCatalog } from '../src/model-catalog-recovery.ts'

describe('model catalog connection recovery', () => {
  it('only retries the exact stale-fetch error and bounds retries', () => {
    expect(shouldRecoverModelCatalog('gateway/internal: client api: session/modelCatalog failed: Failed to fetch', 0)).toBe(true)
    expect(shouldRecoverModelCatalog('gateway/internal: client api: session/modelCatalog failed: Failed to fetch', maxModelCatalogRecoveryAttempts)).toBe(false)
    expect(shouldRecoverModelCatalog('session/modelCatalog failed: 401 Unauthorized', 0)).toBe(false)
    expect(shouldRecoverModelCatalog('provider request failed: Failed to fetch', 0)).toBe(false)
  })
})
