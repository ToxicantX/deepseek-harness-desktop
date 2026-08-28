# 自定义提供方图片输入注入

## 业务行为

桌面壳会为 `llm-pi-ai` 管理的自定义提供方补充图片输入能力。模型条目和提供方都没有声明输入类型时，桌面壳按 `text + image` 处理；模型级 `input` 或提供方级 `defaultInput` 已显式声明时继续以该声明为准。

这样处理的是完整发送链路，而不只是隐藏“当前模型不支持图片”的界面提示：图片会先经过 DSH 既有的大小、格式和持久化校验，再随当前消息进入自定义提供方请求。接口自身不接收图片时，其原始错误会继续显示。

如需明确限制某个模型，可在该模型条目中声明：

```yaml
input:
  - text
```

如需明确标注识图模型，可声明：

```yaml
input:
  - text
  - image
```

## 注入落点

该功能只修改桌面壳：

1. 桌面壳启动 DSH 子进程时继续通过 `--import lib/shutdown-hook.js` 预加载壳侧脚本。
2. 预加载脚本使用 Node `registerHooks` 劫持 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 的首次加载。
3. 只将该适配器“未声明输入类型”时使用的默认值扩展为 `text + image`；模型级 `input`、提供方级 `defaultInput` 及内置模型目录声明继续优先。
4. Runtime 目录、DSH 包和用户设置文件均不落盘修改。

发布时需要重新构建并发布桌面壳安装包；单独更新 Runtime 不会包含该注入。

当前转换点与 DSH `0.1.1-rc.2` 的 `llm-pi-ai` 默认输入声明对应。升级 DSH 后应先运行专项测试和真实请求体烟测；若上游调整该结构，壳侧转换将不再命中，需要同步更新注入规则。

## 验证入口

```powershell
pnpm exec vitest run tests/custom-provider-image-injector.spec.ts --maxWorkers=1 --testTimeout=20000
pnpm exec vitest run --maxWorkers=1 --testTimeout=20000
pnpm run typecheck
pnpm run build
```
