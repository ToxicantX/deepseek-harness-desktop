# DSH 文件资源管理器打开兼容

DSH `0.1.3-alpha.2` 的会话“打开”菜单会通过 Runtime 后端启动本机应用。在部分 Windows 桌面壳环境中，文件资源管理器启动命令会返回 `502 launch-failed`。

桌面壳只接管 `explorer` 选项：客户端仍使用 DSH 原有菜单与应用探测，点击文件资源管理器时改由 Electron 主进程的 `shell.openPath()` 打开目录。Cursor、VS Code、Android Studio、Git Bash 等其他选项继续使用 DSH 原生 `/open-in-app/open` 路由。

主进程仅接受已就绪 DSH 主窗口主 frame 的请求，并再次校验参数为无 NUL 的绝对路径、目标真实存在且为目录。上游客户端结构不匹配时，兼容注入保持原行为，不阻塞 Runtime 页面加载。
