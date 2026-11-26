# ClinMesh Patient MiniProgram (`apps/patient-miniapp`)

Native WeChat MiniProgram (TypeScript + WXML + WXSS + `glass-easel` + `tdesign-miniprogram@1.18.0` + `easyjssdk@2.0.5`) for ClinMesh Connected Clinic.

## Prerequisites (External)

- WeChat MiniProgram AppID (replace placeholder `wx0000000000000000` in `project.config.json` locally; do not commit private credentials).
- WeChat Developer Tools installed on macOS/Windows with project member access.
- Registered HTTPS/WSS domains for the Worker API and WuKongIM WebSocket proxy.

## Import & Build npm in WeChat Developer Tools

```bash
cd apps/patient-miniapp
npm install
```

1. Open `apps/patient-miniapp/` in WeChat Developer Tools.
2. Run **工具 → 构建 npm** (`Build npm`); `project.config.json` maps `package.json` → `miniprogram/miniprogram_npm/`.
3. Verify `tdesign-miniprogram` and `easyjssdk` compile cleanly before previewing on iOS/Android physical devices.

## Renderer Policy (ADR-0004)

- Uses `glass-easel` component framework with `webview` renderer as the default baseline until Skyline rendering is verified on iOS/Android physical devices for long chat lists, incremental streaming `setData`, and `wx.getRecorderManager`.
- Agent streaming uses `miniprogram/services/agent-transport.ts` + shared `src/shared/agent-stream-reducer.ts` (zero external CloudBase dependencies).
