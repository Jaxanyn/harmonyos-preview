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

需要 MCP 在服务不可用时自动拉起本机预览服务时，再增加 `--env HARMONY_PREVIEW_AUTOSTART=1`。安装脚本也支持 `-AutoStartPreview`。

注册后重启 Codex 或刷新 MCP 工具列表。插件进程只监听本机地址，预览服务的端口由 MCP 进程自动分配。

升级后新增的 `tap_element` 需要宿主重新连接 MCP 才能加载。已有只读验收通过时，使用新工具前确认它已出现在工具列表即可，无需重复此前已经完成的只读验收。

## 固定到 Codex 侧边栏

当前 MCP 服务提供 `preview_open` Global Entrypoint 和 `ui://harmonyos-preview/app` MCP App 资源。完成注册后：

1. 刷新 MCP 工具列表或重启 Codex Desktop。
2. 在侧边栏的“···”菜单中找到 HarmonyOS Preview。
3. 选择“固定到侧边栏”。
4. 打开面板，选择设备并启动预览；面板首次请求实时帧时才开始 HDC 截图流。

侧边栏面板通过 MCP App Bridge 调用设备工具，普通 `previewUrl` 页面仍可用于浏览器调试。固定动作由 Codex 用户界面执行，MCP 服务不能替用户强制固定。

## 标准使用流程

### 在当前对话右侧显示

`preview_panel` 提供 Thread Entrypoint，标题为“鸿蒙真机预览”。重启 Codex 后，可以从当前对话的面板入口打开这个标签。也可以让 Agent 调用 `preview_panel`；具体首次展示位置由宿主决定。若工具结果先显示在聊天中，通过宿主的展开操作打开面板。

打开后保持该标签即可在当前对话旁使用；入口本身不保证切换对话或重启后继续显示，也不能强制宿主固定。左侧的 `preview_open` Global Entrypoint 仍用于全局导航。

提示词：`在当前对话右侧打开鸿蒙真机预览，调用 preview_panel。`

### 设备操作

1. 让 Agent 调用 `list_devices`，确认 HDC 已发现鸿蒙真机或模拟器。
2. 需要重新安装应用时，让 Agent 调用 `build_run`。默认选择 `entry` 模块；多模块工程可传入 `moduleName`，当该模块生成多个可部署 HAP 时同时传入 `artifactName`，例如 `{"deviceId":"设备 ID","moduleName":"feature","artifactName":"feature-signed.hap"}`。未显式选择时，插件只会自动选择唯一的 `*-signed.hap`；多个签名产物仍返回构建产物歧义错误并停止安装。
3. 调用 `preview_start`，记录返回的 `sessionId` 和 `previewUrl`。
4. 使用 Codex 宿主的浏览器面板动作打开 `previewUrl`，位置设为 `right`；MCP App 通过 `preview_frame(afterSeq)` 获取实时画面，重复帧不会再次渲染。
5. Agent 使用 `observe` / `find` 读取页面和定位目标；用户已授权点击时优先用 `tap_element` 重新检查并点击目标。右侧面板自身的点击和拖动使用 App-only `preview_action`，模型仍使用 `tap` / `swipe` / `tap_element`。
6. 面板约 5 秒没有请求新帧时，HDC 采集会自动暂停；重新请求 `preview_frame` 会在原 `sessionId` 上恢复。
7. 完成后调用 `preview_stop`，并传入原来的 `sessionId`。

MCP 请求可以并发处理；同一设备上的点击、输入、构建和启动会按到达顺序排队，读取和等待请求可以继续返回。客户端取消长时间请求时发送 `$/cancelRequest`（`params.requestId`）或 `notifications/cancelled`，服务会中止等待、截图和当前 HDC 子进程，并返回 JSON-RPC `-32800`。连接关闭也会取消未完成请求；设备临时文件仍会执行有界清理。

使用独立预览服务时，MCP 会把会话写入 `.runtime/preview-session.json`。新建 Codex 页面后先调用 `preview_info`；如果返回 `restored: true`，直接使用其中的 `previewUrl`，通过 Codex 宿主浏览器面板动作以 `right` 位置恢复页面。

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
- `restored`：是否从独立预览服务的状态文件恢复
- `pollMs`：截图轮询间隔

`preview_frame` 是 MCP App 专用的实时帧接口，参数 `afterSeq` 用于去重，动作后的读取可传 `waitMs` 等待下一个新帧。结构化结果中的 `metrics` 提供 `source`、`captureMs`、`frameBytes`、`capturedAt`、`width`、`height`、`deviceWidth` 和 `deviceHeight`，面板还会显示本地 `renderMs`；`preview_action` 返回 `actionMs`、`frameSeq` 和 `nextFrameAfterSeq`，用于判断点击响应瓶颈并跳过动作前帧。它返回 `content: []`，图片只放在结构化结果中，不进入模型上下文。`capture` 仍然每次重新采集设备画面，适合模型在动作后取得独立证据。

面板动作开始时会优先中止正在进行的预览 JPEG 采集，并在 HDC 输入启动后提前准备下一帧；动作完成后会再次刷新，`nextFrameAfterSeq` 用于跳过可能早于动作完成的帧。预览首帧用于推导设备尺寸，后续 JPEG 默认按一半分辨率采集，面板坐标会映射回设备原始像素；旧版预览服务不支持该握手时会自动回退到原动作路径。

模型调用 `tap`、`tap_element`、`swipe`、`long_press`、`key_event` 或 `input_text` 成功后，也会立即刷新正在运行的实时预览，减少等待下一轮轮询的时间。

可用 `npm run benchmark:preview -- --device <设备 ID> --actions 3` 重复执行真机预览点击基准，输出每次动作耗时、采集耗时、帧大小和分辨率。`--x`、`--y` 可指定测试坐标，默认使用 `1,1`。

### 连接自检与错误证据

调用 `preview_info` 可读取 `runtime`：`serverVersion`、`diagnosticsVersion`（当前为 `1`）、`startedAt` 和 `instanceId`。`instanceId` 在同一次 MCP 服务启动期间保持不变，重启后更换；它标识当前调用连到的 MCP 实例，不代表外部 HTTP 预览服务或宿主缓存已更新。

不传 `deviceId` 时，`deviceCheck.status` 为 `not_checked`，不主动探测设备。传入 `{"deviceId":"目标设备"}` 后，只读查询 HDC 目标列表，返回 `connected`、`disconnected` 或 `error`。自检失败记录在 `deviceCheck` 内；读取 `preview_info` 本身成功也应继续检查该状态和错误码。原有 `connected` 字段仍表示实时预览是否已收到设备帧，不能替代 `deviceCheck`；没有启动预览时，设备在线也可能返回 `connected: false`。

独立预览服务检查或恢复失败时，`preview_info` 仍保留 `runtime` 与设备自检结果，另用 `serviceDiagnostic` 记录服务错误；验收脚本保留该具体错误，不改写成 `MCP_OUTDATED`。

工具执行失败保留 MCP `isError: true` 与 `error` 文本，结构化结果统一包含 `errorCode`、`stage`、`deviceId`、`elapsedMs` 和 `cause`。设备未知时 `deviceId` 为 `null`；`stage` 指明失败环节，`cause` 保留原始消息及可用的系统错误码或退出码。按错误码判断下一步，不依赖错误文案匹配：

| 环节 | 错误码与含义 |
| --- | --- |
| 设备与 HDC | `DEVICE_OFFLINE` 仅在目标列表确认设备不在线时使用；`HDC_UNAVAILABLE` 表示无法调用 HDC，`HDC_TIMEOUT` 表示命令超时 |
| 页面读取与等待 | `LAYOUT_UNAVAILABLE` 表示控件树不可读；`WAIT_TIMEOUT` 表示等待条件未在期限内满足 |
| 截图 | `CAPTURE_FAILED` 表示截图采集失败 |
| 会话与操作 | `STATE_WRITE_FAILED` 表示会话状态写入失败；`ACTION_FAILED`、`BUILD_FAILED` 分别表示设备动作与构建链路失败 |
| 验收能力 | `MCP_OUTDATED` 表示缺少所需工具或当前诊断契约，不能据此判断设备故障 |

读取或等待失败后的截图只是辅助证据，不替换主错误。成功补图保留 `screenshot` 中的 `frameId`、`capturedAt` 等新截图元数据；补图失败保留 `screenshotError`，并增加 `screenshotDiagnostic`。例如 `wait_for` 的主错误仍可为 `WAIT_TIMEOUT`，同时 `screenshotDiagnostic.errorCode` 为 `CAPTURE_FAILED`。先检查现有证据，再决定下一步；不会因诊断结果自动重复点击或输入。

HTTP 设备请求失败和 WebSocket `error` 消息也保留上述诊断字段；轮询失败的 `preview-status` 通过 `diagnostic` 附带原因。只有已确认的 `DEVICE_OFFLINE` 使用 `reason: "device-disconnected"`，其他截图异常使用 `capture-failed`，不能仅凭截图失败断定设备离线。

`capture` 每次都重新采集设备画面，不返回实时预览的缓存。调用应在动作完成后进行；页面异步加载或动画仍可能尚未完成，需根据新画面继续判断。

`capture` 返回 MCP 图片，同时返回结构化元数据：

```json
{
  "deviceId": "设备 ID",
  "live": false,
  "sessionId": null,
  "frameId": "本次采集编号",
  "capturedAt": "2026-10-26T00:00:00.000Z"
}
```

### 页面读取和目标查询

`observe` 参数为 `deviceId`、可选 `bundleName` 和 `maxNodes`（默认 200，上限 1000）。它通过 `uitest dumpLayout` 读取当前控件树，返回 `nodes`、`totalNodes`、`truncated` 和 `observedAt`。节点包含可用的文字、ID、类型、状态、边界和中心坐标。

`find` 参数为 `deviceId`、`selector`、可选 `bundleName` 和 `limit`（默认 20，上限 100）。`selector` 至少包含一个条件：`text`、`textContains`、`id`、`type`、`clickable` 或 `enabled`。条件按 AND 匹配；除 `textContains` 外均精确匹配。结果中的 `matches` 是候选节点数组，`totalMatches` 是匹配总数，`truncated` 表示候选列表被限制。

例如先调用 `find`，参数为 `{"deviceId":"目标设备","selector":{"text":"搜索","clickable":true}}`，查看候选是否属于当前目标。`find` 不自动点击；用户已授权点击时，将选择器交给 `tap_element`，由它重新查询当前页面并检查目标。重名控件不会被自动选中。

空树、截断的 `observe` 和没有匹配的 `find` 会附带新截图；布局读取失败也会尝试附图，并保留 `isError: true` 与主错误诊断。若截图也失败，结构化结果包含 `screenshotError` 和 `screenshotDiagnostic`。控件树只反映 UITest 暴露的内容，WebView、自绘或受保护内容可能缺失；空结果、节点数量及截断标记不能证明业务页面或列表完整。基础定位不提供跨页面稳定的元素句柄；导航、滚动或旋转后重新读取。

### 按控件点击

`tap_element` 必填 `deviceId` 和 `selector`，可选 `bundleName`。选择器与 `find` 一致，所有条件按 AND 匹配。例如用户已授权点击提交按钮时，调用：`{"deviceId":"目标设备","selector":{"id":"submit","clickable":true,"enabled":true}}`。

工具内部重新读取控件树，以 `limit: 2` 返回候选，但用全树的匹配总数判断是否唯一；只有唯一匹配、`clickable: true`、未明确禁用或隐藏、`bounds` 与 `center` 有效，且 `observedAt` 距点击检查为 0–1000 毫秒时，才发送一次点击。不会复用上次 `find` 的坐标，也不会自动重试。

预检拒绝分别返回 `ELEMENT_NOT_FOUND`（没有匹配）、`ELEMENT_AMBIGUOUS`（多个匹配）、`ELEMENT_NOT_ACTIONABLE`（不可点击或几何无效）、`STALE_OBSERVATION`（采样无效或过期），不发出点击；布局读取或 HDC 失败保留原错误码。MCP 会尝试补充新截图，补图错误另记。若实际点击命令失败或超时，动作可能已经生效，应先重新观察，不能自动再点一次。

成功返回 `deviceId`、`selector`、`observedAt`、`target`、`action: "tap"` 和 `verified: false`。这只确认点击命令执行完成；继续调用 `wait_for` 等待预期控件或文字，再用 `capture` 查看新画面。控件树读取与点击之间页面仍可能变化，此工具不能原子消除 UI 竞态，也不解决 UITest 未暴露的自绘内容；原有 `tap` 仍用于用户已授权、以新截图判断的坐标点击。

### 等待页面变化

`wait_for` 读取当前控件树并等待条件满足，不会自动点击。必填参数为 `deviceId` 和 `selector`；可选 `bundleName`。`selector` 复用 `find` 的 AND 条件。`state` 为 `present`（默认）或 `absent`；`timeoutMs` 为 1–30000 的整数，默认 5000；`intervalMs` 为 100–5000 的整数，默认 500，单位均为毫秒。

例如提交后等待文字更新：

1. 用户已授权点击时，调用 `tap_element`：`{"deviceId":"目标设备","selector":{"id":"submit","clickable":true,"enabled":true}}`。
2. 点击成功后调用 `wait_for`：`{"deviceId":"目标设备","selector":{"id":"status","text":"完成"},"state":"present","timeoutMs":5000}`。
3. 调用 `capture`，查看动作后的新画面。

等待加载控件消失：`{"deviceId":"目标设备","selector":{"id":"loading"},"state":"absent"}`。内部检查全树，返回的节点数量限制不会影响匹配；空树不能满足 `absent`。`absent` 只证明当前非空、可读的控件树中没有匹配项，既不证明该控件曾经出现，也不能保证自绘内容或业务流程完成。文字变化应使用同一控件 ID 加预期 `text` 等待 `present`，不要用旧文字消失代替结果确认。

结果包含 `status`（`matched`、`timeout` 或 `observation_failed`）、`attempts`、`elapsedMs`、`lastObservation` 和 `warnings`；失败时附带 `error`。`lastObservation` 最多保留 200 个节点和 20 个匹配候选，同时给出总数与截断标记。`elapsedMs` 包括等待阶段的 HDC 清理时间，不包括失败后的截图时间。

超时或读取失败返回 MCP `isError: true`，同时尝试采集新截图，绝不使用预览缓存。补图采集预算为 3 秒，每次 HDC 清理最多 2 秒；等待末次检查和补图各可能清理一次，因此超过等待期限后仍可能额外耗时约 7 秒。补图失败保留 `screenshotError` 与独立的 `screenshotDiagnostic`。遇到 `timeout` 或 `observation_failed` 时，检查主错误、补图诊断与截图后再决定下一步，不把等待失败视为业务失败或自动重复点击。

预览页面按解码后的图片实际尺寸映射坐标。切设备、断线、停止及捕获失败后，旧画面不再用于操作；取得所选设备的新帧后才能交互。

## 常见问题

- 没有设备：检查 DevEco Studio、HDC 路径和设备授权状态。
- `connected: false`：表示预览未收到设备帧；用 `preview_info({"deviceId":"目标设备"})` 检查 HDC 连接，不使用旧截图坐标。
- 预览页面无法打开：确认 MCP 进程仍在运行，并使用最新的 `previewUrl`；不要手动拼接设备参数。
- 只想截图：可以直接调用 `capture`，不必启动实时预览。

`SKILL.md` 是 Codex 工作流提示文件；真正注册设备工具的是 MCP 命令。`preview_open` 负责侧边栏 Global Entrypoint，`previewUrl` 仍是独立浏览器预览入口。
