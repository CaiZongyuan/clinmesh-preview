---
status: accepted
---

# Alibaba Cloud Bailian Voice Provider for Cloudflare Agents Voice

We use Alibaba Cloud Bailian (DashScope) as the Phase 1 speech provider behind Cloudflare `agents/voice`—specifically `paraformer-realtime-v2` (36K s/month free quota) via a custom `Transcriber` adapter for real-time Chinese doctor STT and `sambert` (43 Chinese voices, free quota) via a custom `TTSProvider` adapter for Simulated Patient Chinese TTS, sharing a single `BAILIAN_TOKEN` credential—instead of Cloudflare Workers AI's default `WorkersAINova3STT` + `WorkersAITTS` or browser-only Web Speech synthesis. Workers AI's built-in Deepgram Aura TTS does not support Chinese, whereas Bailian provides native high-accuracy Chinese streaming ASR and natural Chinese TTS under one generous free tier while keeping Cloudflare `agents/voice`'s WebSocket transport, turn orchestration, and interruption handling intact.

## Considered Options

- **Workers AI `WorkersAINova3STT` + Browser Web Speech TTS**: Avoids custom adapters, but browser TTS voice quality varies sharply across OS/browsers and requires a Cloudflare account binding for local STT.
- **OpenAI / ElevenLabs TTS + Deepgram STT**: High quality, but introduces paid per-character/per-minute billing and multiple third-party API keys in Phase 1.

## Consequences

- `SambertTTSProvider` must repair DashScope's streamed WAV sentinel lengths (`0x7fffffbf` / `0x7fffff9b`) after `task-finished` (never sending `finish-task` to Sambert) before returning the playable `ArrayBuffer`.
- `ParaformerTranscriber` opens a duplex DashScope WebSocket (`run-task` → await `task-started` → stream 16 kHz mono PCM binary chunks → emit partial/final transcripts from `result-generated` `sentence_end` → `finish-task` on close).
- Both adapters remain strictly behind `agents/voice`'s `Transcriber` and `TTSProvider` interfaces, so swapping providers or adding Phase 2 doctor voiceprint attribution requires no changes to the clinical domain or UI.
