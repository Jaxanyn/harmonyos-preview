# harmonyos-preview
面向 AI 编程 Agent 的 HarmonyOS 真机与模拟器实时预览及交互插件。

CI 在 Windows runner 上使用 Node.js 20 和 22 执行完整检查，并验证本地 npm 安装包清单。

## 当前状态

已完成真机预览原型：发现设备、构建安装启动、截图轮询、WebSocket 预览和点击操作。

预览会话支持设备列表刷新和断线重试：设备暂时离线时保留会话，设备重新连接后自动恢复截图轮询；多个连接设备可在预览页下拉框中切换。

轮询间隔可通过 HARMONY_PREVIEW_POLL_MS 配置，最小为 100ms；相同截图不会重复发送，只发送 preview-tick 的 changed: false 状态。

本地服务默认只监听 127.0.0.1，HTTP/WebSocket 会拒绝非本机 Origin，请求体上限为 1 MiB；构建超时可通过 HARMONY_PREVIEW_BUILD_TIMEOUT_MS 配置，默认 5 分钟。

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
- `capture`：返回 MCP 图片内容；预览在线时复用最近一帧
- `tap`：点击设备坐标
- `swipe`：在两个坐标之间滑动
- `long_press`：长按设备坐标
- `key_event`：发送 Back、Home 或 Power
- `input_text`：向焦点输入框或指定坐标输入文本
- `preview_start`：启动 MCP 内部实时截图轮询；相同设备重复启动复用会话
- `preview_stop`：停止 MCP 内部实时截图轮询，可传入 `sessionId` 防止停止新会话
- `build_run`：构建、安装并启动工程
- `preview_info`：返回预览地址、当前会话和设备连接状态

stdio 模式只向 stdout 输出 JSON-RPC 消息，预览网页仍由本机 HTTP/WebSocket 服务承载。

`preview_start` 在收到首帧后返回 `sessionId`、`deviceId`、`previewUrl`、`wsUrl`、`pollMs`、`running`、`connected` 和 `capabilities`。首帧等待超过 10 秒会返回工具错误并清理会话，检查设备连接后可重试。切换设备会关闭旧会话并创建新的会话编号。

MCP 文本结果同时提供 `structuredContent`；截图结果提供图片内容和 `{ deviceId, live, sessionId }` 结构化元数据，Agent 不需要解析文本 JSON 才能识别当前设备和会话。

`preview_info` 没有活动会话时返回 `running: false`，会话、设备和轮询间隔为 `null`。设备暂时离线时保留活动会话并返回 `connected: false`，`capture` 会尝试获取新截图，避免返回离线前的缓存图片。

当前 `previewUrl` 指向独立的浏览器预览页面，仍需要选择设备并点击 Start preview；MCP 会话不会自动打开 Codex 面板或启动浏览器的轮询。这部分属于后续 Codex 工作流适配。

Codex 工作流文件位于 `skills/harmonyos-preview-codex/SKILL.md`，完整安装和使用说明位于 `docs/codex-usage.md`。它们会随 npm 包一起提供；MCP 注册仍使用上面的 `codex mcp add` 命令。

## 开发

```powershell
npm run check
npm start
```

启动后访问 `http://127.0.0.1:4100/health`。
