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
