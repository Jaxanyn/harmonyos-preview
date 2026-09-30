# Changelog

## Unreleased

- Added MCP preview session IDs, idempotent start, guarded stop and live session status.
- Added first-frame timeout cleanup and binary frame handling independent of image format.
- Fixed reconnect status when a device remains listed but screenshot capture fails.
- Added structured MCP results for session metadata and screenshot state.

## 0.1.0 - 2026-09-30

- Added HarmonyOS device discovery, HAP build/install/launch, screenshot polling and live preview.
- Added click, swipe, long press, key event and text input controls.
- Added HTTP, WebSocket, CLI and MCP stdio interfaces.
- Added multi-device selection, reconnect retry, frame deduplication and local host hardening.
- Added Windows CI and local npm package checks.
