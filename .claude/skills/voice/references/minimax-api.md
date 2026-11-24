# MiniMax T2A v2 HTTP API 标注

> 来源：platform.minimax.io/docs/api-reference/speech-t2a-http（OpenAPI 规格，2025-11 核对）
> 定位：**付费**服务，仅在用户点名要求 MiniMax 或明确接受付费时使用。

## 计费（官方定价页 platform.minimax.io/docs/pricing/overview）

| 模型 | 价格 |
| :- | :- |
| `speech-2.8-hd` / `speech-2.6-hd` / `speech-02-hd` / `speech-01-hd` | ~$100 / 百万字符 |
| `speech-2.8-turbo` / `speech-2.6-turbo` / `speech-02-turbo` / `speech-01-turbo` | ~$60 / 百万字符 |

- 计费按 `usage_characters`（服务返回）；克隆/设计音色**首次使用**另收音色费（克隆 $1.5/个、设计 $3/个，见 `usage_voice_count`）
- 单次请求文本 < 10000 字符；超长按句分块多次请求

## 端点与鉴权

- 默认 `POST https://api.minimaxi.com/v1/t2a_v2`（国内站，脚本默认；当前密钥即国内站，实测无需 GroupId）
- 国际站 `https://api.minimax.io/v1/t2a_v2`（免 GroupId）；用 `--base-url https://api.minimax.io` 切换。**密钥不通用**：国内站密钥在国际站报 2049 invalid api key，反之亦然
- 部分国内文档要求 GroupId：需要时加 `--group-id` 或 `MINIMAX_GROUP_ID`，脚本自动追加 query
- 鉴权：请求头 `Authorization: Bearer <MINIMAX_API_KEY>`

## 请求体（脚本已固化合理默认值）

```json
{
  "model": "speech-2.8-hd",          // 或 speech-2.8-turbo / 2.6-hd / 2.6-turbo / 02-hd / 02-turbo / 01-hd / 01-turbo
  "text": "…",                        // <10000 字符；<#x#> 可插 0.01–99.99 秒停顿；(拼音/IPA) 可改读音
  "stream": false,
  "output_format": "hex",            // 脚本固定 hex（流式只支持 hex）
  "voice_setting": {
    "voice_id": "…",                  // 必填，区分大小写、含空格
    "speed": 1.0,                     // 0.5–2
    "vol": 1.0,                       // (0, 10]
    "pitch": 0,                       // -12..12 整数
    "emotion": "happy"                // 可选：happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper
  },
  "audio_setting": {
    "sample_rate": 32000,             // 8000/16000/22050/24000/32000/44100
    "bitrate": 128000,                // 仅 mp3：32000/64000/128000/256000
    "format": "mp3",                  // mp3/pcm/flac/wav/pcmu_raw/pcmu_wav/opus
    "channel": 1
  },
  "language_boost": "auto"            // 可选，小语种/方言增强；speech-01/02 不支持波斯/菲律宾/泰米尔语
}
```

其他能力（脚本未封装，需要时手写请求）：`pronunciation_dict.tone`（`原文/(拼音|IPA|假名)` 强制读音）、`timbre_weights`（最多 4 音色混合，此时 voice_id 留空）、`voice_modify`（音色微调滑杆与空间回声等特效）、`subtitle_enable`（字幕时间戳）。

## 响应与错误

- 成功：`base_resp.status_code === 0`；`data.audio` 为 **hex 编码**音频（须 `Buffer.from(hex,'hex')` 解码）；`extra_info` 含时长/采样率/计费字符数
- 错误码：`1004` 鉴权失败、`1002`/`1039` 限流、`2013` 参数非法、`1042` 无效字符超 10%；`data` 可能为 `null`，必须判空

## 音色

332 个系统音色见 [minimax-voices.json](minimax-voices.json)（官方语言/英文名标注）。voice_id 区分大小写且含空格（如 `Chinese (Mandarin)_News_Anchor`），必须原样传递。最新音色推荐用官方 [Get Voice API](https://platform.minimax.io/docs/api-reference/voice-management-get) 动态获取；克隆音色 ID 也可直接传入。中英混合建议 `--language-boost auto`。
