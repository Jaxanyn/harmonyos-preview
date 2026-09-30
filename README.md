# harmonyos-preview

面向 Codex 等 AI 编程 Agent 的 HarmonyOS 真机与模拟器预览插件。通过 MCP 完成构建、启动、截图和触控操作。

[![CI](https://github.com/Jaxanyn/harmonyos-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/Jaxanyn/harmonyos-preview/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-5b5bd6)](https://modelcontextprotocol.io/)

## 能力

- 读取已连接的鸿蒙设备或模拟器。
- 构建、安装并启动 HarmonyOS 应用。
- 返回 MCP 图片格式的设备截图。
- 在浏览器页面中实时查看设备画面。
- 执行点击、滑动、长按、按键和文本输入。
- 设备断开后自动重试，重连后继续预览。

## 工作方式

```text
Codex Agent
    │ MCP stdio
    ▼
harmonyos-preview
    │ HDC
    ▼
HarmonyOS 真机或模拟器
    │ 截图轮询
    ├── MCP 图片结果
    └── WebSocket 浏览器预览页面
```

插件默认只监听本机地址。`preview_start` 返回的页面会根据 `deviceId` 自动选择设备并开始轮询。

## 前置条件

1. Windows 和 Node.js 20 或更高版本。
2. DevEco Studio 与 HDC，HDC 可通过 `PATH` 或 `HDC` 环境变量提供。
3. 已授权的 HarmonyOS 真机或已启动的鸿蒙模拟器。
4. 可独立构建的 HarmonyOS 工程，提供 `build-local.ps1` 或支持 `devecocli`。

确认 HDC 能发现设备：

```powershell
hdc list targets
```

## 在 Codex 中安装

从源码目录执行安装脚本：

```powershell
cd "C:\path\to\harmonyos-preview"

.\scripts\install-codex.ps1 `
  -ProjectPath C:\path\to\my-harmonyos-project
```

脚本会检查 Node.js、HDC 和设备，并注册 `harmonyos-preview` MCP 服务。没有设备时只警告；需要严格检查设备时加上 `-RequireDevice`。已有配置不会覆盖，替换时使用 `-Force`。

确认注册结果：

```powershell
codex mcp get harmonyos-preview
```

## 快速开始

在 Codex 中发送：

```text
请使用 harmonyos-preview 启动 C:\path\to\my-harmonyos-project，必要时先构建安装，然后打开实时预览并保持运行。
```

Agent 会按以下顺序调用工具：

```text
list_devices
    → build_run（需要构建时）
    → preview_start
    → 打开 previewUrl
    → capture / tap / swipe / input_text
    → preview_stop
```

`preview_start` 返回带设备参数的 `previewUrl`。打开后，页面会自动选择设备并开始轮询，也支持直接点击和拖动。

## npm 安装

发布 npm 包后，可以全局安装：

```powershell
npm install --global harmonyos-preview --registry=https://registry.npmjs.org/
harmonyos-preview --help
```

使用全局命令注册 Codex MCP：

```powershell
codex mcp add harmonyos-preview `
  --env HARMONY_PROJECT=C:\path\to\my-harmonyos-project `
  -- harmonyos-preview --mcp
```

也可以安装本地打包文件：

```powershell
npm pack
npm install --global .\harmonyos-preview-0.1.0.tgz
```

## MCP 工具

| 工具 | 作用 |
| --- | --- |
| `list_devices` | 列出已连接的 HarmonyOS 设备。 |
| `build_run` | 构建项目、安装 HAP 并启动应用。 |
| `preview_start` | 启动截图轮询并返回预览会话。 |
| `preview_info` | 返回预览地址、设备和会话状态。 |
| `capture` | 返回 MCP 图片和截图元数据。 |
| `tap` | 点击设备坐标。 |
| `swipe` | 在两个坐标之间滑动。 |
| `long_press` | 长按设备坐标。 |
| `key_event` | 发送 `Back`、`Home` 或 `Power`。 |
| `input_text` | 向焦点输入框或指定坐标输入文本。 |
| `preview_stop` | 停止当前预览会话。 |

stdio 模式只向 stdout 输出 JSON-RPC 消息，预览页面由本机 HTTP/WebSocket 服务承载。

## 预览会话

`preview_start` 收到首帧后返回：

- `sessionId`：当前预览会话编号。
- `deviceId`：设备 ID。
- `previewUrl`：带设备参数的浏览器预览地址。
- `serverUrl`：预览服务根地址。
- `wsUrl`：WebSocket 地址。
- `pollMs`：截图轮询间隔。
- `running` 和 `connected`：会话与设备截图状态。
- `capabilities`：当前可用的 MCP 工具名。

同一设备重复启动会复用活动会话。切换设备会关闭旧会话并创建新的 `sessionId`。停止时传入原会话的 `sessionId`，避免旧指令停止新会话。

设备离线时，会话保留并报告 `connected: false`。收到新截图后恢复在线，离线期间的 `capture` 不返回旧帧。

## 配置项

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HARMONY_PROJECT` | 无 | HarmonyOS 工程路径。MCP 模式下必填。 |
| `HDC` | `hdc` | HDC 可执行文件路径。 |
| `HARMONY_PREVIEW_HOST` | `127.0.0.1` | 独立服务模式的 HTTP 监听地址。MCP 模式固定监听 `127.0.0.1`。 |
| `HARMONY_PREVIEW_PORT` | `4100` | HTTP 服务端口。MCP 模式下可设为 `0` 自动分配。 |
| `HARMONY_PREVIEW_POLL_MS` | `500` | 截图轮询间隔，最小 100 毫秒。 |
| `HARMONY_PREVIEW_BUILD_TIMEOUT_MS` | `300000` | 构建超时时间，单位为毫秒。 |
| `HARMONY_PREVIEW_ORIGIN` | 自动校验本机 Origin | 自定义允许的 HTTP/WebSocket Origin。 |

## 独立启动预览页面

不使用 MCP 时，直接启动本地服务：

```powershell
$env:HARMONY_PROJECT = 'C:\path\to\my-harmonyos-project'
node bin/harmonyos-preview.mjs --project 'C:\path\to\my-harmonyos-project'
```

打开以下地址，把设备 ID 替换为实际值：

```text
http://127.0.0.1:4100/?deviceId=DEVICE_ID
```

服务启动后也可以检查健康状态：

```powershell
Invoke-RestMethod http://127.0.0.1:4100/health
```

## 真机验收

该命令验证设备发现、MCP、预览地址、截图和会话停止，默认不构建或安装应用：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID
```

需要验证构建、安装和启动时，确认设备可以修改后追加 `--build`：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID `
  --build
```

## 故障排查

**`hdc list targets` 没有设备**

确认设备已连接、开启 USB 调试并完成授权。模拟器需要先在 DevEco Studio 中启动。

**`preview_start` 等待首帧超时**

调用 `list_devices` 确认设备仍在列表中。刚重连时，等待一轮截图后再调用 `capture`。

**预览页面显示连接但没有设备画面**

确认打开的是最新的 `previewUrl`，不要修改其中的 `deviceId` 参数。

**构建失败**

检查 `HARMONY_PROJECT` 是否指向工程根目录，确认 `build-local.ps1` 或 `devecocli` 能独立构建，并检查 HAP 输出路径。

## 开发与检查

```powershell
npm install
npm run check
npm pack --dry-run --registry=https://registry.npmjs.org/
```

真实设备验收清单见 [docs/codex-acceptance.md](docs/codex-acceptance.md)，Codex 工作流说明见 [docs/codex-usage.md](docs/codex-usage.md)。

## 当前范围

当前版本聚焦 Codex 的 MCP 接入和本地实时预览。预览画面通过返回的本地 URL 打开，暂不包含 Codex 固定原生侧边栏。插件核心使用 Node.js、MCP stdio、HDC、HTTP 和 WebSocket，不要求额外的桌面服务。

## 相关项目

- [dsh-android](https://github.com/ZSeven-W/dsh-android)，Android 真机和模拟器预览插件。
- [mobilecode](https://github.com/hsandhu/mobilecode)，面向移动项目的 Agent 编程环境。
