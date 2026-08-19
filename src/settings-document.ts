import { randomUUID } from 'node:crypto'

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class SettingsDocumentClient {
  constructor(
    private readonly baseUrl: URL,
    private readonly fetcher: Fetch = fetch,
  ) {
    if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1' || baseUrl.pathname !== '/' || baseUrl.search !== '' || baseUrl.hash !== '') {
      throw new TypeError('settings document client requires a trusted loopback DSH origin')
    }
  }

  async open(): Promise<void> {
    const rpcId = randomUUID()
    const method = 'settings.openDocument'
    const response = await this.fetcher(new URL('/api/' + method, this.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: {} }),
    })
    if (!response.ok) throw new Error('DSH settings request returned HTTP ' + String(response.status))
    let body: unknown
    try { body = await response.json() } catch (error: unknown) {
      throw new Error('DSH settings response is not valid JSON', { cause: error })
    }
    if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !isRecord(body.result)) {
      throw new Error('DSH settings response has an invalid RPC envelope')
    }
    if (body.result.ok === false) {
      const failure = isRecord(body.result.error) ? body.result.error : {}
      throw new Error(typeof failure.message === 'string' ? failure.message : 'DSH refused to open its settings document')
    }
    if (body.result.ok !== true || !isRecord(body.result.value) || body.result.value.opened !== true) {
      throw new Error('DSH settings response did not confirm the document was opened')
    }
  }
}
