import { describe, expect, it } from 'vitest'
import { createWebContextMenuTemplate, type WebContextMenuParams } from '../src/web-context-menu.ts'

const editFlags: WebContextMenuParams['editFlags'] = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: true,
  canDelete: false,
  canSelectAll: true,
  canEditRichly: false,
}

describe('createWebContextMenuTemplate', () => {
  it('offers only copy and select-all outside editable fields', () => {
    expect(createWebContextMenuTemplate({ isEditable: false, selectionText: 'selected', editFlags })).toEqual([
      { label: '复制', role: 'copy', enabled: true },
      { label: '全选', role: 'selectAll', enabled: true },
    ])
    expect(createWebContextMenuTemplate({ isEditable: false, selectionText: '', editFlags })[0]).toMatchObject({ role: 'copy', enabled: false })
  })

  it('maps Electron edit capabilities without custom clipboard access', () => {
    const template = createWebContextMenuTemplate({ isEditable: true, selectionText: '', editFlags })
    expect(template.map(item => item.role ?? item.type)).toEqual([
      'undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'delete', 'separator', 'selectAll',
    ])
    expect(template.find(item => item.role === 'redo')).toMatchObject({ enabled: false })
    expect(template.find(item => item.role === 'delete')).toMatchObject({ enabled: false })
  })
})
