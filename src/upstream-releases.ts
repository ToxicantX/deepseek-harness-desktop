import { rcompare, valid } from 'semver'

export const UPSTREAM_RELEASES_URL = 'https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=100'

export function latestUpstreamVersion(value: unknown): string {
  if (!Array.isArray(value)) throw new Error('上游版本列表格式无效')
  const versions = value.flatMap((release: unknown) => {
    if (release === null || typeof release !== 'object') return []
    const entry = release as Record<string, unknown>
    if (entry.draft !== false || typeof entry.tag_name !== 'string' || !entry.tag_name.startsWith('dsh-v')) return []
    const version = entry.tag_name.slice(5)
    return valid(version) === version ? [version] : []
  })
  const latest = versions.sort(rcompare)[0]
  if (latest === undefined) throw new Error('上游没有已发布的 DSH 版本')
  return latest
}

export async function loadLatestUpstreamVersion(): Promise<string> {
  // The /latest endpoint excludes prereleases, including DSH alpha releases.
  const response = await fetch(UPSTREAM_RELEASES_URL, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'deepseek-harness-desktop', 'cache-control': 'no-cache' },
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`检查上游版本失败：HTTP ${response.status}`)
  return latestUpstreamVersion(await response.json())
}
