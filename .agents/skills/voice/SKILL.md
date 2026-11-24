---
name: voice
description: 统一语音能力（STT 语音识别 + TTS 语音合成）。默认均使用阿里云百炼免费额度：实时/文件转写用 Paraformer（paraformer-realtime-v2 / paraformer-realtime-8k-v2 / paraformer-v2 / paraformer-8k-v2，各 36K 秒/月）；合成用 Sambert（43 音色，中文为主），仅当用户点名 MiniMax 时用付费 MiniMax T2A。密钥统一在 D:\Environment\.env。
---

# Voice（STT + TTS）

## 选型与额度

### STT 语音识别（阿里百炼 Paraformer）

| 模型 | 通信模式 | 采样率 | 月免费额度 | 适用场景 |
| :- | :- | :- | :- | :- |
| `paraformer-realtime-v2` | WebSocket 实时双工 | 任意（默认 16 kHz） | 36K 秒/月 | **默认首选**：实时麦克风/诊室流式转录，支持 `language_hints` |
| `paraformer-realtime-8k-v2` | WebSocket 实时双工 | 8 kHz | 36K 秒/月 | 8 kHz 窄带/电话实时流 |
| `paraformer-v2` | REST 异步文件识别 | 任意（推荐 16 kHz） | 36K 秒/月 | 公网 URL 长音频离线转写，支持 `language_hints` |
| `paraformer-8k-v2` | REST 异步文件识别 | 8 kHz | 36K 秒/月 | 公网 URL 8 kHz 电话录音离线转写 |

### TTS 语音合成

| | Sambert（默认） | MiniMax（用户点名才用） |
| :- | :- | :- |
| 费用 | 百炼免费额度大 | 付费，hd ~$100/M 字符，turbo ~$60/M |
| 音色 | 43 个，见 `references/sambert-voices.json`（01–43 编号） | 332 个，见 `references/minimax-voices.json` |
| 挑选 | 浏览器打开 `references/voices.html` 试听挑选 | 同左 |
| 输出 | WAV，默认 16 kHz | mp3/wav/flac/pcm/opus，最高 44.1 kHz |

## 密钥

统一从 `D:\Environment\.env` 读取（脚本自动解析，支持 `--env-file` / `--key-stdin` 覆盖）：

- 阿里百炼（Paraformer STT + Sambert TTS 共用）：`BAILIAN_TOKEN` 或 `BAILIAN-TOKEN`
- MiniMax：`MINIMAX_API_KEY`（兼容 `MINIMAX-TTS` / `MIMAMAX-TTS`；默认国内站，国际站加 `--base-url https://api.minimax.io`）

始终避免将 Key 写入命令参数、代码、日志或交付物。

## 执行

先定位本技能目录（`<skill-dir>`）。Node 22+ 零安装（内置 WebSocket）；Node 18–21 需在技能目录执行 `npm ci --omit=dev`。所有脚本均支持 `--list`、`--help` 与 `--dry-run`（只校验不联网不读 Key）。

```powershell
# 实时/本地音频 STT（Paraformer WebSocket）
node "<skill-dir>/scripts/paraformer.cjs" --model paraformer-realtime-v2 --audio-file "<workspace>/input.wav" --language-hints zh,en --out "<workspace>/transcript.txt"

# 远程音频 URL 离线 STT（Paraformer REST 异步）
node "<skill-dir>/scripts/paraformer.cjs" --model paraformer-v2 --file-url "https://example.com/audio.mp3" --language-hints zh,en --out "<workspace>/transcript.json"

# Sambert TTS（默认，--voice 接受 01–43 编号、简称或完整模型 ID）
node "<skill-dir>/scripts/sambert.cjs" --voice 16 --text-file "<workspace>/narration.txt" --out "<workspace>/narration.wav"

# MiniMax TTS（仅用户点名时使用）
node "<skill-dir>/scripts/minimax.cjs" --voice "Chinese (Mandarin)_News_Anchor" --text-file "<workspace>/narration.txt" --out "<workspace>/narration.mp3"
```

## 规则

- 正式执行只调一次；遇到鉴权、额度或限流错误直接向用户说明真实报错并停止，不静默重试。
- 输出文件已存在时拒绝覆盖，重做需换新文件名。
- **TTS**：只合成选定音色，不批量遍历；长文本按句/段分块保持同音色参数，用音频工具合并，不直接拼 WAV 字节；成功后交付音频路径并说明所用模型。
- **STT**：本地音频优先 `paraformer-realtime-v2`（16 kHz），公网长音频 URL 选 `paraformer-v2`；仅在 8 kHz 电话信道时选 `-8k-v2` 模型。

## 协议细节（按需查阅）

- Paraformer WebSocket 客户端/服务端事件、异步 REST 及 Cloudflare `agents/voice` `Transcriber` 适配：[references/paraformer-api.md](references/paraformer-api.md)
- Sambert WebSocket 协议坑（WAV 哨兵长度回填、禁发 `finish-task`、`rate` 参数名）：[references/sambert-api.md](references/sambert-api.md)
- MiniMax 请求体/错误码/计费：[references/minimax-api.md](references/minimax-api.md)
