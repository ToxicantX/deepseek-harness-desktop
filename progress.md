## 2026-08-24 - Task: 为已发送的用户消息增加编辑与重试重新发起功能
### What was done
- 在 Desktop Runtime 中新增对话重放客户端插件，为用户消息增加复制、重试和编辑入口，并提供内联编辑、取消、确认重新发送状态。
- 编辑或重试时从目标消息之前的完整轮次创建新分支；首条消息在相同工作区或工作目录创建空会话。重新发送成功后再打开新分支，使目标消息及其后续记录从当前视图移除，同时保留父分支历史。
- 重新发送时保留原消息图片；遇到未知内容块时禁用编辑和重试，避免内容丢失。
- 将插件接入 Runtime 构建、DSH 依赖闭包和 Desktop Profile，并补充功能文档与回归测试。
### Testing
- `pnpm exec vitest run tests/conversation-replay-runtime-plugin.spec.mjs --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、5 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，35 个测试文件、264 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 为 22.22.0，仓库声明 Node.js 24，因此 pnpm 输出 engine 警告。
- `pnpm run build`：通过；TypeScript 检查及 tsdown 构建完成，同样存在上述 Node.js engine 警告。
- 使用 Runtime 自带 Node.js 24.19.0 启动独立 `dsh web`，在真实会话界面确认用户消息渲染出重试和编辑按钮；点击编辑后原文正确进入内联编辑框，确认与取消按钮可见，取消后恢复普通消息气泡；共检测到 2 条用户消息、0 个页面错误。未点击确认或重试，以免对用户现有会话发起真实模型请求；重新发送与分支边界由自动化测试覆盖。
- 停止独立烟测服务后，已重新启动本机 DeepSeek Harness 桌面应用。
### Notes
- `runtime/conversation-replay-plugin/package.json`：声明 Desktop 对话编辑与重试插件及其客户端依赖。
- `runtime/conversation-replay-plugin/index.js`：提供插件服务端空入口。
- `runtime/conversation-replay-plugin/client.js`：实现用户消息渲染覆盖、编辑界面、重试、分支创建、附件重传和错误状态。
- `runtime/desktop.patch.yml`：将对话编辑与重试插件加入 Desktop Profile。
- `scripts/build-runtime.ps1`：将插件复制进 Runtime、注册本地依赖并加入 DSH 依赖闭包。
- `tests/conversation-replay-runtime-plugin.spec.mjs`：覆盖内容拆分、图片重传、普通轮次 fork、首轮新建会话和 Runtime 注册。
- `docs/conversation-edit-retry.md`：记录用户行为、分支语义、内容限制、Runtime 集成和验证入口。
- `progress.md`：追加本轮施工与验证记录。
- 回滚本轮功能代码：`git restore -- runtime/desktop.patch.yml scripts/build-runtime.ps1; Remove-Item -LiteralPath runtime/conversation-replay-plugin -Recurse -Force; Remove-Item -LiteralPath tests/conversation-replay-runtime-plugin.spec.mjs,docs/conversation-edit-retry.md -Force`。

## 2026-08-24 - Task: 在当前 DSH 0.1.1-rc.2 Runtime 安装并复核对话编辑与重试插件
### What was done
- 桌面应用重启后检测到实际运行版本已切换为 DSH 0.1.1-rc.2，因此在该 Runtime 中同步安装本轮插件、Desktop Patch 和 DSH 插件依赖闭包。
- 完成当前 Runtime 的真实 Web 界面烟测后停止独立服务，并重新启动 DeepSeek Harness 桌面应用；桌面后端现使用 0.1.1-rc.2 Runtime。
### Testing
- 使用 Runtime 自带 pnpm 11.7.0 完成依赖安装，最终确认 session-repair、pet-bridge、conversation-replay 三个插件依赖和链接均存在。首次离线安装因本机 store 缺少 `@deepseek-ai/dsh@0.1.1-rc.2` tarball 终止，随后联网安装完成。
- 使用 Runtime 自带 Node.js 24.19.0 启动 `dsh web`：成功加载 Desktop Patch。
- Playwright 真实界面烟测：检测到 2 条用户消息；重试与编辑按钮均可用；编辑框内容与原消息一致；确认、取消按钮可见；取消后恢复普通气泡；页面错误为 0。未触发真实重新发送，避免改动用户已有会话。
- 重新启动桌面应用后确认主进程和 0.1.1-rc.2 `dsh web` 后端进程均在运行。
### Notes
- `%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2\app\plugins\conversation-replay\`：安装当前工作区的对话编辑与重试插件。
- `%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2\app\package.json`：增加 conversation-replay 本地依赖。
- `%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2\app\pnpm-lock.yaml`：记录插件本地依赖解析结果。
- `%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2\app\desktop.patch.yml`：插入 conversation-replay 插件。
- `%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2\app\node_modules\@deepseek-ai\dsh\package.json`：补齐三个 Desktop 插件的依赖闭包。
- 回滚点：`C:\Users\karma617\AppData\Local\Temp\dsh-conversation-replay-runtime-backup-rc2-25aec23dfe3e45be8e39235d7a34beff`，包含修改前的 `package.json`、`pnpm-lock.yaml`、`desktop.patch.yml` 和 DSH `package.json`。

## 2026-08-24 - Task: 让已发送的超长用户文本在历史对话中保持折叠
### What was done
- 用户消息超过 500 个字符时，历史对话默认显示为紧凑的 `.textclip` 折叠标签，不再直接展开全部正文；阈值与输入框的长文本折叠规则保持一致。
- 点击 `.textclip` 标签可展开完整正文，展开区域限制为 360px 高度并在内部滚动；再次点击恢复折叠。
- 复制、编辑和重试继续使用完整原文；进入编辑后仍载入全部长文本，取消编辑后恢复折叠状态。
- 将更新后的客户端插件同步到本机当前使用的 DSH 0.1.1-rc.2 Runtime，并重新启动桌面应用。
### Testing
- `node --check runtime/conversation-replay-plugin/client.js`：通过。
- `pnpm exec vitest run tests/conversation-replay-runtime-plugin.spec.mjs --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、6 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，35 个测试文件、265 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，因此 pnpm 输出 engine 警告。
- `pnpm run build`：通过；TypeScript 检查及 tsdown 构建完成，同样存在上述 Node.js engine 警告。
- Playwright 真实界面烟测：1096 字符的已发送用户消息默认折叠为 `.textclip`；点击后能展开完整 1096 字符并再次收起；进入编辑时仍保留全部 1096 字符；取消后恢复折叠；页面错误为 0。
- 独立烟测服务已停止，DeepSeek Harness 桌面主进程和 DSH 0.1.1-rc.2 后端已重新启动。
### Notes
- `runtime/conversation-replay-plugin/client.js`：增加长文本阈值判断、折叠标签、展开/收起交互和滚动限制。
- `tests/conversation-replay-runtime-plugin.spec.mjs`：增加 500/501 字符边界和 `.textclip` 标签摘要测试。
- `docs/conversation-edit-retry.md`：补充长文本历史展示规则及编辑、复制、重试行为。
- `progress.md`：追加本轮施工与验证记录。
- `%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2\app\plugins\conversation-replay\client.js`：同步当前 Runtime 插件源码。
- `%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2\app\node_modules\@deepseek-ai\dsh-desktop-conversation-replay\client.js`：同步当前 Runtime 实际加载文件。
- 回滚本轮 Runtime 更新的备份点：`C:\Users\karma617\AppData\Local\Temp\dsh-conversation-textclip-backup-rc2-d07918c0251d43e5918bf75323fd5918\client.js`。
- 回滚本轮仓库功能：从变更前版本恢复 `runtime/conversation-replay-plugin/client.js`、`tests/conversation-replay-runtime-plugin.spec.mjs` 和 `docs/conversation-edit-retry.md`。

## 2026-08-25 - Task: 将对话编辑、重试和长文本折叠迁移到桌面壳注入
### What was done
- 将用户消息编辑、重试、图片重传、会话分支和长文本折叠逻辑迁入桌面壳源码，由 preload 在页面脚本执行前安装主世界 ModuleLoader 劫持。
- 只包装 DSH 对话模块的工厂和 apply，先保留上游对话初始化，再使用同一个真实上下文覆盖用户消息渲染；同时兼容 DSH 在 ModuleLoader 赋值后继续替换 load，以及皮肤适配器临时接管 load 的流程。
- 从 Desktop Profile、Runtime 构建依赖闭包和插件目录中移除 conversation-replay，使功能随桌面壳 preload.cjs 发布，不再依赖 Runtime 压缩包。
- 将原 Runtime 插件测试迁移为桌面壳注入测试，并更新集成与发布文档。
### Testing
- `pnpm exec vitest run tests/conversation-replay-shell-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、7 个测试；覆盖 ModuleLoader 后置 load 重写、临时接管恢复、原 apply 保留、重复注入、样式释放、500/501 字符边界、图片重传、fork 和首轮新建会话。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，36 个测试文件、268 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；生成的 `lib/preload.cjs` 包含独立可序列化的主世界注入函数，同样存在上述 Node.js engine 警告。
- 真实桌面壳烟测：使用 DSH 0.1.1-rc.2 和仓库内已移除 conversation-replay 的 `runtime/desktop.patch.yml` 启动独立 Web 服务，再由 Electron 加载当前构建的 `lib/preload.cjs`；页面检测到 hookVersion 1、4 条用户消息行，每条均有复制、重试和编辑入口；进入编辑后载入 272 字符原文，取消后恢复普通消息状态；Electron 退出码 0。未触发确认或重试，避免对现有会话发起模型请求；重新发送行为由自动化测试覆盖。
- `git diff --check`：通过。
### Notes
- `src/conversation-replay-injector.ts`：新增桌面壳主世界 ModuleLoader 代理、对话模块 apply 包装及完整用户消息交互实现。
- `src/preload.ts`：在其余 preload API 暴露前同步安装对话功能主世界注入。
- `runtime/desktop.patch.yml`：移除 conversation-replay 的 Desktop Profile 插入项。
- `scripts/build-runtime.ps1`：移除 conversation-replay 插件复制、本地依赖和 DSH 依赖闭包注册。
- `runtime/conversation-replay-plugin/client.js`：删除原 Runtime 客户端插件实现。
- `runtime/conversation-replay-plugin/index.js`：删除原 Runtime 服务端空入口。
- `runtime/conversation-replay-plugin/package.json`：删除原 Runtime 插件声明。
- `tests/conversation-replay-runtime-plugin.spec.mjs`：删除旧 Runtime 插件测试入口。
- `tests/conversation-replay-shell-injector.spec.ts`：新增桌面壳劫持、功能行为和 Runtime 解耦回归测试。
- `docs/conversation-edit-retry.md`：改写为桌面壳注入架构、打包落点和验证命令。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`5fbe414b491a1845601afac4fc4fe00963bf37eb`。执行 `git restore --source=5fbe414b491a1845601afac4fc4fe00963bf37eb -- docs/conversation-edit-retry.md runtime/conversation-replay-plugin runtime/desktop.patch.yml scripts/build-runtime.ps1 src/preload.ts tests/conversation-replay-runtime-plugin.spec.mjs progress.md`，再执行 `Remove-Item -LiteralPath 'src\conversation-replay-injector.ts','tests\conversation-replay-shell-injector.spec.ts' -Force`。

## 2026-08-25 - Task: 屏蔽已发布旧 Runtime 中的对话插件
### What was done
- 桌面壳在 ModuleLoader 注册阶段识别旧的 `@deepseek-ai/dsh-desktop-conversation-replay` 客户端模块，并将其工厂替换为空插件，避免用户本机保留旧 Runtime 产物时与壳侧实现重复注册。
- 保留壳侧对真实 DSH conversation 模块的 apply 劫持，旧 Runtime 是否携带该插件不再影响桌面壳功能入口。
- 补充旧模块屏蔽计数作为壳侧诊断状态，并更新回归测试与集成文档。
### Testing
- `pnpm exec vitest run tests/conversation-replay-shell-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、7 个测试；新增断言确认旧插件原工厂不执行，替换后的插件 apply 为空实现。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，36 个测试文件、268 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；生成的 `lib/preload.cjs` 已包含旧插件屏蔽逻辑。
- 旧 Runtime 共存烟测：使用本机 DSH 0.1.1-rc.2 原有 `desktop.patch.yml` 启动服务，该 Patch 仍声明旧 conversation-replay 插件；桌面壳检测到 `legacySuppressions: 1`，旧插件被替换为空实现。随后在有效历史会话中检测到 2 条壳侧用户消息行、复制/重试/编辑入口；1096 字符消息默认折叠，展开后正文长度为 1096，再次点击可收起；编辑框载入完整 1096 字符，取消后恢复；Electron 退出码 0。
- `git diff --check`：通过。
### Notes
- `src/conversation-replay-injector.ts`：增加旧 Runtime conversation-replay 模块识别、空插件替换和屏蔽计数。
- `tests/conversation-replay-shell-injector.spec.ts`：增加旧插件工厂不执行及空 apply 回归断言。
- `docs/conversation-edit-retry.md`：补充旧 Runtime 产物共存时的壳侧屏蔽行为。
- `progress.md`：追加本轮兼容处理与真实共存烟测记录。
- 回滚点：`5fbe414b491a1845601afac4fc4fe00963bf37eb`。如需回滚整个桌面壳迁移，执行上一轮 Notes 中的完整回滚命令。


## 2026-08-25 - Task: 限定长文本粘贴折叠仅对聊天输入框生效
### What was done
- 修复桌面壳粘贴注入对页面内第一个可见多行输入框的全局误判，改为根据粘贴事件的实际目标识别聊天输入框。
- 仅当输入目标同时位于聊天输入卡片和聊天输入滚动区时，才接管超过 500 个字符的文本或文本文件并生成折叠附件；设置菜单、插件配置及其他多行文本框保持默认粘贴行为。
- 文本、文件和提交展开流程显式复用本次聊天输入框，避免页面同时存在多个编辑器时把内容写入错误区域；同步限制待发送折叠内容的提交拦截范围。
- 补充非聊天多行文本框不触发 preventDefault/stopImmediatePropagation 的行为回归测试，并更新功能作用范围文档。
### Testing
- `npm exec vitest run tests/file-context-ui-contract.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、5 个测试；包含非聊天 textarea 粘贴事件不被拦截的行为验证及聊天输入框选择器契约检查。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，36 个测试文件、270 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；生成的 `lib/preload.cjs` 已包含聊天输入框范围判断，同样存在上述 Node.js engine 警告。
- `git diff --check`：通过。
- 本轮未启动真实桌面壳进行设置插件页面手工粘贴烟测；行为边界由注入脚本执行测试覆盖。
### Notes
- `src/file-context-injector.ts`：将长文本和文本文件粘贴处理限定到实际触发事件的聊天输入框，并限制提交展开范围。
- `tests/file-context-ui-contract.spec.ts`：增加聊天输入框范围契约及非聊天 textarea 默认粘贴行为回归测试。
- `docs/conversation-edit-retry.md`：补充粘贴折叠仅作用于聊天输入框的使用说明。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`f047c739448cb0dbf2086ff6c8a55640d5163089`。执行 `git restore --source=f047c739448cb0dbf2086ff6c8a55640d5163089 -- src/file-context-injector.ts tests/file-context-ui-contract.spec.ts docs/conversation-edit-retry.md progress.md` 可回滚本轮改动。
- 补充更正：上述专项测试实际执行命令为 `pnpm exec vitest run tests/file-context-ui-contract.spec.ts --maxWorkers=1 --testTimeout=20000`。
- 补充更正：文件上下文注入脚本的构建产物落点为 `lib/main.js`，已确认其中包含 `CHAT_EDITOR_SELECTOR`；上文 `lib/preload.cjs` 表述有误。


## 2026-08-25 - Task: 合并 Codex 代码研发与工作执行提示词
### What was done
- 读取用户提供的提示词全文，并以其语言、逆向分析、质量、协作、目标执行、Notion 项目管理和汇报格式作为基稿。
- 从 `D:\work\ai\codex` 中筛选 Codex 基础工作提示、GPT-5.2 任务执行规范、编排协作规范和代码审查规则，提炼仓库指令、持续执行、计划、精准改动、工具使用、验证、调试、Git、文档和审查相关内容。
- 排除沙箱、审批、权限申请、敏感信息边界及其他非实际研发执行内容，对重复规则进行合并，并保留用户原提示中的工作能力部分。
- 在项目根目录生成可直接使用的完整提示词文件。
### Testing
- 提示词结构校验：通过，生成文件共 242 行、25 个 Markdown 标题，要求的研发执行、验证、调试、Git、审查、逆向和项目管理章节均存在。
- 限制内容关键词校验：通过，未保留 Codex 的沙箱与审批模式说明、调用升级申请说明，以及基稿中的敏感信息和访问边界条目。
- UTF-8 内容校验：通过，文件不存在 NUL 字节。
- `git diff --check`：通过。
### Notes
- `codex-work-prompt.md`：新增融合后的完整代码研发与工作执行提示词。
- `progress.md`：追加本轮提示词提取、合并、校验和回滚记录。
- 只读来源：`C:\Users\karma617\.codex\attachments\6135296f-8bb8-4e78-910a-2183c00edc03\pasted-text.txt`、`D:\work\ai\codex\codex-rs\protocol\src\prompts\base_instructions\default.md`、`D:\work\ai\codex\codex-rs\core\gpt_5_2_prompt.md`、`D:\work\ai\codex\codex-rs\core\templates\agents\orchestrator.md` 和 `D:\work\ai\codex\codex-rs\prompts\templates\review\rubric.md`。
- 回滚方式：执行 `Remove-Item -LiteralPath 'D:\work\ai\deepseek-harness-desktop\codex-work-prompt.md' -Force` 删除本轮正式交付文件；`progress.md` 按追加式历史记录保留。


## 2026-08-26 - Task: 修复主题安装客户端入口解析
### What was done
- 修复主题安装入口解析器与错误提示不一致的问题：补充 `lib/plugin/dist/client.js`、`plugin/dist/client.js` 等历史包布局的候选路径。
- 扩展 `exports["./client"]` 条件导出解析，支持回退数组并补充 `node` 条件，避免合法清单因导出形态不同而误报“未找到可注入的客户端入口”。
- 增加临时主题包目录回归测试，覆盖嵌套 legacy plugin bundle 和数组/条件导出两种入口。
- 增加主题市场入口解析文档，记录候选路径和验证命令。
### Testing
- `pnpm exec vitest run tests/shell-skin-store.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、2 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，37 个测试文件、272 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；桌面壳构建产物已包含新的客户端入口候选解析逻辑，同样存在上述 Node.js engine 警告。
- `git diff --check`：通过。
- 本轮未执行真实在线主题下载和桌面壳 UI 手工安装烟测；入口解析行为已用临时目录回归测试覆盖。
### Notes
- `src/shell-skin-store.ts`：补充 nested plugin/dist 客户端入口和条件导出数组解析。
- `tests/shell-skin-store.spec.ts`：新增主题客户端入口解析回归测试。
- `docs/shell-skin-marketplace.md`：记录主题包入口解析规则和验证命令。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`2ae19a20339e2ccdf9bbf1706718d29e3d76b985`。执行 `git restore --source=2ae19a20339e2ccdf9bbf1706718d29e3d76b985 -- src/shell-skin-store.ts`，并删除 `tests/shell-skin-store.spec.ts` 与 `docs/shell-skin-marketplace.md` 可回滚本轮代码、测试和文档改动；`progress.md` 按追加式历史记录保留。

## 2026-08-26 - Task: 修复对话重试与编辑按钮偶发失效
### What was done
- 修复桌面壳对 `ModuleLoader` 的临时接管恢复逻辑，主题适配器恢复原加载器时复用同一个代理，避免多次进入主题流程后代理层叠导致后续模块注册路径不稳定。
- 增加加载器访问器自修复：页面脚本重新定义 `window.__ModuleLoader__` 后，在微任务、`DOMContentLoaded` 和 `pageshow` 时恢复桌面壳接管；重复安装调用也会先校正访问器，不再只依据已存在的 hook 标记直接返回。
- 增加回归测试，覆盖临时接管/恢复后的代理身份、访问器被替换后的自动恢复以及对话模块工厂仍被正确包装。
### Testing
- `pnpm exec vitest run tests/conversation-replay-shell-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、8 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，5 个测试文件、22 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；构建产物包含更新后的 ModuleLoader 自修复逻辑，同样存在上述 Node.js engine 警告。
- `git diff --check`：通过。
- 本轮未对真实会话执行确认/重试请求；功能行为继续由现有会话分支测试覆盖，当前改动重点由 ModuleLoader 时序回归测试覆盖。
### Notes
- `src/conversation-replay-injector.ts`：复用代理并增加 ModuleLoader 访问器自修复与页面生命周期兜底。
- `tests/conversation-replay-shell-injector.spec.ts`：增加代理恢复和访问器替换回归测试。
- `docs/conversation-edit-retry.md`：补充注入稳定性和主题适配器恢复说明。
- `progress.md`：追加本轮修复、验证和回滚记录。
- 回滚点：`7d03fa1e4262ec470b5d6dc2278c45d2365830e4`。执行 `git restore --source=7d03fa1e4262ec470b5d6dc2278c45d2365830e4 -- src/conversation-replay-injector.ts tests/conversation-replay-shell-injector.spec.ts docs/conversation-edit-retry.md progress.md` 可回滚本轮修改；`progress.md` 按追加式历史记录保留。

## 2026-08-28 - Task: 通过桌面壳注入开放自定义提供方图片输入
### What was done
- 复用桌面壳启动 DSH 子进程时已有的 `--import lib/shutdown-hook.js` 预加载入口，在 Node 模块首次加载阶段定点劫持 `llm-pi-ai` 适配器。
- 将模型和提供方都未声明输入类型时的默认能力从纯文本扩展为 `text + image`，同时保留模型级 `input`、提供方级 `defaultInput` 和内置模型目录声明的优先级。
- 图片继续走 DSH 既有的附件校验、持久化和请求转换链路；本轮未修改 Runtime、已安装 DSH 包或用户 `%USERPROFILE%\.dsh\settings.yaml`。
- 补充定点源码转换、模块范围和显式输入声明优先级回归测试，并增加使用及升级兼容说明。
### Testing
- `pnpm exec vitest run tests/custom-provider-image-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、2 个测试；覆盖默认图片能力、显式模型/提供方/目录输入声明优先级、幂等转换及仅处理 `llm-pi-ai` 入口。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，6 个测试文件、24 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；生成的 `lib/shutdown-hook.js` 包含 Node `registerHooks` 及 `llm-pi-ai` 默认输入转换，同样存在上述 Node.js engine 警告。
- Runtime Node 24.19.0 真实模块加载：通过当前 `lib/shutdown-hook.js` 预加载后成功导入 DSH 0.1.1-rc.2 的真实 `@deepseek-ai/dsh-llm-pi-ai` 入口。
- 独立请求体烟测：使用隔离 `DSH_HOME`、DSH 0.1.1-rc.2、未声明输入类型的 Mock 自定义提供方及 PNG 图片完成发送；页面未出现模型图片能力提示，Mock `/v1/chat/completions` 收到 1 个 `image_url` PNG data URL；页面错误和控制台错误均为 0。
- 当前工作区 Electron 桌面壳烟测：通过隔离用户数据目录和同一 Mock 提供方完成图片发送；DSH 子进程命令行确认预加载当前工作区 `lib/shutdown-hook.js`，接口收到 1 个 `image_url` PNG data URL，页面错误为 0。烟测同时观察到 2 条 `conversation.chat.node` 的 React #130 控制台错误，未阻断图片预览、发送和回复；该渲染错误不在本任务改动范围内。
- `git diff --check`：通过。
### Notes
- `src/custom-provider-image-injector.ts`：新增 Node 同步模块加载钩子，只转换 `llm-pi-ai` 的未声明输入默认值。
- `src/shutdown-hook.ts`：在原 DSH 关机 IPC 预加载脚本中安装自定义提供方图片能力钩子。
- `tests/custom-provider-image-injector.spec.ts`：增加转换范围、输入声明优先级和幂等性测试。
- `docs/custom-provider-image-input.md`：记录业务行为、配置覆盖方式、注入落点、发布要求和 DSH 升级兼容风险。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`c49e73e4e85263cf0a7693aae1b32d5b2c8bf628`。执行 `git restore --source=c49e73e4e85263cf0a7693aae1b32d5b2c8bf628 -- src/shutdown-hook.ts`，再执行 `Remove-Item -LiteralPath 'src\custom-provider-image-injector.ts','tests\custom-provider-image-injector.spec.ts','docs\custom-provider-image-input.md' -Force` 可回滚代码、测试和文档；`progress.md` 按追加式历史记录保留，通过后续追加更正记录处理。

## 2026-08-28 - Task: 修复对话重试、编辑与长文本折叠注入的时序不稳定
### What was done
- 补强桌面壳对 DSH `ModuleLoader` 的启动接管：除目标对话模块外，同时捕获 `dsh-client-modules` 创建出的真实模块系统和根 `Context`。
- 在对话模块已进入 live/materialized、但目标工厂包装未命中的时序下，使用模块系统的导入能力补齐 React/UI 依赖，并在同一根上下文补注册用户消息渲染覆盖；保留已有代理复用、访问器自修复和旧 Runtime 插件抑制逻辑。
- 增加页面启动阶段的短时访问器轮询与 `load` 生命周期兜底，缩小页面脚本或主题适配器临时改写加载器造成的竞态窗口。
- 增加 live 模块系统上下文恢复回归测试，并更新对话编辑/重试注入文档。
### Testing
- `pnpm exec vitest run tests/conversation-replay-shell-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、10 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，6 个测试文件、26 个测试。
- `pnpm run typecheck`：通过；当前 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；`lib/preload.cjs` 已包含新的模块系统捕获、上下文恢复和加载器轮询逻辑，同样存在上述 Node.js engine 警告。
- `node scripts/smoke-runtime.mjs "C:\Users\karma617\AppData\Local\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2" "C:\Users\karma617\AppData\Local\DeepSeek Harness\runtime-manager\runtimes\0.1.1-rc.2\runtime-manifest.json"`：通过，DSH 0.1.1-rc.2 Runtime HTTP/Host API/关闭流程正常。
- `git diff --check`：通过。
- 未执行真实 Electron 会话中的连续刷新、SPA 切换及实际重试/编辑按钮点击烟测；本轮验证集中在注入时序回归、完整自动化测试、构建和 Runtime smoke。
### Notes
- `src/conversation-replay-injector.ts`：新增 bootstrap 模块系统/根上下文捕获、延迟依赖恢复和短时 ModuleLoader 轮询。
- `tests/conversation-replay-shell-injector.spec.ts`：新增 live 模块系统上下文恢复回归测试。
- `docs/conversation-edit-retry.md`：补充 live/materialized 状态下的上下文恢复说明。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚方式：当前工作树未提交；如需整体回滚当前三文件的未提交改动，执行 `git restore --source=HEAD -- src/conversation-replay-injector.ts tests/conversation-replay-shell-injector.spec.ts docs/conversation-edit-retry.md`（会同时回退此前这些文件上的未提交会话功能改动）；`progress.md` 按追加式历史记录保留。

## 2026-08-29 - Task: 修复 Windows 构建脚本误用 Node.js 22
### What was done
- 调整 `build-windows.bat` 的 Node.js 选择顺序：优先复用 `DSH_DESKTOP_RUNTIME_ROOT` 或本机已安装 DSH Runtime 内置的 Node.js 24 x64，其次查找 nvm 的 v24，最后才使用 PATH 中的 Node.js。
- 对最终选中的 Node.js 继续执行主版本和 x64 架构校验，并将其目录前置到 PATH，确保 pnpm、测试、构建和 electron-builder 全程使用同一个 Node.js 24。
- 改进不兼容环境提示，并在开发说明中记录构建脚本的自动查找规则。
### Testing
- Node.js 22 隔离路径校验：通过；在隐藏 DSH Runtime 和 nvm、PATH 仅保留 Node.js 22.22.0 时，脚本明确报告实际版本并以错误码 1 结束，没有继续执行测试或打包。
- `build-windows.bat --no-pause` 真实全流程：通过；当前 PATH 为 Node.js 22.22.0，脚本自动选中 DSH Runtime 内置 Node.js 24.19.0 x64，完成依赖安装、6 个测试文件/26 个测试、TypeScript/tsdown 构建和 electron-builder 打包。
- 安装包产物校验：通过；生成 `dist/DeepSeek-Harness-Shell-0.1.15-x64.exe`（102204374 字节）和 `dist/DeepSeek-Harness-Shell-Portable-0.1.15-x64.exe`（101975074 字节）。
- `git diff --check`：通过。
### Notes
- `build-windows.bat`：自动发现并固定使用 Node.js 24 x64，同时保持 Windows BAT 的 CRLF 行尾。
- `README.md`：补充 Node.js 24 自动查找与手动安装条件。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚方式：执行 `git restore --source=HEAD -- build-windows.bat README.md` 可回滚本轮脚本和文档改动；`progress.md` 按追加式历史记录保留。

## 2026-08-28 - Task: 持久化 Windows 构建脚本 CRLF 行尾修正
### What was done
- 在 `.gitattributes` 中声明 `*.bat text eol=crlf`，让 `build-windows.bat` 在 Git checkout、切换分支和后续编辑后继续保持 Windows CMD 所需的 CRLF 行尾，避免 `goto` 解析异常导致错误分支误报。
- 保持当前构建脚本内容不变，仅补上行尾持久化规则，并复核脚本仍为纯 CRLF。
### Testing
- `build-windows.bat --no-pause` 真实全流程：通过；自动选中 DSH Runtime 内置 Node.js 24.19.0 x64，6 个测试文件/26 个测试通过，TypeScript/tsdown 与 electron-builder 通过。
- Node.js 22 隔离路径校验：通过；仅保留 PATH 中 Node.js 22.22.0 时，脚本明确报告版本不兼容并以错误码 1 结束，未继续执行测试或打包。
- 行尾校验：通过；`build-windows.bat` 为纯 CRLF，`.gitattributes` 已包含 `*.bat text eol=crlf`。
- `git diff --check`：通过（Git 仅提示现有 `progress.md` 的 CRLF 将按仓库规则规范化为 LF）。
### Notes
- `.gitattributes`：新增 BAT 文件 CRLF 持久化规则。
- `progress.md`：追加本轮行尾修正、构建验证和回滚记录。
- 回滚方式：执行 `git restore --source=HEAD -- .gitattributes` 可撤销本轮行尾规则；`progress.md` 按追加式历史记录保留。
## 2026-08-29 - Task: 调整主题皮肤市场列表排序
### What was done
- 为皮肤安装记录持久化成功安装时间；已有安装记录首次加载时使用皮肤目录修改时间补齐历史安装时间。
- 皮肤市场列表现在优先展示当前正在使用的皮肤，其余已安装皮肤按安装时间从新到旧排列，所有未安装皮肤继续保持市场目录原有顺序并排在后面。
### Testing
- `git diff --check -- src/shell-skin-store.ts`：通过。
- 静态差异检查确认安装时间写入、当前皮肤置顶和已安装皮肤倒序逻辑均已落在目标代码中。
- 按用户要求未执行测试、构建或打包，未终止任何当前运行中的进程；实际弹窗效果留待用户手动打包验证。
### Notes
- `src/shell-skin-store.ts`：记录/迁移皮肤安装时间，并在市场列表输出前执行分组排序。
- `progress.md`：追加本轮改动、静态检查和回滚记录。
- 回滚方式：执行 `git restore --source=HEAD -- src/shell-skin-store.ts` 可回滚本轮代码改动；`progress.md` 按追加式历史记录保留。

## 2026-08-31 - Task: 修复源码型主题缺少客户端构建产物时的安装失败
### What was done
- 修复主题固定 commit 只包含源码、未提交 `lib/client.js` 等构建产物时的一键安装：入口解析失败后读取同名同版本的 npm 已构建包。
- npm 回退严格校验 package、version、gitHead、官方 registry 下载地址和 SHA-512，确认与市场锁定 commit 一致后才解包使用；安装过程不执行主题生命周期脚本。
- 增加回归测试，覆盖 npm 构建包成功回退和 commit 不一致拒绝两种路径，并用 `dsh-theme-machine@0.1.3` 的固定 commit 做在线解析验证。
- 补充主题市场安装文档和 tar 解包运行依赖。
### Testing
- `pnpm exec vitest run tests/shell-skin-store.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、4 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，12 个测试文件、65 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；桌面壳构建产物已包含 npm 构建包回退逻辑，同样存在上述 Node.js engine 警告。
- 在线固定版本验证：通过；`yuqisun/dsh-theme-machine` commit `e7e7762e16ff6469fe9153e5d75bac1b37b0ef13` 成功解析同 commit 的 `dsh-theme-machine@0.1.3`，入口为 `./lib/client.js`，bundle 通过 ModuleLoader 注入校验。
- `git diff --check`：通过。
- 未执行打包后 Electron UI 的手工安装与启用烟测。
### Notes
- `src/shell-skin-store.ts`：增加同 commit npm 已构建包下载、完整性校验、受限解包和入口回退。
- `tests/shell-skin-store.spec.ts`：增加构建包回退成功及 commit 不一致拒绝的回归测试。
- `docs/shell-skin-marketplace.md`：记录源码缺少构建产物时的 npm 回退规则和校验边界。
- `package.json`：增加 tar 解包运行依赖。
- `pnpm-lock.yaml`：锁定 tar 依赖解析。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`70bb46c7758432373c29855466a3515fe2e36618`。执行 `git restore --source=70bb46c7758432373c29855466a3515fe2e36618 -- src/shell-skin-store.ts tests/shell-skin-store.spec.ts docs/shell-skin-marketplace.md package.json pnpm-lock.yaml` 可回滚本轮代码、测试、文档和依赖改动；`progress.md` 按追加式历史记录保留。

## 2026-08-31 - Task: 修复主题清单带 UTF-8 BOM 时的安装失败
### What was done
- 修复主题 `package.json` 以 UTF-8 BOM 开头时 `JSON.parse` 抛出语法错误的问题，客户端清单读取现在只移除文件开头的 `U+FEFF` 后再解析。
- 将源码仓库清单和 npm 构建包清单统一走同一读取入口，避免两条安装路径表现不一致。
- 增加 BOM 清单回归测试，并用 `nlqh7/dsh-beautify` 的市场固定 commit 做在线解析验证。
- 补充主题市场清单编码兼容说明。
### Testing
- `pnpm exec vitest run tests/shell-skin-store.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、5 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，12 个测试文件、66 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；构建产物已包含 BOM 清单兼容逻辑，同样存在上述 Node.js engine 警告。
- 在线固定版本验证：通过；`nlqh7/dsh-beautify` commit `e44bcc71f06c9fe54e8b4d4f26ecaa1e05c43d5e` 的 `package.json` 前三字节为 `EF BB BF`，成功解析 `./lib/client.js`，bundle 通过 ModuleLoader 注入校验。
- `git diff --check`：通过。
- 未执行打包后 Electron UI 的手工安装与启用烟测。
### Notes
- `src/shell-skin-store.ts`：统一读取并兼容带 UTF-8 BOM 的主题客户端清单。
- `tests/shell-skin-store.spec.ts`：增加 BOM 清单解析回归测试。
- `docs/shell-skin-marketplace.md`：补充主题清单 BOM 兼容规则。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚方式：执行 `git restore -p -- src/shell-skin-store.ts tests/shell-skin-store.spec.ts docs/shell-skin-marketplace.md`，仅选择本轮包含 `readClientManifest`、`UTF-8 BOM` 测试和 BOM 文档段落的三个补丁块；`progress.md` 按追加式历史记录保留。

## 2026-08-31 - Task: 修复主题激活缺少 locale.bind 兼容接口
### What was done
- 修复客户端适配上下文只有 `locale.register`、缺少 `locale.bind` 导致主题激活失败的问题。
- 增加命名空间字典注册、稳定翻译函数、`zh-CN -> zh -> en` 语言回退、占位参数替换和停用时字典恢复。
- 将多语言兼容实现嵌入实际客户端激活脚本，并增加独立回归测试。
- 补充主题市场客户端多语言兼容文档。
### Testing
- `pnpm exec vitest run tests/skin-market-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、2 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，13 个测试文件、68 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；`lib/main.js` 已包含 `createSkinLocaleAdapter` 及激活脚本嵌入逻辑，同样存在上述 Node.js engine 警告。
- 真实 Electron 激活烟测：通过；使用 `caisiyang123/dsh-theme-dodger-17` commit `07e35f228bc9ba0db7f964c2bfed3536781d2fae` 的原始 `client.js` 执行适配器，返回 `ok: true`，注册 `dodger-17-day`、`dodger-17-night` 两套主题并选中 `dodger-17-day`。
- `git diff --check`：通过。
### Notes
- `src/skin-market-injector.ts`：增加客户端 `locale.bind`、字典注册、翻译回退和销毁兼容实现。
- `tests/skin-market-injector.spec.ts`：增加命名空间翻译与激活脚本嵌入回归测试。
- `docs/shell-skin-marketplace.md`：补充客户端多语言兼容规则。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚方式：执行 `git restore -p -- src/skin-market-injector.ts docs/shell-skin-marketplace.md`，仅选择本轮包含 `createSkinLocaleAdapter` 和“客户端多语言兼容”的补丁块，再执行 `Remove-Item -LiteralPath 'tests/skin-market-injector.spec.ts' -Force`；`progress.md` 按追加式历史记录保留。

## 2026-09-01 - Task: 为自定义提供方增加 User-Agent 请求头复写
### What was done
- 在桌面壳的“设置 -> 模型 -> 添加自定义提供方”及已有自定义提供方编辑区增加 `User-Agent` 输入项，创建或保存时通过原配置通道写入 `llm-pi-ai.providers.<Provider ID>.headers.User-Agent`。
- 编辑时按请求头名称大小写无关的规则回读和替换已有 User-Agent；清空后移除该复写项，同时保留其他自定义请求头。
- 复用现有 `ModuleLoader` 接管点注入设置界面，并通过 Node 模块加载钩子只转换 DSH 的 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js`；模型请求组装时在默认归因头之后应用自定义 User-Agent，未配置时继续使用 DSH 默认值。
- 补充设置模块转换、请求头覆盖和共享 Loader 注册测试，并增加功能与 DSH Runtime 升级兼容说明。
### Testing
- `pnpm exec vitest run tests/custom-provider-user-agent-injector.spec.ts tests/custom-provider-image-injector.spec.ts tests/conversation-replay-shell-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，3 个测试文件、15 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，14 个测试文件、71 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；`lib/preload.cjs` 包含设置模块 UI 转换及共享 Loader 注册，`lib/shutdown-hook.js` 包含模型请求 User-Agent 覆盖逻辑，同样存在上述 Node.js engine 警告。
- DSH `0.1.1-rc.2` 上游源码静态转换：通过；设置模块创建/编辑字段及请求模块覆盖点均成功命中并重建。
- 真实 Electron/DSH 隔离烟测：通过；创建 `ua-smoke` 后配置写入 `headers.User-Agent: DSH-UA-Smoke/1.0`，编辑页成功回读该值，本地 OpenAI-compatible Mock 网关收到 `user-agent: DSH-UA-Smoke/1.0`。
- 清空复写并再次请求：通过；配置中的 User-Agent 已移除，Mock 网关收到 DSH 默认 `user-agent: deepseek-harness/0.1.1-rc.2 (+https://github.com/deepseek-ai/deepseek-harness)`。
- 隔离 Electron、DSH Backend、Mock 服务及烟测临时目录/脚本均已停止并清理；未触碰用户正常运行的已安装应用进程与 `C:\Users\karma617\.dsh`。
- `git diff --check`：通过。
### Notes
- `src/conversation-replay-injector.ts`：为现有共享 `ModuleLoader` 接管点增加按模块 ID 注册工厂转换的入口。
- `src/custom-provider-user-agent-injector.ts`：新增设置模块工厂转换，注入自定义提供方 User-Agent 创建、编辑、回读和清空逻辑。
- `src/custom-provider-image-injector.ts`：在既有精准 Node 模块转换中增加模型请求 User-Agent 覆盖逻辑。
- `src/preload.ts`：在页面主世界注册自定义提供方 User-Agent 设置注入。
- `tests/custom-provider-user-agent-injector.spec.ts`：新增设置模块转换、上游不兼容回退及共享 Loader 注册测试。
- `tests/custom-provider-image-injector.spec.ts`：新增自定义 User-Agent 覆盖、大小写重复取最后值和默认归因头保留测试。
- `docs/custom-provider-user-agent.md`：记录业务行为、注入落点、验证入口和 Runtime 升级兼容风险。
- `progress.md`：追加本轮施工、验证、清理和回滚记录。
- 回滚点：`97527008f75de6cb0ab64d129eaa64fd850219cc`。执行 `git restore --source=97527008f75de6cb0ab64d129eaa64fd850219cc -- src/conversation-replay-injector.ts src/custom-provider-image-injector.ts src/preload.ts tests/custom-provider-image-injector.spec.ts`，再执行 `Remove-Item -LiteralPath 'src\custom-provider-user-agent-injector.ts','tests\custom-provider-user-agent-injector.spec.ts','docs\custom-provider-user-agent.md' -Force` 可回滚代码、测试和文档；`progress.md` 按追加式历史记录保留，通过后续追加更正记录处理。

## 2026-09-02 - Task: 修复主题激活缺少 sessions.list 兼容服务
### What was done
- 修复客户端适配上下文缺少 `ctx.sessions`，导致依赖 `ctx.sessions.list` 的主题在激活阶段直接报错的问题。
- 增加可订阅的会话列表快照、当前会话更新和安全的 `sessions.binding(id).session` 空闲回退；未取得会话运行细节时不阻断主题主体与视觉组件激活。
- 接入桌面运行时已有的当前会话消息，并对消息来源、类型和会话 ID 格式进行校验；停用主题时解除监听。
- 增加会话适配器及激活脚本嵌入回归测试，并补充主题市场兼容文档。
### Testing
- `pnpm exec vitest run tests/skin-market-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、4 个测试。
- `pnpm exec vitest run --maxWorkers=1 --testTimeout=20000`：通过，14 个测试文件、73 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；`lib/main.js` 已包含 `createSkinSessionsAdapter`、`sessions` 上下文注入和 `context.get('sessions')` 回退，同样存在上述 Node.js engine 警告。
- 真实 Electron 激活烟测：通过；校验并解包 `@zsy1126/dsh-rick-and-morty@0.1.0` 的市场 SHA-512 固定产物，使用原始 `lib/client.js` 执行适配器返回 `ok: true`，注入 3 个样式节点并应用 76 个主题 token，未再出现读取 `sessions.list` 的异常。
- `git diff --check -- src/skin-market-injector.ts tests/skin-market-injector.spec.ts docs/shell-skin-marketplace.md`：通过。
### Notes
- `src/skin-market-injector.ts`：增加主题客户端会话服务适配、当前会话消息同步和销毁清理。
- `tests/skin-market-injector.spec.ts`：增加会话列表、binding 回退及激活脚本嵌入测试。
- `docs/shell-skin-marketplace.md`：记录客户端会话兼容范围及空闲回退行为。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚方式：执行 `git restore --source=HEAD -- src/skin-market-injector.ts tests/skin-market-injector.spec.ts docs/shell-skin-marketplace.md` 可回滚本轮代码、测试和文档改动；`progress.md` 按追加式历史记录保留。

## 2026-09-07 - Task: 修复 DSH 核心升级后的对话编辑与重试注入兼容性
### What was done
- 修复新版 Cordis 严格服务访问校验下直接使用根上下文读取 `slots` 的注入失败，改由依赖注入子上下文取得对话功能所需服务。
- 将附件展示模块调整为可选依赖，并兼容模块默认导出；上游 UI 组件删除、改名或返回无效值时使用最小内置组件，避免向 React 传入无效组件类型。
- 对同一上下文只安排一次功能安装，避免加载器轮询和重复 apply 在失败时持续刷屏；目标对话模块优先复用已捕获的长期根上下文。
- 增加严格上下文、重复 apply、默认导出、可选附件模块缺失和无效 React 组件类型回归覆盖，并同步更新功能兼容说明。
### Testing
- `pnpm exec vitest run tests/conversation-replay-shell-injector.spec.ts tests/custom-provider-user-agent-injector.spec.ts tests/custom-provider-image-injector.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，3 个测试文件、16 个测试。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，20 个测试文件、113 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；更新后的兼容逻辑已进入 `lib/preload.cjs`，同样存在上述 Node.js engine 警告。
- `git diff --check`：通过。
- 已对本机 DSH `0.1.0-rc.8` 安装内容做静态核对：Cordis 会对未声明依赖的 `ctx.slots` 访问抛错，且新版附件客户端模块仅导出 `apply`/`inject`；本轮回归测试覆盖这两种变化。未启动真实 Electron 会话执行编辑或重试请求。
### Notes
- `src/conversation-replay-injector.ts`：增加服务依赖子上下文、可选模块与组件降级，并抑制同一上下文的重复安装。
- `tests/conversation-replay-shell-injector.spec.ts`：增加新版严格上下文及 UI 导出变化的回归测试。
- `docs/conversation-edit-retry.md`：记录严格服务注入、附件渲染优先级和组件降级策略。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`0ef90de204cfce82303c7150b51c7f78ceddf3bb`。执行 `git restore --source=0ef90de204cfce82303c7150b51c7f78ceddf3bb -- src/conversation-replay-injector.ts tests/conversation-replay-shell-injector.spec.ts docs/conversation-edit-retry.md` 可回滚本轮代码、测试和文档；`progress.md` 按追加式历史记录保留，通过后续追加更正记录处理。

## 2026-09-07 - Task: 隔离桌面壳注入异常，保障 DSH 核心基础功能
### What was done
- 将 preload 中两个主世界注入入口分别置于独立故障边界内，同步抛错或异步拒绝只记录对应增强失败，后续桌面桥接继续注册。
- 调整共享 ModuleLoader 包装顺序，始终先执行 DSH 原始模块 `apply` 和模块系统创建逻辑，再执行壳侧增强，并保留原始返回值。
- 模块描述检查、队列预处理、导出改写和加载器接管异常时回退原始对象；通过共享 Loader 注册的转换工厂运行失败时重新执行 DSH 原始工厂。
- 增加边界故障诊断计数，补充启动隔离、序列化、自定义转换失败、不可改写导出和异常模块描述的回归覆盖，并同步更新兼容文档。
### Testing
- `pnpm exec vitest run tests/conversation-replay-shell-injector.spec.ts tests/custom-provider-user-agent-injector.spec.ts tests/custom-provider-image-injector.spec.ts tests/file-context-ui-contract.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，4 个测试文件、27 个测试。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，20 个测试文件、119 个测试。
- `pnpm run build`：通过；包含 `tsc --noEmit`，更新后的启动隔离和 ModuleLoader 回退逻辑已进入 `lib/preload.cjs`。当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `git diff --check`：通过。
- 故障注入测试已证明：壳增强抛错时 DSH 原始 `apply`、原始 `load/create`、原始不可改写导出及原始转换工厂仍正常返回。未启动真实 Electron 多窗口烟测。
### Notes
- `src/conversation-replay-injector.ts`：增加主世界调用保护、核心优先执行顺序、Loader/工厂回退和边界故障诊断。
- `src/preload.ts`：分别隔离对话重试与自定义 User-Agent 的主世界注入启动。
- `tests/conversation-replay-shell-injector.spec.ts`：增加各层故障注入与 DSH 原路径继续执行的回归测试。
- `tests/custom-provider-user-agent-injector.spec.ts`：适配共享 Loader 的故障回退包装验证。
- `docs/conversation-edit-retry.md`：新增共享注入故障隔离规则和诊断入口。
- `docs/custom-provider-user-agent.md`：记录转换工厂失败时回退 DSH 原始工厂。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`0ef90de204cfce82303c7150b51c7f78ceddf3bb`。执行 `git restore --source=0ef90de204cfce82303c7150b51c7f78ceddf3bb -- src/conversation-replay-injector.ts src/preload.ts tests/conversation-replay-shell-injector.spec.ts tests/custom-provider-user-agent-injector.spec.ts docs/conversation-edit-retry.md docs/custom-provider-user-agent.md` 可回滚本轮及紧邻的上一轮注入兼容改动；`progress.md` 按追加式历史记录保留，通过后续追加更正记录处理。

## 2026-09-07 - Task: 修复 DSH 新版 PTC 命名导致多模型预设无法创建会话
### What was done
- 修复新版 DSH 将工具呈现配置从 `code` 更名为 `ptc` 后，旧版多模型编排预设因 schema 校验失败而无法创建会话的问题。
- Runtime 启动前读取当前 DSH 自带的 `ptc` 或旧 `code` 预设，仅在确认当前 Runtime 使用 `ptc` 时迁移插件的主预设和旧 ID 兼容预设源。
- 迁移只替换 `tool-presentation.mode` 标量，保留 YAML 其他配置、注释和换行，并跳过 Profile 外部的 link 安装及用户已改成其他模式的预设源。
- 将预设兼容准备置于独立故障边界；迁移文件缺失、格式变化或写入失败时仍继续启动 DSH Runtime，避免第三方预设问题影响基础窗口和普通会话。
### Testing
- `pnpm exec vitest run tests/plugin-preset-compatibility.spec.ts tests/runtime-controller-overlay.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，2 个测试文件、9 个测试。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，21 个测试文件、123 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；兼容迁移及故障隔离逻辑已进入 `lib/main.js`，同样存在上述 Node.js engine 警告。
- `git diff --check`：通过。
- 未启动真实 Electron，并且本机现有 DSH Runtime 仍使用 `mode: code`，因此新版 `mode: ptc` 的真实会话创建仍需在用户更新后的 Runtime 环境手工烟测。
### Notes
- `src/plugin-preset-compatibility.ts`：新增基于当前 Runtime 自带预设的 `code -> ptc` 精准迁移，并保护外部 link 安装。
- `src/runtime-controller.ts`：在 Runtime 启动前调用预设兼容准备，并隔离其全部异常。
- `tests/plugin-preset-compatibility.spec.ts`：新增 PTC 迁移、格式保留、幂等、旧 Runtime 和自定义配置保护测试。
- `tests/runtime-controller-overlay.spec.ts`：新增预设迁移失败后 Runtime 仍继续启动的回归测试。
- `docs/plugin-preset-compatibility.md`：记录迁移触发条件、边界和验证入口。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`40d7258b6a4de14b78127feb0936a2641258ef3b`。执行 `git restore --source=40d7258b6a4de14b78127feb0936a2641258ef3b -- src/runtime-controller.ts tests/runtime-controller-overlay.spec.ts`，再执行 `Remove-Item -LiteralPath 'src\plugin-preset-compatibility.ts','tests\plugin-preset-compatibility.spec.ts','docs\plugin-preset-compatibility.md' -Force` 可回滚本轮代码、测试和文档；`progress.md` 按追加式历史记录保留。

## 2026-09-07 - Task: 补齐 DSH 0.1.3 预设包布局并完成当前环境迁移
### What was done
- 修正首次兼容实现只读取旧版 CLI 内置预设目录的问题，新增识别 DSH `0.1.3-alpha.1` 将预设迁移到 `@deepseek-ai/dsh-agent-presets/presets` 后的实际安装布局。
- 将插件模板写入改为同目录临时文件替换，先断开 pnpm Store 硬链接，避免迁移插件模板时修改共享包缓存。
- 增加新版嵌套预设包布局和 pnpm 硬链接回归覆盖。
- 在不终止当前运行进程的情况下，通过插件自身安装器迁移当前用户环境的主预设和旧 ID 兼容预设；四个模板/目标文件均已为 `mode: ptc`，两个管理 marker 的文件哈希均与实际内容一致，共享 pnpm Store 原始副本仍保持 `mode: code`。
### Testing
- `pnpm exec vitest run tests/plugin-preset-compatibility.spec.ts tests/runtime-controller-overlay.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，2 个测试文件、10 个测试。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，21 个测试文件、124 个测试。
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm run build`：通过；新版预设包布局识别和硬链接安全替换逻辑已进入 `lib/main.js`，同样存在上述 Node.js engine 警告。
- 当前环境静态验证：通过；`multi-model-orchestrator`、`orchestrator` 的插件模板和已安装预设均为 `mode: ptc`，marker 校验全部通过，pnpm Store 副本未改变。
- `git diff --check`：通过。
- 未通过 UI 实际提交新建会话请求；该项由当前运行窗口直接复验。
### Notes
- `src/plugin-preset-compatibility.ts`：补充新版 `dsh-agent-presets` 安装布局，并使用临时文件替换断开包缓存硬链接。
- `tests/plugin-preset-compatibility.spec.ts`：增加新版目录布局和共享 Store 不受迁移影响的测试。
- `docs/plugin-preset-compatibility.md`：补充新版预设包位置和硬链接保护规则。
- `progress.md`：追加首次实现漏判的原因、修正和当前环境迁移证据。
- 仓库回滚点：`40d7258b6a4de14b78127feb0936a2641258ef3b`。执行 `git restore --source=40d7258b6a4de14b78127feb0936a2641258ef3b -- src/runtime-controller.ts tests/runtime-controller-overlay.spec.ts`，再执行 `Remove-Item -LiteralPath 'src\plugin-preset-compatibility.ts','tests\plugin-preset-compatibility.spec.ts','docs\plugin-preset-compatibility.md' -Force` 可回滚代码、测试和文档；`progress.md` 保留追加历史。
- 当前用户预设回滚副本：`C:\Users\karma617\.dsh\.desktop-preset-compat-backup-1788756339664`；其中包含迁移前的两个插件模板以及 `multi-model-orchestrator`、`orchestrator` 两个完整受管预设目录。
## 2026-09-07 - Task: 修复多模型插件被旧客户端模块隔离后预设等待服务
### What was done
- 补齐多模型插件对 DSH `0.1.3-alpha.1` 的客户端清单迁移：仅在 Runtime 已移除 `@deepseek-ai/dsh-client-runtime` 时，从该插件的 `dsh.client.inject` 中删除旧模块，并通过同目录临时文件替换断开 pnpm Store 硬链接。
- 兼容准备完成后只解除 `dsh-multi-model-orchestrator` 因 `removed-client-runtime` 产生的隔离；手工隔离和导入故障隔离保持不变。兼容迁移或解除隔离异常仍由 Runtime 启动边界吞吐，不阻断基础功能。
- 当前用户环境重新安装 GitHub `v0.7.6` 固定版本，将主模板、旧 ID 模板和两个受管预设迁移为 `mode: ptc`，并清除该插件的旧客户端模块隔离记录；全过程未终止当前 DSH 或桌面壳进程。
### Testing
- `pnpm run typecheck`：通过；当前系统 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm exec vitest run tests/plugin-preset-compatibility.spec.ts tests/plugin-isolation.spec.ts tests/runtime-controller-overlay.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，3 个测试文件、17 个测试。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，21 个测试文件、126 个测试。
- `pnpm run build`：通过；客户端清单迁移、精准解除隔离和启动故障边界已进入 `lib/main.js`。
- 当前环境静态验证：通过；插件版本为 `0.7.6`，客户端清单不再含旧 Runtime，两个插件模板和两个已安装预设均为 `mode: ptc`，两个 marker 哈希匹配，隔离列表为空，共享 pnpm Store 模板仍为 `mode: code`。
- DSH `web --dump-config`：通过；退出码为 0，组合中包含 `dsh-multi-model-orchestrator` 和 `multi-model-orchestrator-settings`。
- 当前运行中的 Backend 在插件重新安装前已启动，其设置端点仍返回 404；本轮遵守不终止现有进程的边界，真实 Host 服务激活与新建多模型会话需在用户重启一次桌面壳后复验。
- `git diff --check`：通过。
### Notes
- `src/plugin-preset-compatibility.ts`：增加旧客户端预加载清单迁移，并保持 pnpm Store 原始内容不变。
- `src/plugin-isolation.ts`：增加只解除 `removed-client-runtime` 原因的隔离入口。
- `src/runtime-controller.ts`：在隔离 overlay 生成前解除已完成兼容迁移的插件隔离，且保持独立异常边界。
- `tests/plugin-preset-compatibility.spec.ts`：增加插件清单迁移和 package.json 硬链接保护覆盖。
- `tests/plugin-isolation.spec.ts`：增加精准解除隔离回归测试。
- `tests/runtime-controller-overlay.spec.ts`：增加迁移失败继续启动和解除隔离顺序测试。
- `docs/plugin-preset-compatibility.md`：记录旧客户端模块迁移、隔离释放规则和验证入口。
- `progress.md`：追加本轮施工、验证、当前环境迁移和回滚记录。
- 仓库回滚点：`40d7258b6a4de14b78127feb0936a2641258ef3b`。执行 `git restore --source=40d7258b6a4de14b78127feb0936a2641258ef3b -- src/plugin-isolation.ts src/runtime-controller.ts tests/plugin-isolation.spec.ts tests/runtime-controller-overlay.spec.ts`，再执行 `Remove-Item -LiteralPath 'src\plugin-preset-compatibility.ts','tests\plugin-preset-compatibility.spec.ts','docs\plugin-preset-compatibility.md' -Force` 可回滚本轮及关联的未提交兼容改动；`progress.md` 保留追加历史。
- 当前用户环境回滚副本：`C:\Users\karma617\.dsh\.desktop-plugin-runtime-compat-backup-20260907-142235`。使用 DSH `plugin --profile web remove dsh-multi-model-orchestrator` 移除本轮安装，删除本轮生成的 `multi-model-orchestrator`、`orchestrator` 两个预设目录，再将备份中的隔离 JSON 复制回原位置，可恢复迁移前状态。

## 2026-09-07 - Task: 解决 main 分支 Runtime Controller 合并冲突
### What was done
- 合并本地插件预设兼容准备与上游 Agent preset schema 恢复路径，保留多模型插件预设迁移、旧客户端隔离释放、启动失败后的预设修复及冲突插件自动隔离行为。
- 合并 Runtime Controller 测试注入入口与双方回归场景，确保预设兼容准备和新版 schema 恢复可独立验证。
### Testing
- `pnpm exec vitest run tests/runtime-controller-overlay.spec.ts tests/agent-preset-schema-recovery.spec.ts tests/plugin-preset-recovery.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，3 个测试文件、19 个测试。
- `pnpm run typecheck`：通过；当前 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，23 个测试文件、138 个测试。
- `pnpm run build`：通过；合并后的 Runtime Controller 已进入 `lib/main.js`，同样存在上述 Node.js engine 警告。
- `git diff --check`：通过；两个目标文件已清除冲突标记。未启动真实 Electron。
### Notes
- `src/runtime-controller.ts`：合并双方 Runtime 启动前预设处理、schema 恢复和冲突插件隔离入口。
- `tests/runtime-controller-overlay.spec.ts`：合并双方测试依赖注入参数及全部 Runtime 启动回归场景。
- `progress.md`：追加本轮冲突解决、验证和回滚记录。
- 回滚点：`b88cb64809e6bb0fc74d0b0ebdb7926d784532d9`。执行 `git restore --source=b88cb64809e6bb0fc74d0b0ebdb7926d784532d9 -- src/runtime-controller.ts tests/runtime-controller-overlay.spec.ts` 可将两个目标文件恢复到合并前的本地版本；`progress.md` 按追加式历史记录保留。

## 2026-09-07 - Task: 修复点击发送时丢失待发送长文本
### What was done
- 补齐新版 DSH 使用普通按钮触发发送时的壳侧提交接管：仅识别聊天输入卡片内中英文“发送消息”按钮，在原点击进入 DSH 前展开待发送 `.textclip`，随后重放同一按钮点击。
- 发送按钮从所属输入卡片内解析对应编辑器，避免多窗口或其他输入控件误用全局编辑器；加号、模型和权限等工具按钮保持原行为。
- 增加真实执行注入脚本的回归测试，验证待发送折叠内容会在按钮点击重放前写回输入框并进入发送值。
### Testing
- `pnpm exec vitest run tests/file-context-ui-contract.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、6 个测试。
- `pnpm run typecheck`：通过；当前 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，23 个测试文件、139 个测试。
- `pnpm run build`：通过；点击发送接管逻辑已进入 `lib/main.js`。
- `git diff --check`：通过。未启动当前桌面壳进行真实会话发送烟测。
### Notes
- `src/file-context-injector.ts`：增加发送按钮识别、同卡片编辑器解析、点击重放及监听清理。
- `tests/file-context-ui-contract.spec.ts`：增加按钮提交静态契约和长文本展开后再发送的执行级回归测试。
- `docs/conversation-edit-retry.md`：记录回车、表单和发送按钮三种提交路径的长文本展开规则。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`56a587004fca9d48b7a36a84249ce04c91e986a3`。执行 `git restore --source=56a587004fca9d48b7a36a84249ce04c91e986a3 -- src/file-context-injector.ts tests/file-context-ui-contract.spec.ts docs/conversation-edit-retry.md` 可回滚本轮代码、测试和文档；`progress.md` 按追加式历史记录保留。

## 2026-09-07 - Task: 修复仅有长文本折叠项时发送按钮仍不可用
### What was done
- 根据复验截图补齐第一轮遗漏：新版 DSH 的发送按钮由受控草稿是否为空决定，壳侧折叠标签不属于 DSH 原生附件，因此仅有 `.textclip` 时按钮仍会被判定为空。
- 待发送折叠项进入空输入框时写入不可见草稿占位，使 DSH 保持发送入口可用；发送前先移除占位并写入完整长文本，再重放原始发送动作。
- 用户清空输入、移除最后一个折叠项、手工展开或注入器卸载时同步恢复或清理占位，避免占位残留或进入最终消息。
- 增加仅有折叠项、草稿被清空后恢复占位、最终发送值包含完整长文本且不含占位字符的执行级回归覆盖。
### Testing
- `pnpm exec vitest run tests/file-context-ui-contract.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、6 个测试。
- `pnpm run typecheck`：通过；当前 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，23 个测试文件、139 个测试。
- `pnpm run build`：通过；空草稿占位、发送前展开和占位清理逻辑已进入 `lib/main.js`。
- `git diff --check`：通过。未替换当前正在运行的桌面壳进程，真实 DSH 会话发送需在重启桌面壳后复验。
### Notes
- `src/file-context-injector.ts`：增加仅有折叠项时的草稿占位生命周期，并在发送前还原完整内容。
- `tests/file-context-ui-contract.spec.ts`：覆盖空草稿按钮判定、占位恢复和最终发送内容。
- `docs/conversation-edit-retry.md`：记录仅有折叠项时的发送启用和占位清理规则。
- `progress.md`：追加本轮复验问题、修正、验证和回滚记录。
- 回滚点：`f06cdc3736cf16cfe6f05e3dee7c243406f709ff`。执行 `git restore --source=f06cdc3736cf16cfe6f05e3dee7c243406f709ff -- src/file-context-injector.ts tests/file-context-ui-contract.spec.ts docs/conversation-edit-retry.md` 可回滚本轮代码、测试和文档；`progress.md` 按追加式历史记录保留，通过后续追加更正记录处理。

## 2026-09-07 - Task: 核对复验版本并部署长文本发送修复
### What was done
- 核对截图对应的实际安装目录，确认桌面快捷方式仍指向 `C:\Users\karma617\AppData\Local\Programs\DeepSeek Harness`，复验时该目录中的 `app.asar` 仍是 `0.1.29`，不包含本轮草稿占位、发送按钮接管和点击重放代码。
- 使用真实 Electron 43 与 React 18 受控输入框执行一次临时烟测，验证当前注入脚本在“折叠长文本 + 额外输入 1”场景提交值为 `1` 加完整长文本，折叠项在提交后清除；临时烟测文件随后删除。
- 重新生成 `0.1.30` 安装包和便携包，安装到桌面快捷方式指向的实际目录，并核对安装后的 `app.asar` 已包含 `DRAFT_MARKER`、`SEND_BUTTON_LABELS` 和 `replayButtonClick`。
- 启动更新后的桌面壳，供当前窗口直接执行真实会话复验。
### Testing
- Electron + React 受控输入烟测：通过；仅折叠项时发送按钮可用，额外输入后最终提交值包含完整长文本且不含不可见占位。
- `pnpm run dist`：通过；生成 `DeepSeek-Harness-Shell-0.1.30-x64.exe` 和 `DeepSeek-Harness-Shell-Portable-0.1.30-x64.exe`。当前 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- 安装后静态核对：通过；实际安装版本为 `0.1.30`，安装目录 `app.asar` 包含草稿占位、发送按钮识别和点击重放实现。
- 安装包 SHA-256：`A80B008BAEAF04AAE88D0A79B7E73F7F482CC382B53E17E1BCE6863163266BB2`；便携包 SHA-256：`6E860CDF1CF5848CE41037255E11002F101303A553CD63B4D736267755193837`。
- 更新后的桌面壳已成功启动；真实智能体消息发送结果仍由当前窗口复验。
### Notes
- `dist/DeepSeek-Harness-Shell-0.1.30-x64.exe`：生成包含长文本发送修复的安装包。
- `dist/DeepSeek-Harness-Shell-Portable-0.1.30-x64.exe`：生成对应便携包。
- `C:\Users\karma617\AppData\Local\Programs\DeepSeek Harness`：从旧 `0.1.29` 更新为包含本轮修复的 `0.1.30`。
- `progress.md`：追加旧安装版本诊断、打包、部署和验证记录。
- 回滚点：`f06cdc3736cf16cfe6f05e3dee7c243406f709ff`。执行 `git restore --source=f06cdc3736cf16cfe6f05e3dee7c243406f709ff -- src/file-context-injector.ts tests/file-context-ui-contract.spec.ts docs/conversation-edit-retry.md`，再执行 `pnpm run dist` 并安装重新生成的安装包，可回退到部署前的长文本处理实现；`progress.md` 按追加式历史记录保留。

## 2026-09-07 - Task: 适配 DSH 0.1.3 Lexical 输入框并修复长文本草稿未同步
### What was done
- 根据 `0.1.30` 真实复验继续追踪已安装 DSH `0.1.3-alpha.1` 客户端代码，确认新版输入区已从受控 `textarea` 切换为 Lexical `contenteditable`；此前通过 `innerText` 和合成 `input` 事件写回，只改变 DOM，没有改变 Lexical 内部草稿，因此最终仍只提交用户额外输入的 `1`。
- 长文本注入现在优先读取输入根节点的 Lexical 文本缓存，并通过实际 Lexical 编辑器的 `parseEditorState`/`setEditorState` 写入草稿；换行转换为 Lexical `linebreak` 节点，确保多行长文本保持完整。
- 保留旧版 `textarea` 和普通 `contenteditable` 路径；仅在检测到实际 Lexical 编辑器时使用新版状态写入，不扩大其他输入控件的接管范围。
- 将发送执行级回归改为 Lexical 编辑器模型，覆盖不可见占位恢复、发送前完整长文本写入、换行保留和发送重放。
- 重新打包并安装修正版 `0.1.30`，安装目录中的 `app.asar` 已核对包含 Lexical 编辑器识别、文本缓存读取、换行节点和发送重放代码。
### Testing
- 实际 Electron 43 + DSH 同版 Lexical 0.49 临时烟测：通过；仅有 `.textclip` 时提交完整长文本，“`.textclip` + 输入 1”时提交 `1`、两个换行及完整长文本。临时烟测文件已删除。
- `pnpm exec vitest run tests/file-context-ui-contract.spec.ts --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、6 个测试。
- `pnpm run typecheck`：通过；当前 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- `pnpm test -- --maxWorkers=1 --testTimeout=20000`：通过，23 个测试文件、139 个测试。
- `pnpm run build`：通过；Lexical 草稿同步逻辑已进入 `lib/main.js`。
- `pnpm run dist`：通过；安装包 SHA-256 为 `FA5FF2F21B139D20795A49DB47F26EF68606250EB0CCFA731547AEE999AFAFE8`，便携包 SHA-256 为 `352C68982895BE658F5B277FB1DFD26589BD4FE8197CA3119B57EDE3A43DFBC7`。
- 安装后静态核对：通过；`C:\Users\karma617\AppData\Local\Programs\DeepSeek Harness\resources\app.asar` 更新时间为 2026-09-07 17:40:50，包含 `__lexicalEditor`、`__lexicalTextContent`、`linebreak` 和 `replayButtonClick`。
- `git diff --check`：通过。真实多模型会话发送由更新后窗口执行最终复验。
### Notes
- `src/file-context-injector.ts`：增加 Lexical 草稿读取、状态序列化写入及多行文本处理。
- `tests/file-context-ui-contract.spec.ts`：将发送执行级测试升级为 Lexical 输入模型。
- `docs/conversation-edit-retry.md`：记录 DSH `0.1.3` Lexical 输入兼容路径。
- `dist/DeepSeek-Harness-Shell-0.1.30-x64.exe`：重新生成包含 Lexical 修复的安装包。
- `dist/DeepSeek-Harness-Shell-Portable-0.1.30-x64.exe`：重新生成对应便携包。
- `progress.md`：追加真实根因、实现、验证、部署和回滚记录。
- 回滚点：`f06cdc3736cf16cfe6f05e3dee7c243406f709ff`。执行 `git restore --source=f06cdc3736cf16cfe6f05e3dee7c243406f709ff -- src/file-context-injector.ts tests/file-context-ui-contract.spec.ts docs/conversation-edit-retry.md`，再执行 `pnpm run dist` 并重新安装，可回退本轮及关联的未提交长文本兼容修改；`progress.md` 按追加式历史记录保留。

## 2026-09-07 - Task: 修复 Windows 构建脚本无法复用 DSH Runtime pnpm
### What was done
- Windows 构建脚本在选中 DSH Runtime Node.js 时同步保留 Runtime 根目录；PATH 中没有 pnpm 后，读取 `runtime-manifest.json` 的 `paths.pnpm` 并复用 Runtime 自带的独立 pnpm。
- 为已有 Runtime 布局保留 `tools\node_modules\@pnpm\exe\pnpm.exe` 和 `tools\pnpm.exe` 两个明确兼容路径；仅在 Runtime 也没有 pnpm 时继续尝试 Corepack。
- 补充构建脚本回归契约和开发者文档，明确 Node.js、Runtime pnpm、Corepack 的实际选择顺序。
### Testing
- `pnpm test -- tests/runtime-release-scripts.spec.mjs --maxWorkers=1 --testTimeout=20000`：通过，1 个测试文件、12 个测试；当前终端 Node.js 22.22.0 低于仓库声明的 Node.js 24，pnpm 输出 engine 警告。
- 隔离工具发现验证：将 PATH 限制为 `C:\Windows\System32`，指定本机 DSH Runtime 后运行 `build-windows.bat --no-pause`；脚本使用 Runtime Node.js 24.19.0，并从 Manifest 指向的 `tools\node_modules\@pnpm\exe\pnpm.exe` 成功取得 pnpm 11.7.0，随后按预期停在被隔离的 PowerShell 检查处。
- `build-windows.bat` 行尾检查：通过，174 个换行全部为 CRLF。
- `git diff --check`：通过。
### Notes
- `build-windows.bat`：增加所选 Runtime 的独立 pnpm 发现、Manifest 解析和兼容路径回退。
- `tests/runtime-release-scripts.spec.mjs`：增加 Runtime pnpm 优先于 Corepack 的构建脚本回归契约。
- `README.md`：更新 Windows 构建工具发现规则。
- `progress.md`：追加本轮施工、验证和回滚记录。
- 回滚点：`56298ebfff8f1d6789e874abef00cefd339ef8da`。执行 `git restore --source=56298ebfff8f1d6789e874abef00cefd339ef8da -- build-windows.bat tests/runtime-release-scripts.spec.mjs README.md` 可回滚本轮代码、测试和文档；`progress.md` 按追加式历史记录保留。

## 2026-09-07 - Task: 修复已发现 Runtime pnpm 后仍被重复查找判定缺失
### What was done
- Runtime pnpm 已存在时直接以带引号的绝对路径执行版本检查和后续命令，跳过第二次 PATH 发现；保留子进程 PATH 和版本一致性检查。
- 添加实际 CMD 执行回归，覆盖带空格的 Manifest 工具路径、PATH 工具缺失和模拟安装调用。
### Testing
- 在 HEAD 旧脚本上执行新增回归：按预期失败；恢复修复脚本后相关测试全部通过，13 个测试。
- 命令：`pnpm test -- tests/runtime-release-scripts.spec.mjs --maxWorkers=1 --testTimeout=20000`。终端 Node.js 22.22.0 有 engine 警告；未执行完整打包或另一台电脑现场验证。
- `git diff --check` 通过；批处理保持纯 CRLF。
### Notes
- `build-windows.bat`：直接调用已解析的 Runtime pnpm，版本读取加入 call 并清空继承值。
- `tests/runtime-release-scripts.spec.mjs`：增加 Windows CMD 执行级回归，测试不安装依赖或打包。
- `docs/windows-build.md`：记录直接调用规则、故障解释和验证边界。
- `progress.md`：追加本轮实施与测试记录。
- 回滚：`git restore --source=85e2b160b89fab486a08a734fb3bd68a13e53143 -- build-windows.bat tests/runtime-release-scripts.spec.mjs`；删除本轮新增文档 `docs/windows-build.md`，进度日志保留。

## 2026-09-07 - Task: 修复构建脚本依赖 PATH 发现 Windows PowerShell
### What was done
- 优先从 Windows 系统目录定位 PowerShell，缺失时再查 PATH；启动检查和两处输出目录准备使用同一绝对路径。
- 添加工具 PATH 为空时实际启动系统 PowerShell 的 CMD 回归，保留 pnpm 回归覆盖。
### Testing
- `pnpm test -- tests/runtime-release-scripts.spec.mjs --maxWorkers=1 --testTimeout=20000`：14 个测试通过，包含真实系统 PowerShell 执行；终端 Node.js 22.22.0 输出 engine 警告。
- `git diff --check` 与批处理纯 CRLF 检查通过。未运行完整打包，也未在报错电脑现场验证。
### Notes
- `build-windows.bat`：PowerShell 绝对路径发现、启动检查、调用和诊断。
- `tests/runtime-release-scripts.spec.mjs`：增加无工具 PATH 的 PowerShell 执行测试，调整已有测试的片段边界。
- `docs/windows-build.md`：补充 PowerShell 发现顺序及验证说明。
- `progress.md`：追加本轮记录。
- 回滚：`git restore --source=a837363009c1da49f29c8c9e02b8508b72b39f2f -- build-windows.bat tests/runtime-release-scripts.spec.mjs docs/windows-build.md`；保留进度历史。

## 2026-09-07 - Task: 调整 Windows 源码回退集成测试的时间预算
### What was done
- 仅将已在另一台电脑触及默认 5 秒限制的 404 源码回退用例设置为 20 秒；保留真实文件系统操作及全部断言，不调整生产逻辑或全局超时。
### Testing
- 修改前本机定向测试 4 个通过，未复现目标电脑的超时；检查确认下载与构建已模拟，临时目录操作为真实文件系统操作，具体耗时原因尚未确认。
- 修改后使用 Runtime Node.js 24.19.0 执行 `pnpm test`：23 个文件、142 个测试全部通过，未额外传递全局超时参数。
- `git diff --check`：通过。未执行完整打包，目标电脑仍需重跑确认。
### Notes
- `tests/source-runtime-installer.spec.ts`：只为 404 源码回退集成用例增加有限时间预算。
- `docs/windows-build.md`：说明调整范围及诊断边界。
- `progress.md`：追加验证和回滚记录。
- 回滚：`git restore --source=2031c8b8ab991d2c0c3f766fb0751b5cc01191ad -- tests/source-runtime-installer.spec.ts docs/windows-build.md`；保留进度日志。

## 2026-09-07 - Task: 修复打包子进程按名称启动 PowerShell 时 ENOENT
### What was done
- 将已确认可运行的 PowerShell 目录加入批处理局部 PATH，供 electron-builder 等子进程继承；保留脚本自身的绝对路径调用，不修改系统环境变量。
- 扩展原有空 PATH 回归，通过 Node 子进程按名称启动 powershell.exe，覆盖上一轮遗漏的子进程查找。
### Testing
- 修改前新增执行检查复现 `spawnSync powershell.exe ENOENT`，与用户日志的子进程查找失败一致。
- 修改后以 Runtime Node.js 24.19.0 执行 `pnpm test`：23 个文件、142 个测试通过，包含子进程真实启动 PowerShell。
- `git diff --check` 和批处理 CRLF 检查通过。未重新执行完整 electron-builder 打包，目标电脑仍需复验。
### Notes
- `build-windows.bat`：将已发现的 PowerShell 目录注入本次构建的 PATH。
- `tests/runtime-release-scripts.spec.mjs`：补充 Node 子进程按名称启动 PowerShell 的实际验证。
- `docs/windows-build.md`：记录对子进程的 PATH 继承规则与验证范围。
- `progress.md`：追加本轮记录。
- 回滚：`git restore --source=85db8e5fa0eb77ada5580fa48bcbcbc9e4808d3d -- build-windows.bat tests/runtime-release-scripts.spec.mjs docs/windows-build.md`；保留进度历史。

## 2026-09-08 - Task: 保留原会话 ID 的编辑与重试
### What was done
- 编辑和重试统一调用原会话 replay，不再创建、分叉或打开其他会话；首条和后续轮次使用同一路径。
- 保留完整长文本与图片，运行中禁用操作，旧 Runtime 明确提示升级且不静默追加或创建会话。
- 同步配套核心能力要求、有效历史语义及不撤销工具副作用的限制。
### Testing
- `node node_modules/vitest/vitest.mjs run tests/conversation-replay-shell-injector.spec.ts`：18 项通过，覆盖同 ID、完整文本及图片、旧 Runtime 和错误路径。
- `node node_modules/typescript/bin/tsc --noEmit` 与 `node node_modules/tsdown/dist/run.mjs` 通过。
- 配套核心 179 项定向测试、1 项真实 Loader/fetch/JSONL snapshot、1 项 Python SDK 测试及 host/client/web 构建通过，详见核心 progress.md。
- 两仓 `git diff --check` 通过。尚未打安装包或更新已安装 Runtime，真实 Electron 操作仍待配套部署后验收。
### Notes
- `src/conversation-replay-injector.ts`：在原会话调用 replay，去除分支创建路径并保护运行状态。
- `tests/conversation-replay-shell-injector.spec.ts`：断言原会话 ID、不创建或切换会话及完整内容重传。
- `docs/conversation-edit-retry.md`：说明配套部署、历史回退及同轮 steering 限制。
- `progress.md`：追加本轮实施、验证与回滚记录。
- 配套核心改动位于 `D:\work\ai\deepseek-harness`；既有 build-runtime.ps1 从官方 tag 构建，不能用于交付本地未提交核心改动。须从本轮修改后的核心构建并配套部署；仅执行 build-windows.bat 不会更新 Runtime。
- 回滚（壳根目录执行，保留日志）：`git restore --source=c51f91825029cf274b8b7f29ac9cfea747e85705 -- src/conversation-replay-injector.ts tests/conversation-replay-shell-injector.spec.ts docs/conversation-edit-retry.md`。核心按对应 progress.md 独立回滚；不要以源码回滚代替会话数据备份。

## 2026-09-08 - Task: 仅由桌面壳实现保留原会话 ID 的编辑和重试
### What was done
- 撤回上一轮核心源码、协议与 SDK 改动；核心仓库只保留历史进度日志。当前交付不要求定制核心，取代上一轮“必须同时发布核心”的方案。
- 壳后端加载钩子仅在内存中适配普通发送的重试分支；在原智能体维护阶段验证目标，真正提交替换消息时调用核心既有 replacement 校验，完整保留原始审计日志和会话 ID。
- 覆盖旧式 host-apiproxy/client-runtime 与本机 0.1.3-alpha.1 的拆分控制器结构；新结构同时检查控制器和宿主参数校验，避免只放宽校验却仍执行普通追加。
- 壳客户端适配原会话调用、历史投影和独立请求模式；实时、重载与翻页均排除被替换历史，普通事件保持原路径，展示适配异常保留核心历史。
- 模型上下文保留目标前有效前缀，原文本与图片重传逻辑保留；排队、运行中、失效目标等错误不创建会话。
### Testing
- Node 24.19.0 / pnpm 11.7.0 执行 pnpm test：24 个文件、153 个测试通过。
- 初次直接运行 vitest 时，已有发布脚本测试因缺少 npm_execpath 失败；使用项目规定的 pnpm test 后全量通过，未修改该测试。
- pnpm run build 通过，包含 TypeScript 检查及壳后端/preload 构建。
- node scripts/smoke-same-session-replay.mjs D:\work\ai\deepseek-harness：在恢复的原版核心上通过真实 Loader、fetch、JSONL 和实际客户端模块验证首轮/后续轮次同 ID 重试及重载。
- Node 24 执行 scripts/smoke-installed-session-replay.mjs 指向本机官方 0.1.3-alpha.1：实际控制器/输入校验/智能体循环/JSONL、客户端实时/重载/分页验证通过；同一检查设置 DSH_REPLAY_BUILT_HOOK=1 后再次通过，验证实际构建的后端钩子。
- 安装版 smoke 中仅外部模型、无文件上传场景的外围服务与浏览器连接使用测试替身；未执行真实模型请求、真实图片存储或 Electron 窗口交互。
- 核心 git status --short 仅剩 progress.md；安装版 smoke 校验核心控制器文件字节未变；两仓 git diff --check 通过。
### Notes
- src/conversation-replay-host-injector.ts：提供两种后端适配、版本形态检查及一次性 replacement 提交与清理。
- src/conversation-replay-client-injector.ts：提供两种客户端历史投影、原会话调用及重试专用输入适配。
- src/shutdown-hook.ts：在现有后端启动入口安装壳侧可选加载钩子。
- src/preload.ts：隔离安装客户端适配，保留其余基础桥接初始化。
- src/conversation-replay-injector.ts：调用壳提供的 desktopReplay 并展示后端具体错误，不依赖核心新增接口。
- tests/conversation-replay-adapter.spec.ts：验证持久化兼容、同 ID、清理、错误隔离及各类转换匹配。
- tests/conversation-replay-shell-injector.spec.ts：使用壳侧能力并验证不创建或切换会话和完整内容重传。
- scripts/smoke-same-session-replay.mjs：只读使用已构建核心，运行独立临时会话组合验证。
- scripts/smoke-installed-session-replay.mjs：只读使用已安装的新结构 Runtime，验证实际控制器及客户端并支持构建后钩子验证。
- docs/conversation-edit-retry.md：更新仅壳部署方式、版本适配与验证边界。
- progress.md：追加本轮实施、验证、限制及回滚记录。
- 每轮首条用户消息可编辑/重试；同轮 steering、子智能体和未知内容块暂不支持。外部文件/命令/设置副作用不撤销，未来核心变更仍可能需要壳适配，不承诺永久兼容。
- 未覆盖已安装 Runtime、未重启用户应用、未生成安装包；打包后窗口与图片交互仍需验收。
- 回滚至本系列修改前（壳根目录执行，保留日志）：
```powershell
git restore --source=c51f91825029cf274b8b7f29ac9cfea747e85705 -- src/conversation-replay-injector.ts src/preload.ts src/shutdown-hook.ts tests/conversation-replay-shell-injector.spec.ts docs/conversation-edit-retry.md
Remove-Item -LiteralPath 'src/conversation-replay-host-injector.ts','src/conversation-replay-client-injector.ts','tests/conversation-replay-adapter.spec.ts','scripts/smoke-same-session-replay.mjs','scripts/smoke-installed-session-replay.mjs'
```

## 2026-09-08 - Task: 修复主题右下角设置入口并使用 SVG 调色盘图标
### What was done
- 修正错误拼接的 SVG 命名空间，解决按钮有边框但图标空白的问题。
- 将设置齿轮替换为调色盘轮廓与四个颜料孔，维持 20×20 图标、38×38 按钮、继承主题前景色及原点击/键盘行为。
### Testing
- 修复前回归稳定复现命名空间实际为 http://www.w3.org://2000://svg，与标准 SVG 命名空间不一致。
- node node_modules/vitest/vitest.mjs run tests/skin-market-injector.spec.ts：5 项通过。
- Node 24 下 pnpm run build 通过，包含 TypeScript 检查；git diff --check 通过。
- Chromium 实际执行同一图标创建代码，验证原生 SVGSVGElement、标准命名空间、4 个圆形与 20×20 尺寸；已检查截图 C:\Users\karma617\AppData\Local\Temp\dsh-palette-icon.png，调色盘图标正常显示。
- 未打安装包或重启正在运行的桌面壳；主题内实际入口仍待新构建加载后验收。
### Notes
- src/skin-market-injector.ts：仅替换设置入口 SVG 的命名空间及图形，保留按钮交互。
- tests/skin-market-injector.spec.ts：执行生成的图标代码并验证命名空间、属性和图元。
- docs/shell-skin-marketplace.md：说明设置入口调色盘图标与主题颜色继承。
- progress.md：追加本轮验证和回滚记录。
- 回滚（保留日志）：git restore --source=f28bae342ed99250cc9d8ea8b65f0e8a2f6532ac -- src/skin-market-injector.ts tests/skin-market-injector.spec.ts docs/shell-skin-marketplace.md

## 2026-09-08 - Task: 将调色盘设置按钮边框改为圆形
### What was done
- 仅将右下角设置按钮圆角设为 50%，保留 38×38 尺寸、调色盘图标及原交互。
### Testing
- tests/skin-market-injector.spec.ts：6 项通过，新增断言验证按钮尺寸与圆形圆角。
- git diff --check 通过；未重新打包或重启当前应用。
### Notes
- src/skin-market-injector.ts：设置入口 borderRadius 从 9px 调整为 50%。
- tests/skin-market-injector.spec.ts：新增圆形按钮样式回归。
- docs/shell-skin-marketplace.md：记录圆形入口尺寸。
- progress.md：追加本轮记录。
- 回滚方式：只将 settings.toggle 的 borderRadius 从 50% 恢复为 9px，移除本轮新增的圆形样式测试与文档描述；保留上一轮 SVG 修复和历史日志。

## 2026-09-08 - Task: 完成壳侧后院鱼塘互动与对话成长
### What was done
- 接续中断任务已有的鱼塘接线与存档实现，完成「帮助」右侧「后院鱼塘」独立窗口及本地绘制的日式池塘，不修改 DSH 核心或真实会话数据。
- 完成投喂追食、抚水涟漪、昼夜切换、键盘互动、锦鲤档案与改名；对话成功发送推进等级，每 100 级舒展体型鳍尾，500 级异性配对产卵，再经 5 次对话孵化。
- 保留每条鱼一次繁育、鱼卵合计 16 位、无离线惩罚的规则，补齐窗口关闭后成长与存档恢复验证；修复较长／转义消息 ID 写入后被存档校验错误拒绝的问题。
- 补充使用说明、兼容边界、回滚命令与可复跑的独立 Electron 冒烟脚本，保留此前主题设置按钮相关改动。
### Testing
- 使用本机 Runtime 附带 Node 24.19.0。pnpm test：25 个测试文件、169 项全部通过；其中鱼塘专项 14 项覆盖成长、配对孵化、容量、去重、存档、改名、失败隔离、模块转换组合与入口资源契约。
- pnpm run build 通过，包含 TypeScript 类型检查；git diff --check 通过。保留构建工具现有 CommonJS 提示，不将其列为产品故障。
- 已只读核对当前安装的 Runtime 0.1.3-alpha.1：原会话重试与成长观察组合后的真实模块工厂语法通过；以模拟 API 执行真实 prompt 方法体，成功返回并只发出一次成长通知，原 Runtime 文件内容不变。
- 独立隐藏 Electron 冒烟通过：真实 preload IPC、单窗口、改名持久化、饲料绘制与 25 秒过期前被鱼儿吃完、抚水不投食、昼夜、消息去重、关闭窗口后成长、重开、重新加载存档与 680×520 视口。
- 冒烟结果与日间／夜间／小窗口截图：C:\Users\karma617\AppData\Local\Temp\dsh-koi-smoke-BsbTt6；已目视检查日间和小窗口截图，并降低池底石纹对比度，避免背景抢占锦鲤视觉。
- 初次组合测试误把隔离包装函数当成原始工厂断言，已改为检查实际生成的类方法；初次隐藏窗口动画受原生后台节流影响，改为仅在临时测试副本启用 offscreen 后验证追食通过。重新打开测试补充 window-all-closed 处理，避免独立测试应用提前退出。
- 直接调用 Vitest 的一次全量运行因已有发布脚本测试缺少 npm_execpath 失败，改用项目规定的 pnpm test 后全量通过；没有为此改动发布测试或发布脚本。
- 未打安装包、未重启或终止当前桌面壳，未发送真实模型请求。主壳原生菜单点击、真实聊天至成长的完整桥接、安装包资源仍需新构建人工验收；独立 Electron 验证使用临时存档和临时转译窗口副本，不等同于整包验收。
### Notes
- src/main.ts：接续鱼塘控制器初始化、帮助右侧入口、可信主窗口成长通知转发与退出存档等待。
- src/preload.ts：接续主页面成长观察安装与同窗口消息通知转发。
- src/conversation-replay-injector.ts：接续模块转换按注册顺序组合，避免成长观察覆盖已有原会话重试增强。
- src/koi-pond-injector.ts：保留壳侧成功发送观察器，按会话与请求通知成长，错误不改变聊天结果。
- src/koi-pond-store.ts：完成独立成长、繁育和原子存档实现的验证，并修复去重键长度校验。
- src/koi-pond-window.ts：保留独立隔离窗口、窗口来源校验、读取／改名 IPC 和状态广播。
- src/koi-pond-preload.ts：提供独立鱼塘读取、改名和状态订阅桥接。
- tsdown.config.ts：接续鱼塘专用 preload 的 CommonJS 构建入口。
- assets/koi-pond.html：新增中文鱼塘结构、工具、档案和成长说明。
- assets/koi-pond.css：新增庭院风格、浮层布局、焦点样式及小窗口适配。
- assets/koi-pond.js：新增 Canvas 池塘、游动追食、成长形态、涟漪、昼夜、档案与键盘交互。
- tests/koi-pond.spec.ts：新增 14 项存档、规则、观察器组合与入口打包契约测试。
- scripts/smoke-koi-pond.mjs：新增只读 Runtime 核对与独立隐藏 Electron 互动冒烟，保留临时截图和结果。
- docs/koi-pond.md：新增玩法、统计口径、存档、故障边界、验证及精确回滚说明。
- progress.md：仅在末尾追加本轮结果、证据和回滚记录。
- 回滚点：当前任务尚未提交时，可执行 git restore --source=HEAD -- src/main.ts src/preload.ts src/conversation-replay-injector.ts tsdown.config.ts，再按 docs/koi-pond.md 的 Remove-Item -LiteralPath 明确文件清单移除本功能新增文件，执行 pnpm run build；保留本日志、用户存档及已有主题设置改动。若这些文件后续又有其他修改，改用本功能提交／补丁精确回退。

## 2026-09-08 - Task: 增加鱼塘禅模式与右键退出
### What was done
- 在鱼塘底部互动工具栏增加「禅」按钮，进入后隐藏所有池塘内文字、面板、按钮、通知及选中标记，仅显示池塘画面，保持原有游动、互动与成长。
- 单击鼠标右键退出禅模式并恢复原界面和所选锦鲤；右键不再误触投喂，退出时拦截右键菜单，不残留禅模式期间的成长提示。
### Testing
- node scripts/smoke-koi-pond.mjs 通过：独立隐藏 Electron 中确认仅 Canvas 可见、成长期间通知仍隐藏、右键不投食、右键菜单事件被拦截、退出恢复全部面板与原选中锦鲤；原有投喂、昼夜、存档等冒烟检查继续通过。
- 鱼塘专项 tests/koi-pond.spec.ts：14 项全部通过；git diff --check 通过。
- 已目视检查 C:\Users\karma617\AppData\Local\Temp\dsh-koi-smoke-lbQDwa\pond-zen.png，画面没有文字、工具栏或选中标记。
- 本轮仅修改页面资源、冒烟脚本与文档，未重新构建安装包，未重启或操作当前桌面壳实例；实际窗口中的鼠标操作仍可在加载新资源后人工复核。
### Notes
- assets/koi-pond.html：工具栏新增带退出说明的「禅」按钮。
- assets/koi-pond.css：禅模式隐藏 Canvas 以外的界面元素及画布焦点边框。
- assets/koi-pond.js：增加禅模式状态、进入与右键退出处理，隐藏通知和辅助标记，限制左键触发投喂。
- scripts/smoke-koi-pond.mjs：新增禅模式隐藏、成长通知、右键退出、界面恢复断言及截图。
- docs/koi-pond.md：补充禅模式使用方式与状态保持说明。
- progress.md：仅追加本轮变更与验证记录。
- 回滚方式：git restore --source=9151d32 -- assets/koi-pond.html assets/koi-pond.css assets/koi-pond.js scripts/smoke-koi-pond.mjs docs/koi-pond.md；保留本日志与用户鱼塘存档。该回滚点保留此前已完成的鱼塘功能。

## 2026-09-08 - Task: 按日间和夜间设计稿重做鱼塘美术与界面
### What was done
- 使用用户提供的两张设计稿制作日间与夜间本地背景，分别保留碧绿水色／日照叶影和深蓝月光／暖灯，不以整体变暗代替夜景。
- 重建朱印标题、金线花角面板、荷花冠饰、右侧真实锦鲤档案、底部投喂／玩水双按钮与返回入口；保留并移至右上角的日夜、禅模式按钮。
- 清理原稿中烘焙的文字与面板，遮挡景物用邻近庭院纹理重建，禅模式下不残留固定文字；真实锦鲤继续独立绘制，保持成长、繁育、改名、投喂和右键退出禅模式。
- 根据新池岸布局将游动与投喂限制在中央水域，默认独立窗口调整为 1280×720，保持小窗口可滚动档案；所有资源本地打包，不新增产品依赖或修改 DSH 核心。
### Testing
- Node 24.19.0 下 pnpm test：25 个文件、170 项全部通过；新增日夜 WebP、SVG 装饰及入口资源契约测试。
- pnpm run build 通过，包括 TypeScript 类型检查；node --check assets/koi-pond.js 与 git diff --check 通过。构建工具保留现有 CommonJS 提示，未改动无关构建配置。
- 独立隐藏 Electron 冒烟通过：两幅美术资源实际解码、日夜主题切换、投喂追食、玩水、改名、成长去重、禅模式隐藏和右键退出、返回按钮关闭独立鱼塘、关闭后成长与存档恢复、小窗口无页面横向溢出和面板隐藏横向滚动条。
- 冒烟输出 C:\Users\karma617\AppData\Local\Temp\dsh-koi-smoke-L6fnXX，含 1723×913 日间、1280×679 夜间、普通窗口、禅模式和 680×520 小窗口截图。已目视检查日夜、禅模式及最终小窗口画面。
- 美术迭代发现 OpenCV seamlessClone 会修改传入掩码，若事后计算羽化会导致原文字透出；已改为事前计算羽化覆盖率，重新导出并检查禅模式无文字残留。小窗口初次截图出现面板横向滚动条，已修复并复验。
- 使用 Pillow／NumPy／OpenCV 对用户本地原稿进行确定性像素处理，未调用图像生成服务，原图未改写。背景 WebP 合计约 1.1 MiB，随已有 assets/* 规则打包。
- 本轮未打安装包、未重启或操作当前运行的桌面壳、未发送真实模型请求；独立窗口冒烟不等于安装包或主壳整体运行验收。
### Notes
- assets/koi-pond-day.webp：新增清理固定 UI 后的日间背景。
- assets/koi-pond-night.webp：新增清理固定 UI 后的夜间背景。
- assets/koi-pond-lotus.svg：新增本地矢量荷花冠饰。
- assets/koi-pond-frame.svg：新增本地矢量金线花角框。
- assets/koi-pond.html：调整设计稿标题与按钮布局、增加背景预加载和返回入口，保留真实交互控件。
- assets/koi-pond.css：按设计稿重建字号比例、面板位置、冠饰、花角、工具栏和昼夜配色，保持禅模式与小窗口适配。
- assets/koi-pond.js：加载独立日夜背景、等比铺满，调整锦鲤与水域匹配，增加夜间微光及返回操作，保留存档桥接和成长规则。
- src/koi-pond-window.ts：仅将默认窗口尺寸改为 1280×720。
- scripts/prepare-koi-art.py：新增可复跑的本地原稿 UI 清理、纹理补齐与 WebP 导出脚本。
- scripts/smoke-koi-pond.mjs：补充设计尺寸截图、美术解码、返回按钮、小窗口检查，保留已有禅模式及成长测试。
- tests/koi-pond.spec.ts：新增日夜场景与冠饰、花角资源存在及格式检查。
- docs/koi-pond.md：更新按钮位置、玩法范围、本地美术来源、原图遮挡重建及还原边界。
- progress.md：仅追加本轮结果、验证证据和回滚方式。
- 还原边界：被原面板遮住的景物属于重建，并非原始隐藏图层；本机字体、动态锦鲤及额外保留的日夜／禅入口与设计稿存在差异，不宣称像素级 100% 一致。
- 本轮回滚补丁：C:\Users\karma617\AppData\Local\Temp\dsh-koi-art-rollback-51cois3y\revert-art-keep-zen.patch，基于 9151d32 及已有禅模式差异构造，已通过 git apply --check --ignore-space-change 验证。执行 git apply --ignore-space-change "C:\Users\karma617\AppData\Local\Temp\dsh-koi-art-rollback-51cois3y\revert-art-keep-zen.patch"，再执行 Remove-Item -LiteralPath assets/koi-pond-day.webp, assets/koi-pond-night.webp, assets/koi-pond-lotus.svg, assets/koi-pond-frame.svg, scripts/prepare-koi-art.py，最后 pnpm run build；保留此前禅模式、用户存档及本日志。该补丁保存在临时目录，长期留存请先备份，后续继续修改文件时应重新核对补丁。

## 2026-09-08 - Task: 增强玩水涟漪的可见度
### What was done
- 采用直接增强方案，不增加力度设置项：玩水涟漪从两圈变为三圈，半径扩大 50%，线宽从 1 增至 1.8 像素，初始不透明度从 30% 提升至 60%，并使用更明亮的水面高光色。
- 保持 2.5 秒淡出和波纹数量上限；投喂与进食保留原来的小波纹，不改变鱼塘布局、成长或存档规则。
### Testing
- node --check assets/koi-pond.js 与 git diff --check 通过；鱼塘专项 tests/koi-pond.spec.ts 的 15 项测试通过。
- 独立隐藏 Electron 冒烟通过：日间、夜间均实际记录三圈绘制、1.8 像素线宽、12 像素环间距及提亮颜色，确认正常淡出且玩水不投食；另确认投喂仍为原色、两圈、1 像素线宽。
- 已目视检查日夜涟漪截图；最终冒烟输出 C:\Users\karma617\AppData\Local\Temp\dsh-koi-smoke-TlQlWw，包含 pond-ripple-day.png、pond-ripple-night.png 及原有交互检查。
- 初次新增线宽断言使用浮点全等导致失败，调整为 0.001 容差后通过；仅修正测试浮点比较，没有放宽产品参数。
- 修正旧玩水冒烟落点：原坐标处于新背景中央水域之外，改为有效水面坐标，并增加实际波纹绘制断言，避免仅以“不产生饲料”误判玩水成功。
- 本轮未重新打包、未重启当前桌面壳；独立 Electron 验证不等同于现有安装实例已加载新资源。
### Notes
- assets/koi-pond.js：仅为玩水创建强涟漪，按类型设置圈数、尺度、颜色、透明度及线宽。
- scripts/smoke-koi-pond.mjs：增加真实绘制参数、日夜截图、淡出和投喂保持轻波纹的检查。
- docs/koi-pond.md：记录增强后的玩水波纹参数及无新增设置项。
- progress.md：仅在末尾追加本轮结果与验证证据。
- 回滚方式：git restore --source=540408c216e637a1041727f4866ee17c8773a1d6 -- assets/koi-pond.js scripts/smoke-koi-pond.mjs docs/koi-pond.md；保留本日志及用户存档，该回滚点保留此前日夜美术与禅模式。

## 2026-09-08 - Task: 为玩水波纹增加自然轮廓与轻微立体感
### What was done
- 将玩水的标准椭圆改为轻微不规则的连续轮廓，每次点击使用独立相位，波形随扩散缓慢变化，避免整齐白圈和逐帧随机抖动。
- 为三道波纹叠加方向性渐变亮边与错位柔暗边，表现波峰和波谷；根据截图减弱暗边，避免黑色描边过重。
- 保留上一轮增强后的范围、三道波纹与 2.5 秒淡出；投喂和进食的小波纹不变，不改动存档或成长规则。
### Testing
- node --check assets/koi-pond.js、git diff --check 通过；鱼塘专项 tests/koi-pond.spec.ts 的 15 项通过。
- 独立隐藏 Electron 冒烟通过：日夜场景均检查三组亮暗双层绘制、亮边渐变、明暗错位、轮廓偏离标准椭圆、正常淡出、玩水不投食，以及原有投喂小波纹和禅模式等交互。
- 已目视检查日夜效果，最终截图及结果目录 C:\Users\karma617\AppData\Local\Temp\dsh-koi-smoke-zeluH0；最终日间截图确认暗边已减弱、保留轻微凹凸感。
- 本轮未打包、未重启当前桌面壳；这是轻量绘制效果，不是流体物理模拟。
### Notes
- assets/koi-pond.js：增加连续不规则波形与方向性亮暗分层绘制，仅用于玩水。
- scripts/smoke-koi-pond.mjs：从标准椭圆参数检查改为实际轮廓、亮暗层、错位及渐变检查。
- docs/koi-pond.md：更新自然波纹的表现与模拟边界说明。
- progress.md：仅追加本轮结果、验证与回滚记录。
- 回滚：本轮修改前已将三个文件备份到 C:\Users\karma617\AppData\Local\Temp\dsh-ripple-before-966486996c6d47008429a9b3c503db30。执行 Copy-Item -LiteralPath "C:\Users\karma617\AppData\Local\Temp\dsh-ripple-before-966486996c6d47008429a9b3c503db30\koi-pond.js" -Destination assets/koi-pond.js；对同目录 smoke-koi-pond.mjs 和 koi-pond.md 分别复制回 scripts/smoke-koi-pond.mjs 和 docs/koi-pond.md。保留本日志，该方式保留上一轮加大波纹的改动；长期保留回滚点请备份临时目录。

## 2026-09-08 - Task: 壳侧 PowerShell 启动与工作目录兼容
### What was done
- 自动发现 PowerShell 时验证实际启动能力，跳过失效别名；执行前区分损坏路径与不存在目录，不自动重放命令。
### Testing
- 使用已安装 Runtime 的 Node 24：定向 Vitest 5/5 通过；tsc --noEmit 退出码 0。
- 已检查 0.1.3-alpha.1 实际模块特征；尚未在附件所述机器执行主/子代理验收。
### Notes
- src/runtime-tool-compatibility.ts：新增只在内存生效的定点模块适配。
- src/shutdown-hook.ts：接入工具兼容钩子。
- tests/runtime-tool-compatibility.spec.ts：覆盖别名探测、路径校验及未知版本保留。
- docs/runtime-tool-compatibility.md：说明生效、验证和回滚。
- progress.md：仅追加本轮记录，保留已有未提交内容。
- 回滚：移除 shutdown-hook.ts 中 installRuntimeToolCompatibility 的导入和调用后重新构建，停用全部本轮适配；无需修改 DSH 或会话。

## 2026-09-08 - Task: 降低模型代码解析失败后的重复试错
### What was done
- 复现附件两段原始代码的解析错误，定位普通字符串实际换行与 new_string 字段引号错误。
- 补充共享 SDK 编码指引和执行前解析失败诊断，不修改模型代码、不重试已完成调用。
### Testing
- Node 24 直接解析附件：两段错误分别复现 Expected comma 与 Unexpected token async，第三段可解析。
- 定向 Vitest 8/8 通过；tsc --noEmit 退出码 0。尚未验证在线模型错误率变化。
### Notes
- src/runtime-tool-compatibility.ts：新增 SDK 指引与解析失败限定入口适配。
- tests/runtime-tool-compatibility.spec.ts：新增语法复现、无副作用失败及重复适配测试。
- docs/runtime-tool-compatibility.md：记录已证实根因及缓解范围。
- progress.md：追加本任务记录。
- 回滚：移除加载钩子中 adaptRuntimeCode 和 adaptRuntimeToolPrompt 两个路由并重新构建；或按上一任务方式停用完整兼容钩子。

## 2026-09-08 - Task: 壳侧压缩日志读取及工具兼容整体验证
### What was done
- 现有 read 仅对 .jsonl.zstd 增加有界解压，保留文件服务路径解析、类型检查及原有行号分页/输出限制；不新增独立工具、不写入 DSH 核心。
- 处理连续 Zstandard 帧，压缩输入限 16 MiB、解压合计限 64 MiB，支持帧间取消与严格 UTF-8 校验。
- 新增实际安装 Runtime 模块的隔离冒烟脚本；未启动或重启 DSH 服务，未生成安装包。
### Testing
- 首轮拼接帧回归确实失败：Node 单次解压只返回第一帧；按实际消费字节逐帧处理后定向 14/14 通过。
- 使用 Runtime Node 24：tsc --noEmit 退出码 0；pnpm test 全量 27 文件/190 测试通过；pnpm run build 退出码 0。
- 首次直接调用 Vitest 全量有 1 项发布脚本测试因缺少 npm_execpath 失败；改用 pnpm test 正式入口后全部通过。
- smoke-runtime-tool-compatibility.mjs 针对本机 0.1.3-alpha.1：四个实际模块匹配、语法检查及导入通过；真实 PowerShell 固定输出通过；损坏目录在执行前报错；实际代码执行器解析失败提示通过；实际注册 read 对合成拼接帧、分页及文件服务拒绝路径通过；四个核心文件前后 SHA-256 相同。
- git diff --check 退出码 0，仅有已有 progress.md 换行规范提示；构建有原工具的 CJS/依赖打包提示。
- 未验证：附件机器上的实际主/子代理调用、打包 Electron 应用、在线模型语法错误率；现有正在运行的应用尚未应用这些源码变更。
### Notes
- src/runtime-tool-compatibility.ts：新增有界多帧压缩日志读取与精确模块路由。
- src/shutdown-hook.ts：本轮前序任务已接入兼容钩子，此任务保留该入口。
- tests/runtime-tool-compatibility.spec.ts：新增分页、多帧、损坏/超限/编码、取消、拒绝访问及普通文件路由测试。
- scripts/smoke-runtime-tool-compatibility.mjs：新增隔离实际 Runtime 冒烟与核心文件哈希核对。
- docs/runtime-tool-compatibility.md：补充读取范围、限额、性能边界及冒烟使用方法。
- progress.md：追加本任务证据；原有 koi-pond 相关修改未编辑，构建产物包含当前工作区已有变更。
- 回滚：移除 src/shutdown-hook.ts 中 installRuntimeToolCompatibility 的导入与调用，然后 pnpm run build；重新打包/启动后停用全部本轮适配。仅停用压缩读取可移除钩子中 adaptRuntimeRead 路由。不要用 git restore progress.md 覆盖其他未提交记录。

## 2026-09-08 - Task: 依据正弦衰减与双线性插值重做玩水折射
### What was done
- 用径向正弦位移替代玩水的亮暗轮廓描线：波包由点击中心向外传播，振幅随时间、距离及寿命逐渐衰减，并使用平滑包络避免波前硬边。
- 从当前背景与锦鲤画面读取点击附近像素，保留浮点采样坐标，以周围四像素双线性插值产生真实画面扭曲；多波位移先叠加，再从未变形的原帧采样一次，避免累计拖影。
- 保留投喂和进食原有轻波纹、中央水域裁切、2.5 秒动画寿命、减少动态效果及禅模式，不改动成长、存档、Runtime 或其他任务文件。
- 只处理活动区域，预计算径向三角函数短表；新增本地纯计算脚本，无网络、WebGL、第三方依赖或线程改动。
### Testing
- node --check assets/koi-pond-refraction.js、node --check assets/koi-pond.js 与本轮文件 git diff --check 通过。
- tests/koi-pond-refraction.spec.mjs 与 tests/koi-pond.spec.ts：21 项通过，覆盖四像素权重结果、边界钳制、正弦传播、振幅衰减、波包外透明、到期消失、重叠位移、减弱强度及加载顺序。
- 独立隐藏 Electron 冒烟通过：日夜场景实际像素发生改变、处理区域小于全画面、波包外像素不覆盖、正常到期、投喂保持原有小波纹、禅模式、改名及存档恢复等。
- 输出目录 C:\Users\karma617\AppData\Local\Temp\dsh-koi-smoke-xPGyzl，含日夜截图、局部连续帧与 refraction-timing.json；已查看实际折射局部画面，并生成 refraction-day.gif、refraction-night.gif 用于预览。
- 本机隐藏 Electron 样本：275 次单击折射内核调用，中位约 4.7 ms、P95 约 14.2 ms；24 个重叠波纹单次约 36.4 ms。这些仅为 CPU 内核时间，不含取图、回写与整窗渲染，也不代表稳定 60 FPS。
- 本轮未自行执行全量构建或打包，未重启当前桌面壳、未发送模型请求。工作区并行出现的 Runtime 工具兼容性源码、测试、文档和进度记录均未修改或覆盖。
### Notes
- assets/koi-pond-refraction.js：新增正弦衰减、径向查表、多波位移相加与显式双线性像素采样内核。
- assets/koi-pond.js：去除玩水轮廓描线，接入局部画面取样与折射回写，保留其他互动。
- assets/koi-pond.html：在鱼塘主脚本前加载本地折射脚本。
- tests/koi-pond-refraction.spec.mjs：新增 6 项数学、采样、边界、叠加与资源加载测试。
- scripts/smoke-koi-pond.mjs：从轮廓绘制检查改为真实像素差异、局部区域、寿命与性能采样，输出连续帧。
- docs/koi-pond.md：更新玩法表现、公式与采样步骤、CPU 开销和二维近似边界。
- progress.md：仅追加本轮证据与回滚记录，保留其他任务新增历史。
- 回滚点：C:\Users\karma617\AppData\Local\Temp\dsh-refraction-before-9cab16e152ab40a699eb52c9ca3d4193。用 Copy-Item -LiteralPath 将该目录的 koi-pond.js、koi-pond.html 分别复制回 assets/ 对应文件，smoke-koi-pond.mjs 复制回 scripts/，koi-pond.md 复制回 docs/；执行 Remove-Item -LiteralPath assets/koi-pond-refraction.js, tests/koi-pond-refraction.spec.mjs。保留本日志、存档及 Runtime 并行改动。临时备份包含上一轮自然轮廓波纹，长期需要回滚时请另行备份该目录。

## 2026-09-08 - Task: 限制鱼塘密集连续点击
### What was done
- 投喂和玩水共用 500 毫秒互动冷却，活动玩水折射波最多 3 个；鼠标、键盘和禅模式共用入口，模式切换保留冷却。
- 超限输入直接丢弃，不排队、不生成额外特效、不重复刷新提示；投喂满额检查提前到创建波纹之前，活动波纹到期后恢复互动。
### Testing
- node --check assets/koi-pond.js 与 node --check scripts/smoke-koi-pond.mjs 通过。
- 三组定向 Vitest 测试共 25 项通过，含新加的千次密集输入、冷却边界、活动波纹上限、到期恢复、模式切换、饲料满额和无效水域检查。
- node scripts/smoke-koi-pond.mjs 独立隐藏 Electron 冒烟通过，真实页面验证 200 次密集点击仅产生一个波纹、间隔点击最多三个波纹、到期后恢复，以及原有投喂、日夜、禅模式、存档等回归。输出：C:\Users\karma617\AppData\Local\Temp\dsh-koi-smoke-v3kaA7。
- 未构建或打包，未操作正在运行的主壳；检查结论不代表所有硬件的帧率保证。
### Notes
- assets/koi-pond.js：入口冷却及活动折射波上限，提前执行投喂满额判断。
- tests/koi-pond-interaction.spec.mjs：新增四项互动预算测试。
- scripts/smoke-koi-pond.mjs：新增实际页面密集点击、上限和恢复断言，人工重叠采样调整为三个波纹。
- docs/koi-pond.md：同步互动限制和性能边界。
- progress.md：追加本轮记录。
- 回滚：执行 git restore --source=ca32fbe579fc864f141888a3091184a58d56bc00 -- assets/koi-pond.js scripts/smoke-koi-pond.mjs docs/koi-pond.md；执行 Remove-Item -LiteralPath tests/koi-pond-interaction.spec.mjs。仅在这些文件没有后续修改时使用；保留本日志与鱼塘存档。

## 2026-09-08 - Task: 统一投食与进食水波折射效果
### What was done
- 投食与鱼儿进食改用玩水同款正弦衰减、双线性采样折射，振幅取玩水的 45%，移除旧椭圆轮廓。
- 三类波纹共用最多三个活动折射波的额度，保留 500 毫秒点击冷却；特效满额时鱼儿照常进食，仅跳过新增波纹。
### Testing
- node --check assets/koi-pond.js 通过；三组定向 Vitest 测试共 26 项通过，新增投食波纹占用额度及模式切换检查。
- 独立隐藏 Electron 冒烟通过：投食实际像素折射、旧描边消失、投食与进食波纹不超过三个，以及既有密集点击、到期恢复、日夜、禅模式、存档回归。输出目录 C:\Users\karma617\AppData\Local\Temp\dsh-koi-smoke-Qoy8nV。
- git diff --check 通过；未打包、未重启主壳。性能限制不等同于所有硬件帧率保证。
### Notes
- assets/koi-pond.js：统一折射渲染及额度，移除旧描边。
- tests/koi-pond-interaction.spec.mjs：追加投食共享额度测试。
- scripts/smoke-koi-pond.mjs：验证真实投食像素折射和进食额度，隔离残留波纹后测试玩水。
- docs/koi-pond.md：同步效果、振幅与共享额度说明。
- progress.md：仅追加本轮记录，保留上一轮未提交改动。
- 回滚：从 C:\Users\karma617\AppData\Local\Temp\dsh-feed-before-98d1eee6ded34433a13984d2f9bd68b3 使用 Copy-Item -LiteralPath 复制 koi-pond.js 至 assets/koi-pond.js、smoke-koi-pond.mjs 至 scripts/smoke-koi-pond.mjs、koi-pond-interaction.spec.mjs 至 tests/koi-pond-interaction.spec.mjs、koi-pond.md 至 docs/koi-pond.md，均加 -Force；保留本日志。备份包含上一轮连续点击限制。

## 2026-09-08 - Task: 缓解超量读取、编辑冲突和子代理工具误用
### What was done
- read 的有效超量 limit 按部署上限返回一页，统一执行与渲染参数解析；工具说明明确最后实际行号续页规则，保留非法值拒绝和输出预算。
- 扩充共享 TypeScript SDK 指引：分别满足外层/内层必填参数、使用已确认代理 ID、失效 ID 停止重试、唯一上下文编辑及同文件串行操作。
- 扩充解析失败提示，针对 EOF 截断、String.raw 及空字符串 replaceAll；不自动修补或执行不完整代码，不改业务项目，不自动 replace_all，不伪造代理。
### Testing
- 定向 Vitest 17/17 通过：先复现 limit=5000 上限2000的原始异常，再验证封顶、自定义上限、原 offset、非法值、幂等与未知版本保留；新增截断及反斜杠语法复现。
- 实际安装 DSH 0.1.3-alpha.1 隔离模块冒烟通过：四模块匹配/加载、PowerShell、解析失败诊断和核心文件哈希未变；实际 read 对45行合成日志请求5000、上限20时返回20行，下一页21至40，渲染正常，负数拒绝。
- 冒烟首轮检查 schema 的路径用错（parameters.limit），已按实际 defineTool 转换结果修正为 parameters.properties.limit，重新完整通过。
- Node 24 + pnpm test：31文件/229测试通过；pnpm run build（含 tsc --noEmit）退出码0；git diff --check 通过。构建仍有原工具 CJS 与依赖打包提示。
- 未运行真实主/子代理、未重新部署报错机器、未生成安装包或重启现有应用；语法/参数/收件人/编辑指引的在线错误率尚未验证。附件缺少版本及适配日志，不能据此断言旧修复已加载。
### Notes
- src/runtime-tool-compatibility.ts：新增独立读取限额适配及文件工具组合入口，补强共享SDK指引和解析提示。
- tests/runtime-tool-compatibility.spec.ts：新增超量读取及错误代码回归。
- scripts/smoke-runtime-tool-compatibility.mjs：验证实际工具的封顶、续页、schema和渲染。
- docs/runtime-tool-compatibility.md：说明封顶语义、编辑及代理边界和部署验证缺口。
- progress.md：追加本轮记录。
- 回滚：工作区本轮开始为干净状态，可用 git restore -- src/runtime-tool-compatibility.ts tests/runtime-tool-compatibility.spec.ts scripts/smoke-runtime-tool-compatibility.mjs docs/runtime-tool-compatibility.md 恢复本轮前实现，再 pnpm run build；保留 progress.md 历史并追加回滚说明。若之后新增修改，先保存差异，勿直接覆盖。
