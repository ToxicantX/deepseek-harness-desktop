import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ spawn }))

import { openTerminal } from '../src/cli-shell.ts'

class FakeChild extends EventEmitter {
  readonly unref = vi.fn()
}

describe('CLI terminal', () => {
  beforeEach(() => { spawn.mockReset() })

  it('opens a visible persistent Windows terminal with the DSH CLI on PATH', async () => {
    const child = new FakeChild()
    spawn.mockReturnValue(child)
    const opened = openTerminal('C:\\Desktop\\cli', 'C:\\Users\\tester\\.dsh', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      Path: 'C:\\Windows',
    })

    expect(spawn).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'start "" "%ComSpec%" /d /k "title DeepSeek Harness"'],
      {
        cwd: 'C:\\Users\\tester\\.dsh',
        env: expect.objectContaining({
          PATH: 'C:\\Desktop\\cli;C:\\Windows',
          Path: 'C:\\Desktop\\cli;C:\\Windows',
        }),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    )

    child.emit('spawn')
    await opened
    expect(child.unref).toHaveBeenCalledOnce()
  })
})
