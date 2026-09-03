# 自定义提供方 User-Agent 复写

## 业务行为

“设置 -> 模型 -> 添加自定义提供方”现在增加 `User-Agent` 输入项。留空时继续使用 DSH 默认标识；填写后，创建的提供方会将该值保存到 `llm-pi-ai.providers.<Provider ID>.headers.User-Agent`，后续模型 API 请求使用该值复写默认 `user-agent`。

已创建的自定义提供方也会在编辑卡片中显示该输入项。清空并保存会移除已有的 User-Agent 复写；其他自定义请求头保持不变。请求头名称按 HTTP 规则忽略大小写，已有 `user-agent` 或其他大小写形式也能被读取并替换。

## 注入落点

该功能只修改桌面壳，不落盘修改 DSH Runtime 或 DSH 包：

1. preload 在页面模块注册前复用桌面壳现有的 `ModuleLoader` 接管点。
2. 只转换 `@deepseek-ai/dsh-client-ui-settings-models` 的模块工厂，为自定义提供方的创建和编辑卡片补充输入项，并继续通过原有 `settings.mutate` 写入配置。
3. DSH 子进程预加载钩子继续只拦截 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js`，使配置中的 User-Agent 在请求组装时覆盖 DSH 默认归因 User-Agent。
4. 未填写复写值时，请求行为保持原样。

当前客户端与请求转换点对应 DSH `0.1.1-rc.2`。升级 Runtime 后需要重新运行专项测试和真实 Electron 请求烟测；若上游调整设置模块或请求头组装结构，转换会停止命中并保留上游原行为。

## 验证入口

```powershell
pnpm exec vitest run tests/custom-provider-user-agent-injector.spec.ts tests/custom-provider-image-injector.spec.ts tests/conversation-replay-shell-injector.spec.ts --maxWorkers=1 --testTimeout=20000
pnpm exec vitest run --maxWorkers=1 --testTimeout=20000
pnpm run typecheck
pnpm run build
```

真实运行验证应创建一个带 User-Agent 复写的自定义提供方，将请求发送到可回显请求头的模型网关，并确认收到的 `user-agent` 与输入值一致。
