# Changelog

## Unreleased

- Added MCP preview session IDs, idempotent start, guarded stop and live session status.
- Added first-frame timeout cleanup and binary frame handling independent of image format.
- Fixed reconnect status when a device remains listed but screenshot capture fails.
- Added structured MCP results for session metadata and screenshot state.
- Added the Codex workflow skill and installation/use guide.
- Added the Windows Codex MCP installer with safe check-only, device requirement and replace modes.
- Added device-aware preview URLs that auto-select the device and start browser polling.
- Added a repeatable Codex real-device acceptance command and checklist.

## 0.1.0 - 2026-09-30

- Added HarmonyOS device discovery, HAP build/install/launch, screenshot polling and live preview.
- Added click, swipe, long press, key event and text input controls.
- Added HTTP, WebSocket, CLI and MCP stdio interfaces.
- Added multi-device selection, reconnect retry, frame deduplication and local host hardening.
- Added Windows CI and local npm package checks.
