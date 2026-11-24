# Paraformer STT API 标注（阿里云百炼）

> 来源：`https://docs.bailian.console.aliyun.com/en/model-studio/paraformer-client-events` 及百炼 Paraformer 实时/录音文件识别文档
> 鉴权：统一使用 `BAILIAN_TOKEN`（或 `BAILIAN-TOKEN`），放于请求头 `Authorization: Bearer <token>`。

## 模型与月度免费额度

| 模型 | 模式 | 采样率 | 月免费额度 | 典型用途 |
| :- | :- | :- | :- | :- |
| `paraformer-realtime-v2` | WebSocket 实时双工 | 任意（常用 16 kHz） | 36K 秒/月 | **实时诊室/麦克风流式转写（默认）** |
| `paraformer-realtime-8k-v2` | WebSocket 实时双工 | 8 kHz | 36K 秒/月 | 8 kHz 电话/窄带实时语音流 |
| `paraformer-v2` | REST 异步文件识别 | 任意（推荐 16 kHz） | 36K 秒/月 | 长音频公网 URL 离线转写 |
| `paraformer-8k-v2` | REST 异步文件识别 | 8 kHz | 36K 秒/月 | 8 kHz 电话录音公网 URL 离线转写 |

## 一、实时流式识别（WebSocket：`paraformer-realtime-v2` / `paraformer-realtime-8k-v2`）

- 端点：`wss://dashscope.aliyuncs.com/api-ws/v1/inference`（可选专属空间域名 `wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference` + 头 `X-DashScope-WorkSpace`）
- 交互时序：
  1. 建连成功立即发 `run-task`（`header.streaming: "duplex"`，`payload.task_group: "audio"`，`payload.task: "asr"`，`payload.function: "recognition"`）。
  2. **必须等待服务端返回 `task-started`** 后，再持续发送单声道**二进制音频帧**（建议 16 kHz 16-bit PCM，每块 ~100 ms / 3200 字节）。
  3. 服务端持续下发 `result-generated`：
     - `payload.output.sentence.text`：当前句识别文本
     - `payload.output.sentence.begin_time` / `end_time`：毫秒时间戳
     - `payload.output.sentence.sentence_end`：`false` 为流式中间结果，`true` 为该句终态
     - `payload.output.sentence.heartbeat`：`true` 表示心跳包，应忽略
  4. 音频发送完毕后发送 `finish-task`（带同一个 `task_id`），继续读取直到收到 `task-finished` 再关连接。
  5. 收到 `task-failed` 立即中止并报告 `header.error_code` / `header.error_message`。

### 关键 `parameters`

| 参数 | 说明 |
| :- | :- |
| `format` | `pcm` / `wav` / `mp3` / `opus` / `speex` / `aac` / `amr` |
| `sample_rate` | `paraformer-realtime-v2` 支持任意采样率（默认 `16000`）；`paraformer-realtime-8k-v2` 固定 `8000` |
| `language_hints` | 仅 `paraformer-realtime-v2` 支持，如 `["zh", "en"]` |
| `semantic_punctuation_enabled` | 布尔值，开启语义断句（替代纯 VAD 静音断句） |
| `disfluency_removal_enabled` | 布尔值，去除语气词/口吃 |
| `heartbeat` | 布尔值，长静音不断连可设 `true` |

### 接入 Cloudflare `agents/voice`

实现 `agents/voice` 的 `Transcriber` 接口即可无缝接入：
- `createSession()` 建立百炼 WebSocket 并发送 `run-task`，缓冲 `task-started` 之前的音频帧；
- `feed(chunk: ArrayBuffer)` 直接发送 16 kHz PCM 二进制帧；
- 监听 `result-generated`：将 `sentence_end: false` 透出为流式字幕，将 `sentence_end: true` 作为完整话轮交给 Agent；
- `close()` 发送 `finish-task` 并在收到 `task-finished`（或超时）后关闭连接。

## 二、录音文件异步识别（REST：`paraformer-v2` / `paraformer-8k-v2`）

- 提交任务：`POST https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription`
  - 必填头：`Authorization: Bearer <token>`、`Content-Type: application/json`、`X-DashScope-Async: enable`
  - 请求体：`{ model, input: { file_urls: ["https://..."] }, parameters: { channel_id: [0], language_hints?: ["zh", "en"], disfluency_removal_enabled?: false } }`
- 查询任务：`GET https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}`，轮询 `output.task_status` 直至 `SUCCEEDED` 或 `FAILED`。
- 获取结果：成功后遍历 `output.results[].transcription_url` 拉取 JSON（链接有效期 24 小时）。
