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

## 默认只读验收

该命令先检查所需工具与 `preview_info` 诊断契约，再只读探测设备，验证 `observe`、`find`、`wait_for`、预览地址和新截图。不安装或启动应用，也不点击设备：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID
```

通过时输出 JSON，其中 `check` 为 `codex: ok`，并包含设备、截图字节数、预览会话编号、`toolsVerified`、`actionVerified`、`waitStatus`、`waitAttempts`、`frameId`、`capturedAt` 和 `connectionCheck`。默认 `actionVerified` 为 `false`；只读查询通过只说明当前 UITest 控件可读取、查找和等待，不代表业务操作已完成。

`connectionCheck.scope` 在命令行模式下为 `isolated_process`；代码调用 `checkCodex` 并传入已有客户端时为 `provided_client`。结果还包含 `runtime`、`deviceStatus` 和固定为 `false` 的 `hostConnectionVerified`。脚本不打开或操作电脑界面，也不自动刷新宿主；独立进程通过不能证明当前 Codex 对话已经重连。

宿主连接应在当前对话单独检查：调用 `preview_info`，传入 `{"deviceId":"目标设备"}`，确认返回 `runtime.diagnosticsVersion: 1` 和 `deviceCheck.status: "connected"`，再实际调用 `observe`、`find` 和 `wait_for`。`runtime.instanceId` 在同一次 MCP 服务启动期间稳定，可帮助区分运行实例；它不代替工具调用验证。

缺少所需工具、`runtime` 或诊断契约不兼容时，验收返回 `MCP_OUTDATED`；检查安装路径并由用户重新连接宿主后再验收。设备自检失败保留具体的设备或 HDC 错误码；独立预览服务失败保留 `serviceDiagnostic` 中的错误，均不统一改写成版本过旧。

## 点击后等待并截图

仅在用户授权这次设备点击后运行。必须显式指定 `--device`，并成对提供 `--tap-selector` 与 `--wait-selector`；参数为 JSON 对象，复用 `find` 的 AND 条件。PowerShell 用单引号包住 JSON：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID `
  --tap-selector '{"id":"openDetails","clickable":true}' `
  --wait-selector '{"id":"detailsTitle","text":"详情"}'
```

将示例 ID 和文字替换为目标应用真实暴露的控件。运行前让设备停留在目标页面；脚本不会替用户导航寻找入口。

1. 先检查预期目标尚无匹配，避免目标本来就存在导致假通过。
2. 调用 `tap_element`，由工具内部重新查询并检查点击目标：唯一、可点击，且具有有效的 `bounds` 和 `center`；明确禁用、隐藏或采样无效、已超过 1 秒的目标会被拒绝，不发出点击。
3. 点击只执行一次；`verified: false` 不代表业务完成。随后用 `wait_for` 的 `present` 等待预期控件和文字，脚本等待上限为 10000 毫秒。
4. 匹配成功后重新 `capture`，确认返回的是动作后的新截图。

预期目标事前已匹配、控件树不可读、点击候选不唯一或坐标无效时，不应开始点击。预检拒绝保留 `ELEMENT_NOT_FOUND`、`ELEMENT_AMBIGUOUS`、`ELEMENT_NOT_ACTIONABLE` 或 `STALE_OBSERVATION`；布局或 HDC 错误保留具体原因。等待超时或读取失败会报错并尝试新截图；实际点击命令失败或超时时也不重复点击，先查看新证据，不能假定动作未生效。自绘内容、WebView 或未暴露的控件可能无法使用此链路；截图与 UITest 结果也不能独立证明业务提交成功。

默认只读模式不调用 `tap_element` 或坐标 `tap`。动作模式要求本次 MCP 连接提供 `tap_element`；工具缺失按 `MCP_OUTDATED` 处理。在 Codex 中使用新增工具需要宿主重新连接并确认可用，无需重复已完成的旧版只读验收。

失败时输出 `check: "codex: failed"` 和 `error`，进程以非零状态退出；工具失败还包含 `diagnostics.tool` 和结构化结果，不输出截图的 Base64 图片数据。诊断保留 `errorCode`、`stage`、`deviceId`、`elapsedMs` 与 `cause`；补图失败另带 `screenshotError` 和 `screenshotDiagnostic`，不覆盖主错误。

## 包含构建的验收

仓库 CI 会在 push、Pull Request 和每天 UTC 01:00 运行 `npm run check`（Node.js 20 与 22）。CI 不持有真实设备，因此构建安装、业务流程和物理断连恢复仍需在授权设备上按本清单执行。

确认用户允许修改设备应用后，再运行：

```powershell
node scripts/check-codex.mjs `
  --project C:\path\to\my-harmonyos-project `
  --device DEVICE_ID `
  --build
```

它会增加构建、安装和启动步骤，耗时取决于 DevEco 构建环境。多模块工程可追加 `--module feature --artifact feature-signed.hap`，参数会传给 `build_run`。

## Codex 画面验收

以下为单独的宿主画面验收，需要使用 Codex 界面，不属于上述命令行脚本的执行步骤：

1. Agent 调用 `preview_start`，记录 `sessionId`。
2. 在 Codex 中打开返回的 `previewUrl`，确认页面选择目标设备并显示新画面。
3. 调用 `observe`、`find` 和 `capture`，确认当前对话返回控件与 MCP 图片。
4. 用户已授权操作时，调用 `tap_element`，再用 `wait_for` 等待预期目标并重新 `capture`；无法通过控件树定位时，坐标 `tap` 需另以新截图确认目标。
5. 调用 `preview_stop` 并传入记录的 `sessionId`，确认会话结束。

当前验收确认的是 MCP 和预览页面链路；固定侧边栏仍由 Codex 宿主的 UI 能力决定。

## 2026-10-26 真机成功验收记录

在暂停其他设备操作后，使用独立的新 MCP 会话验证 `tap_element`，未构建、安装或修改应用配置。

场景为地图页打开退出确认框，再点击唯一的“取消”按钮。实际使用的选择器为 `{"text":"取消","type":"Button","clickable":true,"enabled":true}`；仅调用一次 `tap_element`，没有重试。随后用 `wait_for` 的 `absent` 等待 `{"text":"确定退出程序吗","type":"Text"}` 消失，再用 `present` 确认“图层管理”仍在。

- 点击前确认框匹配数为 1，点击后为 0；`wait_for` 返回 `matched`，应用没有退出。
- 点击回执的 `verified: false` 没有被当作完成依据；成功结论来自后续控件查询和新截图。
- 前帧为 `7a98503b-04b5-45ea-8a4c-fee3d48f453f`，后帧为 `00043757-84d1-4f86-83c2-960dd6df543c`，后帧时间为北京时间 2026-10-26 17:17:37，且不早于匹配观察。
- 设备回到本次验收前的地图页，退出确认框关闭；客户端已关闭，没有遗留验收预览会话。

本记录验证新服务的真机执行能力，连接范围为 `isolated_process`，`hostConnectionVerified` 为 `false`，不代表当前聊天的宿主工具缓存已刷新。此前地图空白点击没有关闭图层浮层的尝试未计入成功结果。

## 2026-10-27 真机物理断连恢复验收记录

在预览会话运行期间，对同一台鸿蒙设备执行 USB 拔线和插回，未构建、安装或修改应用配置。

- 运行实例为 `d9c15ce0-1d2e-4629-99ad-d98d72a956bb`，预览会话为 `6b98fdca-7b98-4323-996c-fe141ce260a3`，设备为 `5KLBB25A13202598`。
- 拔线后 `list_devices` 返回空列表；`preview_info` 保持 `running: true`、`connected: false`，并返回 `deviceCheck.status: "disconnected"` 与 `errorCode: "DEVICE_OFFLINE"`。
- 同一会话中的离线 `capture` 按预期失败，返回 `DEVICE_OFFLINE`，没有返回缓存图片或旧帧。
- 插回后设备重新出现在 `list_devices`，`preview_info` 在未重新调用 `preview_start` 的情况下恢复为 `connected: true`，会话 ID 未变化。
- 恢复后的新截图帧为 `4c841cf9-098b-459f-aed9-5a15f3111fd1`，时间为北京时间 2026-10-27 13:22:27；拔线前基线帧为 `24285339-6030-4152-b92c-2a2b43634041`，两者不同。
- 验收结束后使用原会话 ID 调用 `preview_stop`，确认预览会话已清理。

该记录证明设备物理断连后，预览服务能在同一会话中保持断开状态、正确拒绝离线截图，并在设备恢复连接后重新出图。

## 2026-10-27 Codex 重启后宿主刷新验收记录

重启 Codex 后使用当前对话的宿主 MCP 工具重新检查连接，没有依赖独立进程的验收结果。

- `list_devices` 返回已连接真机；`preview_info` 返回 `runtime.diagnosticsVersion: 1`。
- 当前能力列表包含 `preview_frame`、`preview_action`、`preview_panel`、`build_run` 和 `tap_element`。
- `preview_start`、`capture`、`observe`、`find({"text":"首页","type":"Text"})` 与 `wait_for({"text":"首页","type":"Text"})` 均成功；`preview_stop` 使用同一 `sessionId` 清理完成。

该记录关闭了“当前 Codex 宿主仍使用旧 MCP 工具列表”的剩余项。物理 USB 断连恢复仍以本文件上一节的真机记录为依据。

## 2026-10-28 MCP App 真机画面显示优化记录

针对 1600×2560 竖屏真机画面在 Codex 右侧面板中显示偏小的问题，完成 MCP App 展示层的最小改动：

- 预览区域改为响应式高度，竖屏画面最大高度由 `62vh` 提升到 `76vh`，保留等比缩放。
- 增加 Fit、Zoom、Fullscreen 控件，缩放只改变展示尺寸，不改变点击坐标映射使用的原始帧尺寸。
- 首帧、断连、恢复和停止状态增加遮罩；有效帧显示分辨率、采集时间和缩放比例。
- `test/app.mjs` 增加首帧元数据、断连遮罩和缩放控制断言；浏览器独立预览页保持原有链路不变。

验证结果：`npm run check`、`npm pack --dry-run` 和 `git diff --check` 通过。当前真机 `preview_info` 返回 `running: true`、`connected: true`、`deviceCheck.status: "connected"`；新 `capture` 返回 JPEG 帧，采集时间为北京时间 2026-10-28 09:14:09。当前设备页面上的 `find({"text":"数据更新","type":"Text"})` 唯一匹配，`wait_for` 返回 `matched`。修改后的 MCP App 资源已重新生成到 `src/app/resource.html`；重启 Codex 或刷新 MCP App 后加载最新面板资源。

## 2026-10-27 构建、安装、启动真机验收记录

在用户明确授权后，使用 MCP 的 `build_run` 对 `F:\\HongMengHangtu\\YingTu` 执行真实 HAP 构建、安装和启动。

- 初次构建暴露本机环境问题：`DEVECO_SDK_HOME` 指向父目录时被 Hvigor 误判，指向 `sdk\\default` 又触发 SDK 组件扫描错误。项目现有 `build-local.ps1` 已改为在构建子进程中临时使用 DevEco SDK 父目录，并在退出时恢复原环境变量；未修改全局环境。
- 本机仅安装 HarmonyOS 6.0.0 / API 20，而项目原配置为 `5.0.5(17)`。为使用已安装 SDK 完成构建，`build-profile.json5` 的 `compatibleSdkVersion` 和 `targetSdkVersion` 已对齐为 `6.0.0(20)`。
- `build_run` 最终返回成功：HAP 为 `entry\\build\\default\\outputs\\default\\entry-default-signed.hap`，Bundle 为 `com.jax.yingtu`，Ability 为 `EntryAbility`。
- 启动后的预览会话为 `7625449c-16c2-43d3-b3dc-39282e7e0e75`，运行实例为 `d9c15ce0-1d2e-4623-99ad-d98d72a956bb`，`preview_info` 返回 `running: true`、`connected: true`，设备检查为 `connected`。
- 启动后 `observe` 读取到 74 个控件；`find` 唯一找到“映途”和“首页”；`wait_for` 等待 `{"text":"首页","type":"Text"}` 返回 `matched`；新截图帧为 `a3610b59-f876-467e-b369-fd17402d4cdd`，时间为北京时间 2026-10-27 13:32:51。
- `图层管理` 属于地图页文字，应用冷启动后停留在首页，因此该选择器超时不计为启动失败；首页控件和新截图已完成启动验收。
- 验收结束后已使用原会话 ID 调用 `preview_stop`，没有遗留预览会话。

本次记录证明插件可以在当前 DevEco SDK 和真机环境中完成构建、安装、启动，并通过 MCP 读取启动后的真实控件树和截图。构建仍保留既有 ArkTS 和第三方依赖警告，未在本次验收中逐项清理。

## 2026-10-27 App-only 实时帧与租约真机验收记录

使用独立 MCP 进程连接真机，验证新的 `preview_frame(afterSeq)` 和实时帧租约；未执行设备点击或滑动。

- 预览会话为 `dea8b2d3-55ac-4c8f-856c-7bc505024224`，首帧 `seq: 1`，`preview_frame` 返回 `content: []`，图片只在结构化结果中提供。
- 使用相同 `afterSeq` 再次请求时没有返回图片，确认实时帧去重生效。
- 连续 5.4 秒不请求新帧后，`preview_info` 返回同一会话 `paused: true`、`connected: false`，说明 HDC 截图流已按租约暂停。
- 再次请求 `preview_frame` 后恢复为 `connected: true`，得到 `seq: 2` 的新帧，session ID 未变化。
- 使用原 session ID 调用 `preview_stop`，确认会话清理完成。

该记录验证了面板实时帧不会重复触发独立 `capture`、不会进入模型内容，并能在面板暂时不可见后按原会话恢复。

## 2026-10-27 并发、取消与多模块选择验证记录

使用本地模拟 HDC 与 MCP 输入流验证，未修改真机应用或设备状态。

- `node test/cancellation.mjs` 通过：`wait_for` 运行期间发送 `ping` 能立即返回；发送 `$/cancelRequest` 后返回 JSON-RPC `-32800`，HDC 子进程收到同一个 `AbortSignal` 并中止，截图临时文件仍执行清理。
- 在真实设备 `5KLBB25A13202598` 上以独立 MCP 进程发送 30 秒 `wait_for` 后于 1 秒发送 `$/cancelRequest`，实际返回 `-32800 Request cancelled`；没有等待到超时，也没有产生截图回退。
- 同一设备的点击、输入、构建和启动请求通过设备队列按到达顺序执行；只读读取和等待请求保持并发响应。
- `node test/build.mjs` 通过：`build_run` 可选择 `moduleName` 与 `artifactName`；存在唯一 `*-signed.hap` 时自动选择它，多个签名产物未指定产物时保留歧义错误，显式产物限制在目标模块的 `build` 目录；启动命令携带所选模块。
- `node test/smoke.mjs`、`node test/mcp.mjs` 与 `npm run check` 全部通过。

该记录覆盖两项剩余工程能力的本地行为验证；真实多模块 HAP 构建仍取决于目标工程的构建脚本是否读取 `HARMONY_PREVIEW_MODULE`，标准 `devecocli` 路径会传入 `--modules`。

## 2026-10-27 YingTu 业务流程补充验收记录

在真实设备上完成一次只涉及现有数据的导航检查，未创建、编辑或删除行程数据。

- `build_run` 重新构建、安装并启动 `com.jax.yingtu` 成功，产物自动选择唯一签名 HAP：`entry-default-signed.hap`。
- 从首页点击底部“行程”入口后，`wait_for({"text":"行程","type":"Text"})` 返回 `matched`，页面显示“我的行程”和已有行程卡片。
- 点击“成都两日慢游”卡片后，标题仍唯一可见且边界从列表区域变为详情页标题区域，确认导航进入行程详情；随后按返回键回到首页并用 `find({"text":"首页","type":"Text"})` 确认恢复。

该记录补齐了首页 → 行程列表 → 行程详情 → 返回首页的真实设备链路；地图、自定义航图图层和导航启动仍属于需要单独业务数据与外部地图状态的后续场景。

## ArkTS 构建警告审计

在 `hvigor clean` 后重新构建，当前共记录 458 条 ArkTS 警告：339 条来自 `YingTu/oh_modules` 下 `@bdmap/base`、`@bdmap/map` 与 `@bdmap/search` 的压缩 `.d.ets` 声明文件，属于第三方依赖诊断；1 条为 `WRITE_IMAGEVIDEO` 权限提示；118 条 `Function may throw exceptions` 已集中到 5 个业务文件：`TripRepository.ets`、`TripDatabase.ets`、`TravelCardExportService.ets`、`BackupFileService.ets` 和 `MapSdk.ets`。

第三方警告需要升级或替换依赖，权限提示需要结合图片保存产品路径设计；业务异常提示需要逐个核对错误边界，批量增加 `try/catch` 会掩盖失败原因，因此暂不做机械修改。

已将业务源码中的 3 处 `TextDecoder` 旧 API 迁移到 `TextDecoder.create('utf-8').decodeToString(...)`，并重新构建成功。`vp2px` 和对话框 `show` 的弃用警告已在下一节完成迁移；剩余业务工程警告主要是异常处理提示、SDK 版本差异和权限声明。

## 2026-10-27 ArkTS 弃用 API 迁移与真机回归记录

在不修改 SDK、权限、依赖和签名配置的前提下，完成业务源码的直接 API 迁移：

- `Index.ets` 中 5 处 `AlertDialog.show` 改为 `this.getUIContext().showAlertDialog`。
- `Index.ets` 中 2 处 `DatePickerDialog.show` 改为 `this.getUIContext().showDatePickerDialog`。
- 地图视口、站点标记和聚合图层统一注入 `UIContext`，24 处全局 `vp2px` 改为 `uiContext.vp2px`。

使用 `HARMONY_PREVIEW_MODULE=entry .\\build-local.ps1` 构建成功；本次日志中 `show` 弃用警告为 0，`vp2px` 弃用警告为 0。剩余警告为异常处理提示、`WRITE_IMAGEVIDEO` 权限声明，以及百度地图第三方 `.d.ets` 声明诊断。

随后通过 MCP `build_run` 使用显式 `moduleName: "entry"` 和 `artifactName: "entry-default-signed.hap"` 完成构建、安装和启动；当前宿主预览返回 `diagnosticsVersion: 1`，首页查找唯一匹配，`wait_for` 返回 `matched`，新截图返回 JPEG 数据。验收结束后已停止预览会话。

## 2026-10-28 点击反馈延迟优化记录（第一阶段）

定位到 MCP App 点击后画面更新慢的原因：动作完成后只读取一次实时帧；如果该次读取发生在服务下一帧到达之前，面板会等待下一轮 500 毫秒轮询。

- `src/app/main.mjs` 在 `preview_action` 成功后增加最多 6 次、每次间隔 80 毫秒的新帧读取，优先等待动作后的第一帧，不改变坐标映射和设备动作协议。
- `test/app.mjs` 增加“首个读取无新帧时立即重试并显示后续帧”的回归断言。
- 点击动作仍保持单次发送、旧帧校验和失败不自动重试；只加快动作后的画面确认。

该阶段已通过 `npm run check`。随后在下一节将短轮询升级为服务端等待新帧和动作主动刷新。

## 2026-10-28 点击后新帧等待与采集调度优化记录

上一轮 80 毫秒重试只能缩短 MCP App 读取间隔，无法等待 HDC 正在采集的下一帧。本轮将动作后的实时帧确认改为服务端等待新序号，并由动作主动唤醒预览采集：

- `preview_frame` 新增 `waitMs`，面板在点击或滑动后一次等待 `seq` 递增，避免 6 次短轮询错过下一帧。
- `preview_action` 成功后发送 `preview-refresh`；预览服务会在当前采集完成后立即开始下一次采集。
- 动作触发的采集会强制发布一个新序号，即使点击没有改变像素，面板也不会因为等待新序号而卡到超时。
- 轮询间隔改为采集开始到下一次采集开始的间隔，采集耗时超过 `pollMs` 时不再额外等待 500 毫秒。
- 成功截图的远端临时文件继续清理，但清理不再阻塞当前帧返回；失败路径仍等待清理完成。

本地验证：`node test/app.mjs`、`node test/preview-frame.mjs`、`node test/server-races.mjs`、`node test/phase1.mjs` 和 `node test/wait.mjs` 均通过。由于本轮同时更新了 MCP 服务端工具参数和采集调度，需重启 Codex（仅刷新面板资源不足）；重启后点击后的画面确认会等待动作后的第一帧。实际帧速度仍受真机 `snapshot_display` 和 USB 传输耗时限制。

## 2026-10-29 重启后真机点击回归

重启后的宿主实例为 `2eb1be1f-1a1f-4428-b3c2-e934a84a1030`，真机 `5KLBB25A13202598` 返回 `running: true`、`connected: true`。在右侧 MCP App 的航路图页面执行一次真实点击，面板立即显示 `Sending tap…`，约 888ms 后恢复 `Preview running`；点击反馈标记正常出现，未发生面板卡死或断连。

## 2026-10-29 CI Windows 超时清理修复

检查 GitHub Actions 历史运行 `37124179278` 时发现 Node 20 和 Node 22 均在 `test/build.mjs` 超时用例结束阶段失败，原因是 Windows `taskkill` 尚未释放构建子进程工作目录，临时目录删除返回 `EBUSY`。

- `src/build.mjs` 和 `src/device.mjs` 的 Windows 进程树终止现在等待 `taskkill` 完成后再返回超时结果。
- 子进程 `close` 事件不会抢先结束清理流程，避免测试和 CI 提前删除仍被占用的目录。
- 本地 `npm run check`、`npm pack --dry-run` 和 `git diff --check` 已通过；推送分支 `codex/ci-remote-validation` 后手动触发运行 `40815016187`，Node 20 和 Node 22 两个矩阵任务均成功。

## 2026-10-29 ArkTS 警告复核

对 `YingTu` 执行 `hvigor clean` 后重新构建，确认当前产物构建成功（约 50.8 秒）。最新日志 `.tmp-warning-audit-current.log` 共保留 458 条 ArkTS 文件警告：

- 118 条 `Function may throw exceptions`，集中在 `TripRepository.ets`（81）、`TripDatabase.ets`（22）、`TravelCardExportService.ets`（10）、`BackupFileService.ets`（4）和 `MapSdk.ets`（1）。
- 339 条来自 `@bdmap/base`、`@bdmap/map`、`@bdmap/search` 的压缩 `.d.ets` 声明文件。
- 1 条 `ohos.permission.WRITE_IMAGEVIDEO`，来源是 `photoAccessHelper.createAsset` 的图库保存路径；当前使用 SaveButton 临时授权，不直接扩大为全局权限。
- 业务 `show`、`vp2px` 和 `TextDecoder` 弃用警告保持为 0。

剩余业务异常提示需要按数据访问、文件导出和地图 SDK 边界逐项设计错误处理；第三方声明诊断需要升级或替换百度地图依赖，暂不做批量改写。

## 2026-10-29 地图自绘页面能力复核

在当前真机地图页执行只读 `observe`、`find`（图层、导航和航图相关文字）与截图复核。地图页面返回的 UITest 层级只有空根节点，选择器查询均无匹配并转为截图证据；右侧实时预览仍保持 `running: true`、`connected: true`。

该结果确认插件的截图与实时预览链路正常，但地图自绘内容没有暴露为可定位控件。图层开关、外部地图导航和自定义航图图层仍需要业务数据、外部地图状态或坐标级人工验收，当前不做没有稳定目标的自动点击。

## 2026-10-29 预览性能指标与 FrameSource

实时预览已接入统一的 JPEG `FrameSource` 契约。当前采集链路仍使用 HDC JPEG 回退，但每次 `preview_frame` 结构化结果会提供：

- `metrics.source`：当前为 `jpeg`，为后续 MJPEG/H.264 后端保留替换点。
- `metrics.captureMs`：从采集请求开始到帧返回的耗时。
- `metrics.frameBytes`：当前帧字节数。
- `metrics.capturedAt`：本次采集完成时间。

本地回归覆盖 FrameSource、预览指标传递、MCP App 指标展示、断连恢复和原有 JPEG 轮询；`npm run check` 通过。当前指标用于定位截图、传输和渲染延迟，尚未引入连续视频流。

同一增量还记录 `preview_action.metrics.actionMs` 和面板本地 `renderMs`，用于区分 HDC 操作耗时与图片解码/渲染耗时。当前设备的 HDC/UITest 能力没有可验证的长驻 H.264/MJPEG 输出命令，因此连续流后端暂缓，继续使用可注入的 FrameSource 和 JPEG 回退。

## 2026-10-29 点击链路优先级优化

`preview-action-start` 会中止正在进行的 JPEG 采集，避免点击和截图同时争用 HDC；动作结束后 `preview-refresh` 清除暂停状态并立即启动下一次采集。设备适配器在取消预览截图时不再等待远端临时文件清理完成，远端路径使用唯一 ID，清理仍在后台执行。

真机 `5KLBB25A13202598` 复核结果：首帧 `captureMs=873ms`，点击 `actionMs=645ms`、请求往返 `647ms`，点击后的新帧等待 `575ms`、新帧采集 `570ms`；过程中没有断连或错误。
