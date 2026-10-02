---
name: harmonyos-preview-codex
description: Use the HarmonyOS Preview MCP tools from Codex to build, run, observe and interact with a HarmonyOS app on a connected device.
---

# HarmonyOS Preview in Codex

Use this workflow when the user asks to run or inspect a HarmonyOS project in a connected device.

## Required workflow

1. Call `list_devices` and select one device ID. If no device is listed, report that HDC must be connected and authorized.
2. Call `preview_info`. If it returns `restored: true`, reuse its `sessionId` and `previewUrl`.
3. Call `build_run` with the selected device ID when the app must be rebuilt or launched.
4. Call `preview_start` with the same device ID when no restorable session exists. Save the returned `sessionId` and `previewUrl`.
5. Open `previewUrl` with the Codex host browser-panel action at `placement: "right"`. Use `capture` when the next decision needs an image.
6. Use `tap`, `swipe`, `long_press`, `key_event` or `input_text` with screenshot pixel coordinates. Capture again after a state-changing action.
7. Call `preview_stop` with the saved `sessionId` when the preview work is finished.

## Operating rules

- Do not call `preview_start` repeatedly for the same device; it reuses the active session.
- Keep the `sessionId` returned by `preview_start`; pass it to `preview_stop` so an older instruction cannot stop a newer session.
- Treat `connected: false` from `preview_info` as a device or screenshot problem. Wait for reconnection and capture a fresh frame before acting.
- Do not use coordinates from an old screenshot after navigation, scrolling, rotation or a new frame.
- Use the structured result fields (`deviceId`, `live`, `sessionId`, `connected`) instead of parsing text when available.
- When the Codex `open_in_codex` host action is available, pass `{ target: { type: "browser", url: previewUrl }, placement: "right" }` so the preview opens beside the conversation.
- When the host opens a new page, call `preview_info` first and reopen its `previewUrl`; do not create a second session when `restored: true`.
- Ask before `build_run` if the user did not request a build or device state change.

## Minimal prompt pattern

```text
Run the HarmonyOS app, open its live preview, and tap the primary action button.
```
