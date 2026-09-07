# Windows 构建工具发现

构建脚本首先查找 PATH 中的 pnpm；缺失时读取所选 DSH Runtime 的 `runtime-manifest.json`，使用 `paths.pnpm` 指定的工具。没有有效 Manifest 路径时，检查已有的两种 `tools` 布局，最后尝试 Corepack。

发现 Runtime pnpm 后，版本检查和后续构建命令均通过带引号的绝对路径执行，不再通过第二次 `where pnpm` 决定它是否可用。其目录仍加入当前脚本的 PATH，供子进程使用；系统环境变量不受影响。

出现“using DSH Runtime pnpm”后仍提示未找到 pnpm，是旧脚本重复依赖命令发现的缺陷。更新仓库中的构建脚本后重试。版本不匹配仍会停止构建，要求与 `package.json` 中的 `packageManager` 一致。

回归验证执行真实 Windows CMD 下的工具发现、版本检查及模拟安装调用，覆盖带空格的 Runtime 路径和 PATH 工具缺失；不执行实际依赖安装或打包。目标电脑的完整构建仍需现场复验。

Windows PowerShell 优先使用 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，系统位置缺失时再通过系统目录中的 `where.exe` 查找 PATH。启动检查与两处输出目录准备命令使用同一个绝对路径，不要求 PowerShell 目录已加入 PATH。若文件缺失或启动检查失败，脚本会在安装依赖前停止并输出检查路径。回归测试在清空工具 PATH 后实际启动系统 PowerShell。

通过启动检查后，脚本也将该 PowerShell 所在目录加入当前进程的 PATH，让 electron-builder 等子进程通过 `powershell.exe` 名称启动它。此设置只在本次构建及其子进程中生效，不修改系统 PATH；回归测试覆盖 Node 子进程按名称启动 PowerShell，避免只验证脚本自身的绝对路径调用。

源码回退测试中的“预构建包返回 404”用例使用模拟下载和模拟构建，但真实创建、写入、重命名与清理临时 Runtime 目录。该用例在另一台 Windows 电脑触及默认 5 秒限制，因此单独设置 20 秒上限；其他测试超时、构建流程和断言保持原样。此调整只增加该测试的执行时间预算，不代表已确认目标电脑耗时的具体原因，也不跳过失败测试。
