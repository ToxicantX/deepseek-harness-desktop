import { readUsageSnapshot, type UsageScanProgress, type UsageSnapshot } from './usage-monitor.ts'

/** One service per DSH home; the scanner retains unchanged-file results. */
export class UsageMonitorService {
  private snapshot: UsageSnapshot | undefined
  private pending: Promise<UsageSnapshot> | undefined
  private readonly listeners = new Set<(progress: UsageScanProgress) => void>()
  private progress: UsageScanProgress | undefined

  constructor(private readonly home: string, private readonly scan = readUsageSnapshot) {}

  initialize(onProgress?: (progress: UsageScanProgress) => void): Promise<UsageSnapshot> {
    return this.snapshot === undefined ? this.read(onProgress) : Promise.resolve(this.snapshot)
  }

  read(onProgress?: (progress: UsageScanProgress) => void): Promise<UsageSnapshot> {
    if (onProgress) {
      this.listeners.add(onProgress)
      if (this.progress) this.notify(onProgress, this.progress)
    }
    if (!this.pending) {
      this.pending = Promise.resolve().then(() => this.scan(this.home, progress => {
        this.progress = progress
        for (const listener of this.listeners) this.notify(listener, progress)
      })).then(snapshot => {
        this.snapshot = snapshot
        return snapshot
      }).finally(() => {
        this.pending = undefined
        this.progress = undefined
        this.listeners.clear()
      })
    }
    return this.pending
  }

  private notify(listener: (progress: UsageScanProgress) => void, progress: UsageScanProgress): void {
    try { listener({ ...progress }) } catch { /* Closed windows do not cancel initialization. */ }
  }
}
