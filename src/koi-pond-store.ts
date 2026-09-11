import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const POND_CAPACITY = 16
export type KoiPattern = 'kohaku' | 'sanke' | 'ogon' | 'shusui'
export interface Koi {
  id: string
  name: string
  sex: 'female' | 'male'
  pattern: KoiPattern
  level: number
  bred: boolean
  generation: number
}
export interface KoiEgg {
  id: string
  parents: [string, string]
  remaining: number
  pattern: KoiPattern
  generation: number
}
export interface PondState {
  version: 1
  dialogues: number
  fish: Koi[]
  eggs: KoiEgg[]
  recentIds: string[]
}
export type PondView = Omit<PondState, 'recentIds'>

function initialState(): PondState {
  return {
    version: 1, dialogues: 0, eggs: [], recentIds: [],
    fish: (['kohaku', 'sanke', 'ogon', 'shusui'] as const).map((pattern, index) => ({
      id: randomUUID(), name: ['丹枫', '墨雪', '小金', '浅葱'][index]!,
      sex: index % 2 === 0 ? 'female' : 'male', pattern, level: 0, bred: false, generation: 1,
    })),
  }
}

const integer = (value: unknown, minimum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
const shortId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256
const pattern = (value: unknown): value is KoiPattern =>
  value === 'kohaku' || value === 'sanke' || value === 'ogon' || value === 'shusui'

function validState(value: unknown): value is PondState {
  if (!value || typeof value !== 'object') return false
  const s = value as PondState
  if (s.version !== 1 || !integer(s.dialogues, 0) || !Array.isArray(s.fish)
    || s.fish.length < 1 || !Array.isArray(s.eggs) || s.fish.length + s.eggs.length > POND_CAPACITY
    || !Array.isArray(s.recentIds) || s.recentIds.length > 4096
    || !s.recentIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 1600)) return false
  if (!s.fish.every(f => f && shortId(f.id) && typeof f.name === 'string' && f.name.trim().length > 0
    && Array.from(f.name).length <= 16 && (f.sex === 'female' || f.sex === 'male') && pattern(f.pattern)
    && integer(f.level, 0) && typeof f.bred === 'boolean' && integer(f.generation, 1))) return false
  const ids = new Set(s.fish.map(f => f.id))
  return ids.size === s.fish.length && s.eggs.every(e => e && shortId(e.id)
    && Array.isArray(e.parents) && e.parents.length === 2 && e.parents[0] !== e.parents[1]
    && e.parents.every(id => ids.has(id)) && integer(e.remaining, 1) && e.remaining <= 5
    && pattern(e.pattern) && integer(e.generation, 2))
    && new Set([...ids, ...s.eggs.map(e => e.id)]).size === s.fish.length + s.eggs.length
}

/** Shell-only save. Commit memory only after the atomic replacement succeeds. */
export class KoiPondStore {
  private state = initialState()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly ready: Promise<void>

  constructor(private readonly path: string) {
    this.ready = this.load()
    // Initialization may finish before a window or the first dialogue observes it.
    void this.ready.catch(() => {})
  }

  private async load(): Promise<void> {
    try {
      const saved: unknown = JSON.parse(await readFile(this.path, 'utf8'))
      if (!validState(saved)) throw new Error('鱼塘存档格式不匹配；已保留原文件')
      this.state = saved
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.save(this.state)
    }
  }

  private async save(state: PondState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path + '.tmp', JSON.stringify(state, null, 2), 'utf8')
    await rename(this.path + '.tmp', this.path)
  }

  async view(): Promise<PondView> {
    await this.ready
    await this.queue
    const { recentIds: _ids, ...view } = this.state
    return structuredClone(view)
  }

  private mutate(update: (next: PondState) => boolean): Promise<boolean> {
    const operation = this.queue.then(async () => {
      await this.ready
      const next = structuredClone(this.state)
      if (!update(next)) return false
      await this.save(next)
      this.state = next
      return true
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  recordDialogue(sessionId: string, requestId: string): Promise<boolean> {
    if (!shortId(sessionId) || sessionId.length > 128 || !shortId(requestId) || requestId.length > 128) {
      return Promise.resolve(false)
    }
    const key = JSON.stringify([sessionId, requestId])
    return this.mutate(next => {
      if (next.recentIds.includes(key)) return false
      next.recentIds = [...next.recentIds, key].slice(-4096)
      next.dialogues++
      for (const fish of next.fish) fish.level++
      // Incubate existing eggs first; a new clutch needs five further dialogues.
      for (const egg of next.eggs) {
        egg.remaining--
        if (egg.remaining === 0) next.fish.push({
          id: egg.id, name: `锦鲤 ${next.fish.length + 1}`, sex: Math.random() < 0.5 ? 'female' : 'male',
          pattern: egg.pattern, level: 0, bred: false, generation: egg.generation,
        })
      }
      next.eggs = next.eggs.filter(egg => egg.remaining > 0)
      for (const mother of next.fish.filter(f => f.sex === 'female' && f.level >= 500 && !f.bred)) {
        if (next.fish.length + next.eggs.length >= POND_CAPACITY) break
        const father = next.fish.find(f => f.sex === 'male' && f.level >= 500 && !f.bred)
        if (!father) break
        mother.bred = father.bred = true
        next.eggs.push({
          id: randomUUID(), parents: [mother.id, father.id], remaining: 5,
          pattern: Math.random() < 0.5 ? mother.pattern : father.pattern,
          generation: Math.max(mother.generation, father.generation) + 1,
        })
      }
      return true
    })
  }

  renameFish(id: unknown, name: unknown): Promise<boolean> {
    if (typeof id !== 'string' || typeof name !== 'string' || name.trim().length === 0
      || Array.from(name.trim()).length > 16 || /[\u0000-\u001f]/u.test(name)) return Promise.resolve(false)
    return this.mutate(next => {
      const fish = next.fish.find(f => f.id === id)
      if (!fish || fish.name === name.trim()) return false
      fish.name = name.trim()
      return true
    })
  }

  async flush(): Promise<void> {
    await this.ready
    await this.queue
  }
}
