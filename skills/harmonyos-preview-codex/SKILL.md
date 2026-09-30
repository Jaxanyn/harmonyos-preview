---
name: harmonyos-preview-codex
description: Use the HarmonyOS Preview MCP tools from Codex to build, run, observe and interact with a HarmonyOS app on a connected device.
---

# HarmonyOS Preview in Codex

Use this workflow when the user asks to run or inspect a HarmonyOS project in a connected device.

## Required workflow

1. Call `list_devices` and select one device ID. If no device is listed, report that HDC must be connected and authorized.
2. Call `build_run` with the selected device ID when the app must be rebuilt or launched.
3. Call `preview_start` with the same device ID. Save the returned `sessionId` and `previewUrl`.
4. Open `previewUrl` in the Codex browser/panel. Use `capture` when the next decision needs an image.
5. Use `tap`, `swipe`, `long_press`, `key_event` or `input_text` with screenshot pixel coordinates. Capture again after a state-changing action.
6. Call `preview_stop` with the saved `sessionId` when the preview work is finished.

## Operating rules

- Do not call `preview_start` repeatedly for the same device; it reuses the active session.
- Keep the `sessionId` returned by `preview_start`; pass it to `preview_stop` so an older instruction cannot stop a newer session.
- Treat `connected: false` from `preview_info` as a device or screenshot problem. Wait for reconnection and capture a fresh frame before acting.
- Do not use coordinates from an old screenshot after navigation, scrolling, rotation or a new frame.
- Use the structured result fields (`deviceId`, `live`, `sessionId`, `connected`) instead of parsing text when available.
- Ask before `build_run` if the user did not request a build or device state change.

## Minimal prompt pattern

```text
Run the HarmonyOS app, open its live preview, and tap the primary action button.
```
