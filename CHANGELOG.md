# Changelog

## Unreleased

- Added App-only `preview_frame` with sequence-based frame deduplication; the right-side MCP App now consumes the existing live stream instead of issuing a second `capture` loop.
- Added `preview_frame.waitMs` and action-triggered preview refresh so the panel waits for the first frame after a tap or swipe instead of polling a stale sequence.
- Preview polling now keeps the configured interval start-to-start, and successful screenshot cleanup runs off the critical path to reduce HDC frame latency.
- Added a JPEG `FrameSource` contract and live preview metrics for source, capture duration, frame bytes and capture time.
- Added local render timing and App-only action timing so slow taps can be separated from HDC capture and image decoding delays.
- Prioritized App-only gestures by aborting an in-flight preview JPEG capture before device input and requesting the next frame immediately after the action.
- Preview JPEG sampling now uses the first frame to derive device dimensions, samples later frames at half resolution, maps panel coordinates back to device pixels, and overlaps the first post-action capture with HDC input startup.
- Added five-second preview frame leases with same-session pause/resume after the panel stops requesting frames.
- Added App-only `preview_action` for one-shot panel taps and swipes with stale-frame rejection; model-facing `tap`, `swipe` and `tap_element` remain unchanged.
- Added `tap_element` for a fresh selector lookup and one validated component click, returning `verified: false` so callers must check the expected result separately.
- Routed opt-in selector acceptance through `tap_element`; default acceptance remains read-only and existing coordinate taps remain available.
- Detect HDC `[Fail]` output even with exit code 0, preventing false action acknowledgements.
- Added structured failure codes and original-cause diagnostics while preserving error text, fresh screenshot metadata and separate screenshot-failure evidence.
- Added read-only device checks and stable MCP runtime identity to `preview_info`, without changing the meaning of live-preview `connected`.
- Added acceptance checks for current MCP capabilities and diagnostics, with explicit process scope and no claim that the Codex host connection was refreshed.
- Expanded the real-device acceptance script with read-only observation/search/wait checks and an explicitly selected, single-tap action flow that requires a new expected match before capturing again.
- Added bounded `wait_for` for component presence, absence and expected text, with fresh screenshot evidence on timeout or layout failure.
- Added bounded UITest page observation and component search, with screenshot fallback for unavailable or empty layouts.
- Made explicit MCP captures sample the device again and include capture identifiers and timestamps.
- Corrected preview coordinate scaling and invalidated old frames on device changes, disconnects and stops.
- Restricted screenshot request fields and internalized temporary file paths.
- Fixed preview state write failures hanging subsequent MCP requests, and cleaned failed state write temporary files.
- Added concurrent MCP request handling with per-device mutation ordering and `$/cancelRequest` / `notifications/cancelled` support; cancellation propagates to waits, screenshots and HDC child processes.
- Added explicit `build_run` module and HAP artifact selection, with ambiguity rejection and selected-module launch arguments for multi-module projects.
- Default HAP resolution now prefers the single `*-signed.hap` when a build directory also contains an unsigned artifact; multiple signed artifacts still require `artifactName`.
- Added scheduled Node.js 20/22 GitHub Actions regression checks with concurrency cancellation.
- Fixed Windows timeout cleanup races by waiting for `taskkill` before returning from build and HDC command timeouts.

## 0.1.0 - 2026-09-30

- Added MCP preview session IDs, idempotent start, guarded stop and live session status.
- Added first-frame timeout cleanup and binary frame handling independent of image format.
- Fixed reconnect status when a device remains listed but screenshot capture fails.
- Added structured MCP results for session metadata and screenshot state.
- Added the Codex workflow skill and installation/use guide.
- Added the Windows Codex MCP installer with safe check-only, device requirement and replace modes.
- Added device-aware preview URLs that auto-select the device and start browser polling.
- Added a repeatable Codex real-device acceptance command and checklist.
- Added HarmonyOS device discovery, HAP build/install/launch, screenshot polling and live preview.
- Added click, swipe, long press, key event and text input controls.
- Added HTTP, WebSocket, CLI and MCP stdio interfaces.
- Added multi-device selection, reconnect retry, frame deduplication and local host hardening.
- Added Windows CI and local npm package checks.
