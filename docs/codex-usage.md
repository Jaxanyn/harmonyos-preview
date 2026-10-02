# Codex 使用说明

## 安装 MCP

推荐先使用安装脚本：

```powershell
.\scripts\install-codex.ps1 -ProjectPath C:\path\to\my-harmonyos-project
```

脚本会检查 Node.js、HDC 和设备，并注册 `harmonyos-preview`。没有连接设备时只给出警告；需要严格要求设备时加上 `-RequireDevice`。已有同名配置不会覆盖，确认替换时使用 `-Force`。

在 PowerShell 中注册本地插件：

```powershell
codex mcp add harmonyos-preview `
  --env HARMONY_PROJECT=C:\path\to\my-harmonyos-project `
  -- node "C:\path\to\harmonyos-preview\bin\harmonyos-preview.mjs" --mcp
```

如需让预览服务独立于 MCP 进程运行，先启动：

```powershell
node bin/harmonyos-preview.mjs --project C:\path\to\my-harmonyos-project
```

再在 MCP 注册命令中增加：

```text
--env HARMONY_PREVIEW_URL=http://127.0.0.1:4100
```

注册后重启 Codex 或刷新 MCP 工具列表。插件进程只监听本机地址，预览服务的端口由 MCP 进程自动分配。

## 标准使用流程

1. 让 Agent 调用 `list_devices`，确认 HDC 已发现鸿蒙真机或模拟器。
2. 需要重新安装应用时，让 Agent 调用 `build_run`。
3. 调用 `preview_start`，记录返回的 `sessionId` 和 `previewUrl`。
4. 在 Codex 浏览器或面板打开 `previewUrl`，页面会自动选中目标设备并开始轮询，随后显示设备画面和交互控件。
5. Agent 使用 `capture` 获取 MCP 图片，用 `tap`、`swipe`、`long_press` 和 `input_text` 操作设备。
6. 完成后调用 `preview_stop`，并传入原来的 `sessionId`。

推荐提示词：

```text
启动 HarmonyOS 项目，打开鸿蒙真机实时预览，点击主操作按钮并确认画面变化。
```

## 返回结果

`preview_start` 返回：

- `sessionId`：当前预览会话编号
- `deviceId`：设备 ID
- `previewUrl`：浏览器预览页面
- `wsUrl`：WebSocket 地址
- `connected`：是否已收到设备截图
- `pollMs`：截图轮询间隔

`capture` 返回 MCP 图片，同时返回结构化元数据：

```json
{
  "deviceId": "设备 ID",
  "live": true,
  "sessionId": "预览会话编号"
}
```

## 常见问题

- 没有设备：检查 DevEco Studio、HDC 路径和设备授权状态。
- `connected: false`：设备可能暂时断开；不要使用旧截图坐标，恢复后重新 `capture`。
- 预览页面无法打开：确认 MCP 进程仍在运行，并使用最新的 `previewUrl`；不要手动拼接设备参数。
- 只想截图：可以直接调用 `capture`，不必启动实时预览。

`SKILL.md` 是 Codex 工作流提示文件；真正注册设备工具的是 MCP 命令。MCP 插件返回可直接打开的 `previewUrl`，但不会自行注入 Codex 固定侧边栏。
