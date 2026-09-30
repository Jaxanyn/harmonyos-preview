# harmonyos-preview
面向 AI 编程 Agent 的 HarmonyOS 真机与模拟器实时预览及交互插件。

## 当前状态

已完成真机预览原型：发现设备、构建安装启动、截图轮询、WebSocket 预览和点击操作。

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

## 开发

```powershell
npm run check
npm start
```

启动后访问 `http://127.0.0.1:4100/health`。
