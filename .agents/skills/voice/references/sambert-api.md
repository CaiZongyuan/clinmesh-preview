# Sambert WebSocket API 标注（阿里云百炼）

> 来源：help.aliyun.com/zh/model-studio/sambert-websocket-api、sambert-client-events、sambert-server-events（2025-11 核对）
> 定位：**免费额度极大**的中文为主合成模型，默认首选。计费超出免费额度后按字符计费，实际额度以账户控制台为准。

## 端点与鉴权

- 固定端点：`wss://dashscope.aliyuncs.com/api-ws/v1/inference`（北京地域；业务空间专属域名 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com` 可选，需加请求头 `X-DashScope-WorkSpace`）
- 鉴权：仅握手请求头 `Authorization: Bearer <BAILIAN_TOKEN>`；Key 无效时握手直接 401/403

## 交互流程（一次性任务，不是流式输入）

1. 客户端发 `run-task`：`streaming: "out"`、`task_group: "audio"`、`task: "tts"`、`function: "SpeechSynthesizer"`，**全部文本放在 `input.text` 一次性发送**
2. 服务端回 `task-started` → 持续回**二进制帧（音频）** + `result-generated`（时间戳）→ `task-finished`
3. **禁止发送 `continue-task` / `finish-task`**（Sambert 不支持，发了会报错）
4. 只有收到 `task-finished` 才算成功；`task-failed` 带 `error_code`/`error_message`

## parameters 要点

| 参数 | 说明 |
| :- | :- |
| `text_type` | 固定 `PlainText` |
| `format` | 固定 `wav`（服务只出 WAV） |
| `sample_rate` | `8000` / `16000` / `22050` / `24000` |
| `volume` | 0–100 整数，默认 50 |
| `rate` | 0.5–2，默认 1（**是 `rate`，不是 `speech_rate`**——后者是 CosyVoice 的参数名） |
| `pitch` | 0.5–2，默认 1 |

## 音频修复（坑）

流式返回的 WAV 头里 RIFF 长度与 data 长度是占位哨兵值 `0x7fffffbf` / `0x7fffff9b`，**必须等 `task-finished` 后用真实总长度回填**，否则多数播放器/工具无法读取。脚本 `normalizeFinishedWav()` 已处理。

## 音色

43 个系统音色见 [sambert-voices.json](sambert-voices.json)（官方标注：名称/特色/适用场景/语言/SSML 支持/采样率/官方试听 wav）。编号 01–43 是本技能自己的固定映射，不是阿里云官方编号。外语音色读中文可能带口音或漏字，成功响应不等于发音质量合格，交付前要试听。

## 长文本

无官方单次硬上限，遇服务长度限制时按句/段分块，保持同一音色与参数，每块存独立音频；合并需用音频工具转码拼接，不能直接拼 WAV 字节。
