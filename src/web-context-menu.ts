import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

export type WebContextMenuParams = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>

function roleItem(
  label: string,
  role: NonNullable<MenuItemConstructorOptions['role']>,
  enabled: boolean,
): MenuItemConstructorOptions {
  return { label, role, enabled }
}

export function createWebContextMenuTemplate(params: WebContextMenuParams): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  if (!params.isEditable) {
    return [
      roleItem('复制', 'copy', params.selectionText.length > 0 && flags.canCopy),
      roleItem('全选', 'selectAll', flags.canSelectAll),
    ]
  }

  return [
    roleItem('撤销', 'undo', flags.canUndo),
    roleItem('重做', 'redo', flags.canRedo),
    { type: 'separator' },
    roleItem('剪切', 'cut', flags.canCut),
    roleItem('复制', 'copy', flags.canCopy),
    roleItem('粘贴', 'paste', flags.canPaste),
    roleItem('删除', 'delete', flags.canDelete),
    { type: 'separator' },
    roleItem('全选', 'selectAll', flags.canSelectAll),
  ]
}
