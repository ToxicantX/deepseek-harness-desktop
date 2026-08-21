const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function ambiguous(message) {
  const error = new Error('ambiguous repair: ' + message)
  error.code = 'AMBIGUOUS_REPAIR'
  throw error
}

export function decodeSessionLog(content, decodeStorageRecord) {
  if (typeof content !== 'string' || !content.endsWith('\n')) throw new Error('session log must be newline-terminated')
  if (typeof decodeStorageRecord !== 'function') throw new TypeError('decodeStorageRecord must be a function')
  const lines = content.split('\n')
  lines.pop()
  if (lines.length === 0 || lines[0].trim() === '') throw new Error('session log requires a nonempty header line')
  let header
  try { header = JSON.parse(lines[0]) } catch (error) {
    throw new Error('session log header is not valid JSON', { cause: error })
  }
  if (!isRecord(header)) throw new Error('session log header must be an object')

  const events = []
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '') throw new Error('session log contains an empty record')
    let record
    try { record = JSON.parse(lines[index]) } catch (error) {
      throw new Error('session log contains invalid JSON at physical line ' + String(index + 1), { cause: error })
    }
    const decoded = decodeStorageRecord(record)
    if (!Array.isArray(decoded) || decoded.some(event => !isRecord(event))) {
      throw new Error('decodeStorageRecord must return an event array')
    }
    events.push(...decoded)
  }
  return { headerLine: lines[0], header, events }
}

export function inspectSequence(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array')
  const anomalies = []
  const seen = new Set()
  let previousSegment
  let index = 0
  while (index < events.length) {
    const actual = events[index]?.seq
    if (!Number.isSafeInteger(actual) || actual < 0) {
      anomalies.push({ eventIndex: index, expectedSeq: index, actualSeq: 0, runLength: 1, kind: 'ambiguous' })
      previousSegment = undefined
      index += 1
      continue
    }
    if (actual === index) {
      seen.add(actual)
      previousSegment = undefined
      index += 1
      continue
    }

    const start = index
    const delta = actual - start
    let length = 1
    while (start + length < events.length) {
      const next = events[start + length]?.seq
      if (!Number.isSafeInteger(next) || next < 0 || next !== actual + length || next - (start + length) !== delta) break
      length += 1
    }

    const staleTransition = previousSegment !== undefined
      && previousSegment.end === start
      && delta === previousSegment.delta - 1
      && seen.has(actual)
    if (staleTransition) {
      anomalies.push({ eventIndex: start, expectedSeq: start, actualSeq: actual, runLength: 1, kind: 'stale-single-event' })
      if (length > 1) {
        anomalies.push({ eventIndex: start + 1, expectedSeq: start + 1, actualSeq: actual + 1, runLength: length - 1, kind: 'branch-reset' })
      }
    } else {
      const kind = delta < 0 && (length > 1 || seen.has(actual)) ? (length === 1 ? 'stale-single-event' : 'branch-reset') : 'ambiguous'
      anomalies.push({ eventIndex: start, expectedSeq: start, actualSeq: actual, runLength: length, kind })
    }
    for (let offset = 0; offset < length; offset += 1) seen.add(actual + offset)
    previousSegment = { end: start + length, delta }
    index += length
  }
  return anomalies
}

function remapReferences(value, name, latest) {
  if (!Array.isArray(value) || value.some(seq => !Number.isSafeInteger(seq) || seq < 0)) ambiguous('malformed ' + name)
  return value.map(seq => {
    const mapped = latest.get(seq)
    if (mapped === undefined) ambiguous('missing or future ' + name + ' reference to seq ' + String(seq))
    return mapped
  })
}

function remapSurfaceOp(value, latest) {
  if (value === 'append') return value
  if (!isRecord(value) || value.op !== 'replace') return value
  if (!Object.hasOwn(value, 'start') || !Object.hasOwn(value, 'end')) ambiguous('replace surfaceOp is missing its range')
  return {
    ...value,
    start: remapReferences([value.start], 'surfaceOp.start', latest)[0],
    end: remapReferences([value.end], 'surfaceOp.end', latest)[0],
  }
}

function rebuildSurfaceReferences(events) {
  const surface = []
  for (const event of events) {
    if (event.surfaceOp === 'append') {
      surface.push(event.seq)
      continue
    }
    if (!isRecord(event.surfaceOp) || event.surfaceOp.op !== 'replace') continue
    const start = surface.indexOf(event.surfaceOp.start)
    const end = surface.indexOf(event.surfaceOp.end, start < 0 ? 0 : start)
    if (start < 0 || end < start) continue

    const shadowed = surface.slice(start, end + 1)
    if (Array.isArray(event.sourceEventSeqs)) {
      const referenced = new Set(event.sourceEventSeqs)
      for (const seq of shadowed) {
        if (!referenced.has(seq)) {
          event.sourceEventSeqs.push(seq)
          referenced.add(seq)
        }
      }
      for (const seq of event.sourceEventSeqs) {
        const source = events[seq]
        if (!isRecord(source?.data) || !Object.hasOwn(source.data, 'shadowedSeqs')) continue
        source.data.shadowedSeqs = [...shadowed]
        source.data.shadowedRange = { start: shadowed[0], end: shadowed[shadowed.length - 1] }
      }
    }
    surface.splice(start, end - start + 1, event.seq)
  }
}

export function renumberSessionEvents(events) {
  if (!Array.isArray(events)) throw new TypeError('events must be an array')
  const latest = new Map()
  const repaired = []
  for (let index = 0; index < events.length; index += 1) {
    const original = events[index]
    if (!isRecord(original) || !Number.isSafeInteger(original.seq) || original.seq < 0) ambiguous('event has an invalid seq at index ' + String(index))
    const event = structuredClone(original)
    if (Object.hasOwn(event, 'sourceEventSeqs')) {
      event.sourceEventSeqs = remapReferences(event.sourceEventSeqs, 'sourceEventSeqs', latest)
    }
    if (Object.hasOwn(event, 'surfaceOp')) event.surfaceOp = remapSurfaceOp(event.surfaceOp, latest)
    if (isRecord(event.data)) {
      const hasShadowed = Object.hasOwn(event.data, 'shadowedSeqs')
      if (hasShadowed) {
        event.data.shadowedSeqs = remapReferences(event.data.shadowedSeqs, 'data.shadowedSeqs', latest)
        if (event.data.shadowedSeqs.length === 0) ambiguous('data.shadowedSeqs must not be empty')
        event.data.shadowedRange = {
          start: event.data.shadowedSeqs[0],
          end: event.data.shadowedSeqs[event.data.shadowedSeqs.length - 1],
        }
      } else if (Object.hasOwn(event.data, 'shadowedRange')) {
        ambiguous('data.shadowedRange exists without data.shadowedSeqs')
      }
      if (Object.hasOwn(event.data, 'messageSeqs')) {
        event.data.messageSeqs = remapReferences(event.data.messageSeqs, 'data.messageSeqs', latest)
      }
    }
    event.seq = index
    repaired.push(event)
    latest.set(original.seq, index)
  }
  rebuildSurfaceReferences(repaired)
  return repaired
}

export function createRepairPlan(content, deps) {
  if (!isRecord(deps) || typeof deps.decodeStorageRecord !== 'function' || typeof deps.validateReplay !== 'function') {
    throw new TypeError('repair dependencies are required')
  }
  const decoded = decodeSessionLog(content, deps.decodeStorageRecord)
  const anomalies = inspectSequence(decoded.events)
  if (anomalies.length === 0) {
    const error = new Error('session log is healthy; repair is not required')
    error.code = 'HEALTHY_SESSION_LOG'
    throw error
  }
  if (anomalies.some(anomaly => anomaly.kind === 'ambiguous')) ambiguous('sequence pattern cannot be repaired safely')
  const repairedEvents = renumberSessionEvents(decoded.events)
  const validation = deps.validateReplay(repairedEvents)
  return { headerLine: decoded.headerLine, header: decoded.header, repairedEvents, anomalies, validation }
}
