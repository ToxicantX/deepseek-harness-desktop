# 桌面壳主题安装

## 客户端入口解析

主题包安装时，桌面壳会先解析 `package.json` 中 `exports["./client"]` 的条件导出，支持字符串、条件对象和回退数组。

如果清单没有声明客户端子路径，会按以下包内路径依次查找：

1. `lib/plugin/dist/client.js`
2. `lib/client.js`
3. `plugin/dist/client.js`
4. `plugin/client.js`
5. `dist/client.js`
6. `client.js`

找到入口后，桌面壳会读取 bundle，并继续校验其是否包含标准 ModuleLoader 注入入口。入口路径必须位于主题包目录内。

## 验证

```powershell
pnpm exec vitest run tests/shell-skin-store.spec.ts --maxWorkers=1 --testTimeout=20000
pnpm run typecheck
pnpm run build
```
