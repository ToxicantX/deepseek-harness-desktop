# 对话消息编辑与重试

## 功能说明

已发送的用户消息下方提供复制、重试和编辑操作：

- **编辑**：进入内联编辑状态；确认后以修改后的文本重新发起该问题。
- **重试**：不修改原文本，直接重新发起该问题。
- 两种操作都会从目标消息之前的最后一个完整轮次创建会话分支。新分支只保留该边界之前的内容，因此目标消息及其后续对话不会继续显示。
- 如果目标是会话首条用户消息，则在相同工作区中创建空会话后重新发送；无法匹配工作区时沿用原会话的工作目录。
- 原会话历史保留在父分支中，便于回看；只有重新发送成功后才切换到新分支。

## 内容处理

- 文本编辑会替换原消息中的文本内容。
- 原消息中的图片会读取并随新请求重新上传。
- 包含其他未知内容块的消息会禁用编辑和重试，避免静默丢失内容。
- 纯空文本且没有图片时，不允许确认重新发送。

## 长文本历史展示

- 与输入框保持一致，超过 500 个字符的用户消息在发送后默认显示为 `.textclip` 折叠标签，不再完整占满历史对话。
- 点击折叠标签可临时展开全文；展开区域限制高度并在内部滚动，再次点击可收起。
- 复制、编辑和重试仍使用完整原文；进入编辑状态时，编辑框会载入全部内容。
- 500 个字符及以内的普通消息维持原有气泡展示。

## Runtime 集成

该能力由 `runtime/conversation-replay-plugin` 提供。Runtime 构建会：

1. 将插件复制到 `app/plugins/conversation-replay`。
2. 在 Runtime 的 `app/package.json` 中注册本地插件依赖。
3. 将插件加入 DSH manifest 的依赖闭包，保证 Profile 能解析插件。
4. 通过 `runtime/desktop.patch.yml` 将插件插入 Desktop Profile。

## 验证入口

```powershell
pnpm exec vitest run tests/conversation-replay-runtime-plugin.spec.mjs --maxWorkers=1 --testTimeout=20000
pnpm exec vitest run --maxWorkers=1 --testTimeout=20000
pnpm run typecheck
pnpm run build
```
