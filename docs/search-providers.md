# 桌面搜索渠道

在 **Runtime → 搜索设置** 中填写 Exa 或 Perplexity 的 API Key。默认接口分别是 `https://api.exa.ai` 和 `https://api.perplexity.ai`，填写基础地址即可，不需要追加搜索路径。保存时留空密钥会保留原值，勾选移除才会删除。

选择“自动选择可用渠道”时，先尝试 DSH 当前指定的搜索提供商。缺少配置或凭据时，依次尝试 Exa、Perplexity 和其他已注册的原生搜索插件（插件 ID 排序）。已有搜索提供商能正常工作时继续使用它；同时配置多种渠道后，可以明确选择 Exa 或 Perplexity。

自动切换仅处理缺少配置/凭据。HTTP 错误、网络错误和取消请求会直接反馈，不把它们伪装成空结果，也不会在请求已发出后擅自转到另一付费渠道。没有任何可用渠道时提示打开搜索设置。

搜索继续使用 DSH 的 `web_search` 工具、权限检查、查询数量限制、来源引用和搜索卡片。不接管 `web_fetch`，MCP 搜索工具仍经 MCP 调用链使用，不会自动转成原生搜索提供商。

## 存储与生效

- 壳用户数据目录中的 `search-settings.bin` 使用 Electron `safeStorage` 加密；Windows 下由系统保护，不以明文写入配置文件，也不写入 DSH Profile。
- 已保存的密钥不回传设置窗口；仅在启动 Runtime 时供其搜索适配器使用。可以复用启动环境中的 `EXA_API_KEY` / `PERPLEXITY_API_KEY`，不需要重复填写。
- 保存前会确认重启 Runtime，正在执行的任务会中断。更换聊天模型或上游默认搜索渠道不会覆盖壳内保存的密钥。
- 对已验证的旧版静态配置与新版动态配置 Runtime 分别匹配加载锚点。未知结构保留原模块并输出 `Desktop search: unknown runtime layout`，需更新适配器，不改写安装目录。
- 需要包含 `dsh-web` 服务的 Runtime；本地 0.1.3-alpha.1 至 0.2.1-rc.2 的 14 个已安装版本均匹配适配锚点。实际工具调用验证覆盖 0.1.7-alpha.2 与 0.2.1-rc.2，锚点匹配本身不等同于全版本功能验收。

## 验证

```powershell
pnpm test
pnpm run build
node scripts/smoke-search.mjs '<Runtime 目录>' --built
node scripts/smoke-search-settings.mjs --playwright '<Playwright 模块路径>'
```

搜索冒烟使用真实安装的 DSH `ToolRuntime.execute` 与本机 HTTP fixture，检查原始结果校验、多查询、截断、引用和缺少凭据的回退。加上 `--live-exa` 会使用已有 `EXA_API_KEY` 发起一次真实 Exa 搜索；该选项会消耗服务配额。窗口冒烟使用隔离的临时配置、真实系统加密和 Playwright Electron，不修改当前安装版或用户密钥。

如果本机 Electron 连 `--version` 都以 `0x80000003` 退出，可仅对隔离的窗口冒烟添加 `--no-sandbox`。这不会修改产品中的 `sandbox: true`，但该次冒烟不代表操作系统沙箱已通过运行验收。
