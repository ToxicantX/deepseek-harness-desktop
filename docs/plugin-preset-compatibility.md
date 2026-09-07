# 插件预设兼容迁移

## 适用问题

DSH 核心将 Code Mode 的配置值从 `code` 更名为 `ptc` 后，旧版 `dsh-multi-model-orchestrator` 仍可能生成 `mode: code`，导致选择该预设创建会话时报 `agent-preset/invalid`。

## 桌面壳处理

- Runtime 启动前读取当前 DSH 的 `@deepseek-ai/dsh-agent-presets` 包内预设，并兼容旧版 DSH CLI 包内的 `config/agent-presets` 目录，以其 `tool-presentation` 配置判断当前 Runtime 是否已经使用 `ptc`。
- 仅当 Web Profile 中安装包确认为 `dsh-multi-model-orchestrator`，且主预设或旧 ID 兼容预设的受管源仍为 `mode: code` 时，将该标量迁移为 `mode: ptc`。
- 指向 Profile 外部源码目录的 link 安装不自动改写，由插件项目自身维护其预设模板。
- 只替换目标 YAML 标量，保留其余配置、注释和换行；重复启动不会产生重复改动。
- 写入通过同目录临时文件替换原模板，先断开 pnpm Store 硬链接，不修改共享包缓存中的原始内容。
- 新版 Runtime 已移除 `@deepseek-ai/dsh-client-runtime` 时，同步从插件客户端预加载清单中删除该旧模块；插件客户端实际使用的设置、语言和 API 模块保持不变。
- 插件随后沿用自身的受管预设安装流程更新 `%DSH_HOME%\.agent-presets\multi-model-orchestrator`，不直接覆盖用户自定义预设。
- 兼容准备成功后，只解除该插件因 `removed-client-runtime` 产生的隔离记录；手工隔离和其他导入故障记录保持不变。插件重新加载仍失败时，启动隔离会按新错误再次禁用插件。

## 故障隔离

兼容迁移属于第三方插件增强。文件缺失、格式变化或写入失败时，桌面壳继续启动 DSH Runtime，基础窗口和普通预设会话不受该迁移异常阻断。

## 验证入口

```powershell
pnpm run typecheck
pnpm exec vitest run tests/plugin-preset-compatibility.spec.ts tests/plugin-isolation.spec.ts tests/runtime-controller-overlay.spec.ts --maxWorkers=1 --testTimeout=20000
pnpm test -- --maxWorkers=1 --testTimeout=20000
pnpm run build
git diff --check
```
