# harmonyos-preview

[![CI](https://github.com/Jaxanyn/harmonyos-preview/actions/workflows/ci.yml/badge.svg)](https://github.com/Jaxanyn/harmonyos-preview/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)

面向 Codex 等 AI 编程 Agent 的 HarmonyOS 真机预览与交互 MCP 插件。它把设备发现、构建安装、控件树、截图、实时预览和受控操作放进同一条工作流。

## 为什么用它

- **看懂页面**：读取 UITest 控件树，按文字、ID、类型和状态查找目标。
- **验证改动**：构建、安装、启动应用，并用新截图和 `wait_for` 验证页面变化。
- **实时预览**：通过 MCP App 或本地 WebSocket 查看设备画面；重复帧不会进入模型上下文，点击后会等待动作产生的新帧。
- **安全操作**：优先按控件重新查询后点击；旧帧、歧义目标、禁用控件和无效坐标会被拒绝。
- **适配断连**：设备短暂离线时保留会话，恢复连接后继续预览。

## 快速开始

需要 Windows、Node.js 20+、DevEco Studio、HDC，以及已授权的 HarmonyOS 真机或已启动的模拟器。

```powershell
hdc list targets
cd "C:\path\to\harmonyos-preview"
.\scripts\install-codex.ps1 -ProjectPath C:\path\to\my-harmonyos-project
codex mcp get harmonyos-preview
```

然后在 Codex 中发送：

```text
启动 C:\path\to\my-harmonyos-project，必要时先构建安装，然后打开实时预览。
```

## Agent 工作流

```text
list_devices
  → preview_info(deviceId)
  → build_run（需要重装时）
  → preview_start
  → preview_frame / capture
  → observe / find
  → tap_element / tap / swipe / input_text
  → wait_for
  → capture
  → preview_stop
```

`preview_panel` 可在当前对话右侧打开 MCP App，支持 Fit、Zoom 和 Fullscreen；普通 `previewUrl` 仍可用于浏览器调试。

## MCP 能力

| 能力 | 工具 | 说明 |
| --- | --- | --- |
| 设备 | `list_devices`, `preview_info` | 发现设备并检查 HDC 连接状态 |
| 构建 | `build_run` | 构建、安装并启动应用 |
| 观察 | `observe`, `find`, `wait_for` | 读取控件树、定位目标、等待页面变化 |
| 截图 | `capture` | 每次重新采集设备画面，返回 `frameId` 和 `capturedAt` |
| 预览 | `preview_start`, `preview_frame`, `preview_stop` | 启动、取帧、恢复和停止实时预览，并返回采集来源、耗时和帧大小指标 |
| 操作 | `tap_element`, `tap`, `swipe`, `long_press`, `key_event`, `input_text` | 按控件或坐标操作设备 |

多模块工程可给 `build_run` 传入 `moduleName`；存在多个可部署 HAP 时传入 `artifactName`。未指定时只自动选择唯一的 `*-signed.hap`。

MCP 请求支持并发；同一设备上的点击、输入、构建和启动按顺序执行。发送 `$/cancelRequest` 或 `notifications/cancelled` 可取消长时间等待、截图和 HDC 子进程。

## 安全边界

- `tap_element` 只点击唯一、可点击、可见、坐标有效且未过期的控件，并且只执行一次。
- `capture` 不复用实时预览缓存；动作后应重新观察、等待并截图。
- WebView、自绘内容或未暴露的控件可能无法通过 UITest 定位。
- 构建、安装、启动和设备操作都会改变设备状态，应在 Agent 获得用户授权后执行。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `HARMONY_PROJECT` | MCP 模式下的 HarmonyOS 工程路径 |
| `HDC` | HDC 可执行文件路径，默认使用 `PATH` 中的 `hdc` |
| `HARMONY_PREVIEW_URL` | 复用已独立启动的预览服务 |
| `HARMONY_PREVIEW_AUTOSTART=1` | 预览服务不可用时自动拉起本机服务 |
| `HARMONY_PREVIEW_HDC_TIMEOUT_MS` | 单次 HDC 命令超时，默认 15000 毫秒 |

完整配置、错误码和恢复流程见 [docs/codex-usage.md](docs/codex-usage.md)。

## 验证

本地回归：

```powershell
npm install
npm run check
npm pack --dry-run --registry=https://registry.npmjs.org/
```

默认只读真机验收：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID
```

需要构建安装时追加 `--build`；多模块工程追加 `--module feature --artifact feature-signed.hap`。需要点击验收时，成对追加 `--tap-selector` 和 `--wait-selector`。

完整验收记录见 [docs/codex-acceptance.md](docs/codex-acceptance.md)。GitHub Actions 会在 push、Pull Request 和每天 UTC 01:00 运行 Node.js 20/22 回归检查；真机流程仍需在授权设备上执行。

## 文档

- [使用说明](docs/codex-usage.md)
- [真机验收清单](docs/codex-acceptance.md)
- [Codex 工作流技能](skills/harmonyos-preview-codex/SKILL.md)
