# Northstar Supply 独立 Demo

这是一个与 Showit 产品本身无关的普通 HTTP 业务系统示例，用来模拟真实客户业务页。

它不引用 `apps/extension`、`apps/relay` 或 Showit 内部 Demo 组件，也不需要安装 Showit 才能启动。

## 启动

在仓库根目录执行：

```bash
npm ci
npm run demo:dev
```

服务地址：`http://127.0.0.1:3001`

## 演示账号

账号和密码只要非空即可登录。页面会把登录状态保存在当前浏览器会话的 `sessionStorage` 中，关闭浏览器后自动清除。

## 导入 Showit

在 Showit 项目库中导入本目录的 `Northstar_Supply_Demo.showit`，再运行该项目。项目连接器指向 `http://127.0.0.1:3001`，包含登录、敏感密码、运营概览和库存管理步骤。

## 构建

```bash
npm run demo:build
npm run demo:preview
```

Demo 的业务页面可以被 Showit 的真实标签页连接器捕获；远程观众只接收 Showit 源端合成后的像素流，不会直接访问这个 Demo 地址。
