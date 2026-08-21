import { describe, expect, it } from 'vitest'
import { createRepairPlan, decodeSessionLog, inspectSequence, renumberSessionEvents } from '../runtime/session-repair-plugin/core.mjs'

const event = (seq, extra = {}) => ({ seq, time: seq + 100, type: 'test/event', data: {}, ...extra })

describe('session repair core', () => {
  it('decodes JSONL records and expands packed rows', () => {
    const parsed = decodeSessionLog('{"type":"session","id":"s"}\n{"packed":true}\n{"seq":2}\n', record => record.packed ? [event(0), event(1)] : [event(record.seq)])
    expect(parsed.header).toMatchObject({ id: 's' })
    expect(parsed.events.map(value => value.seq)).toEqual([0, 1, 2])
  })

  it('rejects invalid headers, incomplete records, and invalid decoder output', () => {
    expect(() => decodeSessionLog('', () => [])).toThrow('newline-terminated')
    expect(() => decodeSessionLog('header\n', () => [])).toThrow('header')
    expect(() => decodeSessionLog('{}\nnope\n', () => [])).toThrow('physical line 2')
    expect(() => decodeSessionLog('{}\n{}\n', record => record)).toThrow('event array')
  })

  it('identifies the branch, stale collision, and shifted continuation', () => {
    const events = [event(0), event(1), event(0), event(1), event(2), event(2), event(3), event(4)]
    expect(inspectSequence(events)).toEqual([
      { eventIndex: 2, expectedSeq: 2, actualSeq: 0, runLength: 3, kind: 'branch-reset' },
      { eventIndex: 5, expectedSeq: 5, actualSeq: 2, runLength: 1, kind: 'stale-single-event' },
      { eventIndex: 6, expectedSeq: 6, actualSeq: 3, runLength: 2, kind: 'branch-reset' },
    ])
    expect(inspectSequence([event(0), event(1), event(2)])).toEqual([])
    expect(inspectSequence([event(0), event(4)])).toMatchObject([{ kind: 'ambiguous' }])
  })

  it('uses the latest physical prior duplicate for every sequence reference', () => {
    const events = [
      event(0),
      event(1),
      event(0),
      event(1),
      event(2, {
        sourceEventSeqs: [0, 1],
        surfaceOp: { op: 'replace', start: 1, end: 0 },
        data: { shadowedSeqs: [1, 0], messageSeqs: [0, 1], shadowedRange: { start: 0, end: 1 } },
      }),
    ]
    const before = structuredClone(events)
    const repaired = renumberSessionEvents(events)
    expect(events).toEqual(before)
    expect(repaired.map(value => value.seq)).toEqual([0, 1, 2, 3, 4])
    expect(repaired[4].sourceEventSeqs).toEqual([2, 3])
    expect(repaired[4].surfaceOp).toEqual({ op: 'replace', start: 3, end: 2 })
    expect(repaired[4].data.shadowedSeqs).toEqual([3, 2])
    expect(repaired[4].data.shadowedRange).toEqual({ start: 3, end: 2 })
    expect(repaired[4].data.messageSeqs).toEqual([2, 3])
  })

  it('rebuilds every shadowed surface reference after a branch reset', () => {
    const events = [
      event(0, { type: 'user/message', surfaceOp: 'append' }),
      event(1, { type: 'tool/result', surfaceOp: 'append' }),
      event(2),
      event(1),
      event(2, { type: 'tool/result', surfaceOp: 'append' }),
      event(3, { type: 'compaction/start' }),
      event(4, { type: 'compaction/summary', data: { shadowedSeqs: [0, 2], shadowedRange: { start: 0, end: 2 } } }),
      event(5, {
        type: 'user/message',
        sourceEventSeqs: [3, 4, 0, 2],
        surfaceOp: { op: 'replace', start: 0, end: 2 },
      }),
    ]
    const repaired = renumberSessionEvents(events)
    expect(repaired.map(value => value.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(repaired[6].data.shadowedSeqs).toEqual([0, 1, 4])
    expect(repaired[6].data.shadowedRange).toEqual({ start: 0, end: 4 })
    expect(repaired[7].sourceEventSeqs).toEqual(expect.arrayContaining([5, 6, 0, 1, 4]))
    expect(repaired[7].surfaceOp).toEqual({ op: 'replace', start: 0, end: 4 })
  })

  it('rejects future, malformed, and range-only references', () => {
    expect(() => renumberSessionEvents([event(0, { sourceEventSeqs: [1] }), event(1)])).toThrow(/future/)
    expect(() => renumberSessionEvents([event(0), event(1, { data: { shadowedSeqs: 'bad' } })])).toThrow(/malformed/)
    expect(() => renumberSessionEvents([event(0, { data: { shadowedRange: { start: 0, end: 0 } } })])).toThrow(/without/)
  })

  it('validates repaired plans and rejects healthy or replay-invalid logs', () => {
    const content = '{"type":"session","id":"s"}\n{"seq":0}\n{"seq":0}\n{"seq":1}\n'
    const deps = { decodeStorageRecord: record => [event(record.seq)], validateReplay: events => ({ messageCount: events.length }) }
    const plan = createRepairPlan(content, deps)
    expect(plan.repairedEvents.map(value => value.seq)).toEqual([0, 1, 2])
    expect(plan.validation).toEqual({ messageCount: 3 })
    expect(() => createRepairPlan('{"id":"s"}\n{"seq":0}\n', deps)).toThrow(/healthy/)
    expect(() => createRepairPlan(content, { ...deps, validateReplay: () => { throw new Error('replay failed') } })).toThrow('replay failed')
  })
})
