# harmonyos-preview
面向 AI 编程 Agent 的 HarmonyOS 真机与模拟器实时预览及交互插件。

## 当前状态

已完成真机预览原型：发现设备、构建安装启动、截图轮询、WebSocket 预览和点击操作。

预览会话支持设备列表刷新和断线重试：设备暂时离线时保留会话，设备重新连接后自动恢复截图轮询；多个连接设备可在预览页下拉框中切换。

轮询间隔可通过 HARMONY_PREVIEW_POLL_MS 配置，最小为 100ms；相同截图不会重复发送，只发送 preview-tick 的 changed: false 状态。

## Agent 接口

启动 Host 时设置 `HARMONY_PROJECT` 指向 HarmonyOS 工程：

```powershell
$env:HARMONY_PROJECT = 'C:\path\to\my-harmonyos-project'
npm start
```

Agent 可先读取 `GET /api/capabilities`，再使用：

- `GET /api/devices`：列出设备
- `POST /api/capture`：请求体 `{ "deviceId": "..." }`，返回 Base64 JPEG
- `POST /api/tap`：请求体 `{ "deviceId": "...", "x": 1, "y": 2 }`
- WebSocket `/preview`：使用 `device-list`、`screenshot`、`tap`、`preview-start`、`preview-stop`、`build-run`

## 插件入口

本地安装依赖后可通过 CLI 启动：

```powershell
node bin/harmonyos-preview.mjs --project 'C:\path\to\my-harmonyos-project'
```

以后发布为 npm 包后，入口命令名为 `harmonyos-preview`。

生成本地安装包并安装：

```powershell
npm pack
npm install --global .\harmonyos-preview-0.1.0.tgz
harmonyos-preview --help
```

`npm run package-check` 会检查安装包只包含运行所需的 README、CLI 和源码目录。

## MCP 接入

支持 MCP 的 Agent 可通过 stdio 启动插件：

```powershell
codex mcp add harmonyos-preview --env HARMONY_PROJECT=C:\path\to\my-harmonyos-project -- node "C:\path\to\harmonyos-preview\bin\harmonyos-preview.mjs" --mcp
```

MCP 工具：

- `list_devices`：列出连接的鸿蒙设备
- `capture`：返回设备截图
- `tap`：点击设备坐标
- `swipe`：在两个坐标之间滑动
- `long_press`：长按设备坐标
- `key_event`：发送 Back、Home 或 Power
- `input_text`：向焦点输入框或指定坐标输入文本
- `preview_start`：启动 MCP 内部实时截图轮询
- `preview_stop`：停止 MCP 内部实时截图轮询
- `build_run`：构建、安装并启动工程
- `preview_info`：返回 Codex 浏览器中打开的实时预览地址

stdio 模式只向 stdout 输出 JSON-RPC 消息，预览网页仍由本机 HTTP/WebSocket 服务承载。

## 开发

```powershell
npm run check
npm start
```

启动后访问 `http://127.0.0.1:4100/health`。
