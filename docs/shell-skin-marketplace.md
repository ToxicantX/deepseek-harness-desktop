# 桌面壳主题安装

## 客户端入口解析

主题包安装时，桌面壳会先解析 `package.json` 中 `exports["./client"]` 的条件导出，支持字符串、条件对象和回退数组。

`package.json` 以 UTF-8 读取，并允许文件开头带 BOM（`U+FEFF`），避免合法清单因编码标记解析失败。

如果清单没有声明客户端子路径，会按以下包内路径依次查找：

1. `lib/plugin/dist/client.js`
2. `lib/client.js`
3. `plugin/dist/client.js`
4. `plugin/client.js`
5. `dist/client.js`
6. `client.js`

找到入口后，桌面壳会读取 bundle，并继续校验其是否包含标准 ModuleLoader 注入入口。入口路径必须位于主题包目录内。

## 源码仓库未提交构建产物

如果市场锁定的 Git commit 中声明了客户端入口，但仓库没有提交对应 bundle，桌面壳会尝试读取同名、同版本的 npm 构建包。该回退只接受以下条件同时成立的产物：

1. npm 元数据中的 `name` 和 `version` 与市场目录一致。
2. npm 元数据中的 `gitHead` 与市场锁定 commit 完全一致。
3. 下载地址来自 npm 官方 registry，且 tarball 通过元数据声明的 SHA-512 校验。
4. 解包后的 `package.json` 仍通过包名、版本和 `dsh.client` 校验，并能解析出标准 ModuleLoader bundle。

桌面壳只解包 npm 已构建产物，不运行主题包的 `prepare`、`prepack` 或其他生命周期脚本。如果 npm 产物与锁定 commit 不匹配，安装会保留失败状态，而不使用未锁定的构建结果。

## 客户端多语言兼容

桌面壳的客户端适配上下文支持 `locale.register(namespace, dictionaries)` 和 `locale.bind(namespace)`。翻译函数会按当前语言、主语言代码和英文的顺序回退，例如 `zh-CN` 会命中 `zh` 字典；同时支持 `{name}` 形式的参数替换。注册返回的销毁函数会在皮肤停用时恢复之前的字典状态。

## 验证

```powershell
pnpm exec vitest run tests/shell-skin-store.spec.ts --maxWorkers=1 --testTimeout=20000
pnpm run typecheck
pnpm run build
```
