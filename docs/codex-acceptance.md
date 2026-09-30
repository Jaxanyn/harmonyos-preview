# Codex 验收

## 环境检查

先确认 MCP 已注册：

```powershell
codex mcp get harmonyos-preview
```

确认设备和项目：

```powershell
.\scripts\install-codex.ps1 `
  -ProjectPath C:\path\to\my-harmonyos-project `
  -RequireDevice `
  -CheckOnly
```

## 不构建的链路验收

该命令只验证当前工程、HDC、MCP、预览地址和截图，不会安装或启动应用：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID
```

通过时输出 `check: codex: ok`，并包含截图字节数和预览会话编号。

## 包含构建的验收

确认用户允许修改设备应用后，再运行：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID `
  --build
```

它会增加构建、安装和启动步骤，耗时取决于 DevEco 构建环境。

## Codex 画面验收

1. Agent 调用 `preview_start`。
2. 在 Codex 中打开返回的 `previewUrl`。
3. 页面自动选择目标设备并开始轮询。
4. 调用 `capture`，确认出现 MCP 图片。
5. 调用 `tap` 或 `swipe`，确认设备画面变化。
6. 调用 `preview_stop`，确认会话结束。

当前验收确认的是 MCP 和预览页面链路；固定侧边栏仍由 Codex 宿主的 UI 能力决定。
