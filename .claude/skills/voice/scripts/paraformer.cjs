// Aliyun Bailian Paraformer STT (realtime WebSocket + async file REST).
// Protocol notes: see references/paraformer-api.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readKey } = require('./env.cjs');

const KEY_VARS = ['BAILIAN_TOKEN', 'BAILIAN-TOKEN'];
const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
const ASYNC_SUBMIT_URL = 'https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription';
const ASYNC_TASK_URL = 'https://dashscope.aliyuncs.com/api/v1/tasks';

const MODELS = [
  { id: 'paraformer-realtime-v2', mode: 'realtime', sampleRate: 'any (default 16000)', quota: '36K s/month', languageHints: true },
  { id: 'paraformer-realtime-8k-v2', mode: 'realtime', sampleRate: '8000', quota: '36K s/month', languageHints: false },
  { id: 'paraformer-v2', mode: 'async-file', sampleRate: 'any (16000 recommended)', quota: '36K s/month', languageHints: true },
  { id: 'paraformer-8k-v2', mode: 'async-file', sampleRate: '8000', quota: '36K s/month', languageHints: false }
];

const REALTIME_FORMATS = new Set(['pcm', 'wav', 'mp3', 'opus', 'speex', 'aac', 'amr']);

function resolveModel(value) {
  const id = String(value || 'paraformer-realtime-v2').trim();
  const entry = MODELS.find(m => m.id === id);
  if (!entry) throw new Error(`Unknown model: ${value}. Use --list for supported Paraformer models.`);
  return entry;
}

function parseArgs(args) {
  const options = {};
  const flags = new Set(['list', 'dry-run', 'key-stdin', 'help', 'semantic-punctuation', 'disfluency-removal']);
  const values = new Set(['model', 'audio-file', 'file-url', 'format', 'sample-rate', 'language-hints', 'out', 'env-file', 'chunk-bytes', 'interval-ms', 'poll-ms']);
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || (!flags.has(key) && !values.has(key))) throw new Error('Unknown option. Use --help.');
    if (key in options) throw new Error(`Duplicate option: --${key}`);
    if (flags.has(key)) options[key] = true;
    else {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
      options[key] = value;
    }
  }
  if (options['env-file'] && options['key-stdin']) throw new Error('Use only one of --env-file and --key-stdin.');
  if (options['audio-file'] && options['file-url']) throw new Error('Use only one of --audio-file and --file-url.');
  return options;
}

function positiveInt(options, key, fallback, min, max) {
  const n = options[key] === undefined ? fallback : Number(options[key]);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid --${key}: expected ${min}–${max} integer.`);
  return n;
}

function inferFormat(filePath, explicit) {
  const fmt = String(explicit || path.extname(filePath).replace(/^\./, '') || 'pcm').toLowerCase();
  if (!REALTIME_FORMATS.has(fmt)) throw new Error(`Unsupported realtime format: ${fmt}.`);
  return fmt;
}

function parseLanguageHints(raw) {
  if (!raw) return undefined;
  const hints = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (!hints.length) throw new Error('Invalid --language-hints.');
  return hints;
}

function prepare(options) {
  const model = resolveModel(options.model);
  const out = options.out ? path.resolve(options.out) : undefined;
  if (out && fs.existsSync(out)) throw new Error('Output already exists; choose a new filename.');
  const languageHints = parseLanguageHints(options['language-hints']);
  if (languageHints && !model.languageHints) {
    throw new Error(`--language-hints is only supported on paraformer-realtime-v2 and paraformer-v2 (not ${model.id}).`);
  }

  if (model.mode === 'realtime') {
    if (!options['audio-file']) throw new Error(`${model.id} requires --audio-file.`);
    const audioPath = path.resolve(options['audio-file']);
    const stat = fs.statSync(audioPath);
    if (!stat.isFile() || stat.size === 0) throw new Error('Audio file is empty or not a regular file.');
    const format = inferFormat(audioPath, options.format);
    const defaultRate = model.id.includes('8k') ? 8000 : 16000;
    const sampleRate = positiveInt(options, 'sample-rate', defaultRate, 8000, 48000);
    if (model.id.includes('8k') && sampleRate !== 8000) throw new Error(`${model.id} requires --sample-rate 8000.`);
    const parameters = {
      format,
      sample_rate: sampleRate,
      disfluency_removal_enabled: Boolean(options['disfluency-removal']),
      semantic_punctuation_enabled: Boolean(options['semantic-punctuation']),
      ...(languageHints ? { language_hints: languageHints } : {})
    };
    return {
      model,
      audioPath,
      bytes: stat.size,
      chunkBytes: positiveInt(options, 'chunk-bytes', 3200, 320, 65536),
      intervalMs: positiveInt(options, 'interval-ms', 40, 0, 1000),
      parameters,
      out
    };
  }

  if (!options['file-url']) throw new Error(`${model.id} requires --file-url (public HTTP/HTTPS URL).`);
  let parsedUrl;
  try { parsedUrl = new URL(options['file-url']); } catch { throw new Error('Invalid --file-url.'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('--file-url must use http or https.');
  const body = {
    model: model.id,
    input: { file_urls: [parsedUrl.toString()] },
    parameters: {
      channel_id: [0],
      disfluency_removal_enabled: Boolean(options['disfluency-removal']),
      ...(languageHints ? { language_hints: languageHints } : {})
    }
  };
  return {
    model,
    body,
    pollMs: positiveInt(options, 'poll-ms', 2000, 500, 30000),
    out
  };
}

function buildRunTaskEvent(taskId, modelId, parameters) {
  return {
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'asr',
      function: 'recognition',
      model: modelId,
      parameters,
      input: {}
    }
  };
}

function buildFinishTaskEvent(taskId) {
  return {
    header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: {} }
  };
}

function extractSentenceEvent(message) {
  const sentence = message?.payload?.output?.sentence;
  if (!sentence || sentence.heartbeat) return null;
  return {
    text: String(sentence.text || ''),
    beginTime: sentence.begin_time ?? null,
    endTime: sentence.end_time ?? null,
    sentenceEnd: Boolean(sentence.sentence_end)
  };
}

function createSocket(token) {
  if (typeof WebSocket === 'function') {
    return new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${token}` } });
  }
  let WS;
  try { WS = require('ws'); } catch {
    throw new Error('No built-in WebSocket (requires Node 22+). On Node 18–21 run `npm ci --omit=dev` in the skill directory.');
  }
  return new WS(WS_URL, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 20000 });
}

function transcribeRealtime(prepared, token) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = createSocket(token); } catch (error) { reject(error); return; }
    const taskId = randomUUID();
    const audio = fs.readFileSync(prepared.audioPath);
    const sentences = [];
    let latestPartial = '';
    let done = false;
    let streamTimer = null;
    const handshake = setTimeout(() => finish(new Error('WebSocket handshake timed out after 20 seconds.')), 20000);
    const timer = setTimeout(() => finish(new Error('STT timed out after 180 seconds; no automatic retry.')), 180000);

    function finish(error) {
      if (done) return;
      done = true;
      clearTimeout(handshake);
      clearTimeout(timer);
      if (streamTimer) clearTimeout(streamTimer);
      const open = ws.readyState === 1, closed = ws.readyState === 3;
      if (open) { try { ws.close(); } catch {} } else if (!closed) { try { ws.terminate?.(); } catch { try { ws.close(); } catch {} } }
      if (error) { reject(error); return; }
      const text = sentences.length ? sentences.map(s => s.text).join('') : latestPartial;
      resolve({ taskId, text, sentences });
    }

    function sendAudioChunks() {
      let offset = 0;
      function pump() {
        if (done) return;
        if (offset >= audio.length) {
          ws.send(JSON.stringify(buildFinishTaskEvent(taskId)));
          return;
        }
        const next = Math.min(offset + prepared.chunkBytes, audio.length);
        ws.send(audio.subarray(offset, next));
        offset = next;
        if (prepared.intervalMs === 0) setImmediate(pump);
        else streamTimer = setTimeout(pump, prepared.intervalMs);
      }
      pump();
    }

    function onText(raw) {
      let message;
      try { message = JSON.parse(raw); } catch { finish(new Error('Invalid JSON service event.')); return; }
      const h = message.header || {};
      if (h.task_id && h.task_id !== taskId) { finish(new Error('Service task ID mismatch.')); return; }
      if (h.event === 'task-failed') {
        finish(new Error(`${h.error_code || 'TaskFailed'}: ${h.error_message || 'Speech recognition failed'}`));
        return;
      }
      if (h.event === 'task-started') { sendAudioChunks(); return; }
      if (h.event === 'result-generated') {
        const seg = extractSentenceEvent(message);
        if (!seg) return;
        if (seg.sentenceEnd) {
          sentences.push(seg);
          latestPartial = '';
        } else {
          latestPartial = seg.text;
        }
        return;
      }
      if (h.event === 'task-finished') finish(null);
    }

    function onOpen() {
      clearTimeout(handshake);
      ws.send(JSON.stringify(buildRunTaskEvent(taskId, prepared.model.id, prepared.parameters)));
    }

    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', e => { if (!done && typeof e.data === 'string') onText(e.data); });
      ws.addEventListener('error', () => finish(new Error('WebSocket connection error (handshake or network).')));
      ws.addEventListener('close', () => { if (!done) finish(new Error('Connection closed before task-finished.')); });
    } else {
      ws.on('open', onOpen);
      ws.on('message', data => { if (!done) onText(String(data)); });
      ws.on('error', err => finish(new Error(String(err.message || err))));
      ws.on('close', () => { if (!done) finish(new Error('Connection closed before task-finished.')); });
    }
  });
}

async function transcribeAsyncFile(prepared, token) {
  const submitRes = await fetch(ASYNC_SUBMIT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable'
    },
    body: JSON.stringify(prepared.body)
  });
  const submitJson = await submitRes.json();
  if (!submitRes.ok || !submitJson?.output?.task_id) {
    throw new Error(`${submitJson?.code || submitRes.status}: ${submitJson?.message || 'Async submission failed'}`);
  }
  const taskId = submitJson.output.task_id;
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, prepared.pollMs));
    const pollRes = await fetch(`${ASYNC_TASK_URL}/${taskId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const pollJson = await pollRes.json();
    const status = pollJson?.output?.task_status;
    if (status === 'SUCCEEDED') {
      const results = pollJson.output.results || [];
      const transcripts = [];
      for (const item of results) {
        if (item.subtask_status !== 'SUCCEEDED' || !item.transcription_url) continue;
        const r = await fetch(item.transcription_url);
        transcripts.push(await r.json());
      }
      const text = transcripts
        .flatMap(t => t.transcripts || [])
        .map(t => t.text || '')
        .join('\n')
        .trim();
      return { taskId, text, results, transcripts };
    }
    if (status === 'FAILED') {
      throw new Error(`${pollJson?.output?.code || 'TaskFailed'}: ${pollJson?.output?.message || 'Async transcription failed'}`);
    }
  }
  throw new Error('Async transcription polling timed out after 300 seconds.');
}

function help() {
  console.log(`Paraformer STT (Aliyun Bailian, 36K s/month free quota per model)
--list
--model paraformer-realtime-v2|paraformer-realtime-8k-v2 --audio-file file.wav [--format pcm|wav|mp3|opus] [--sample-rate 16000] [--language-hints zh,en] [--semantic-punctuation] [--disfluency-removal] [--out transcript.txt] [--dry-run]
--model paraformer-v2|paraformer-8k-v2 --file-url https://.../audio.mp3 [--language-hints zh,en] [--disfluency-removal] [--out transcript.txt] [--dry-run]
[--env-file file | --key-stdin]
Key: ${KEY_VARS.join(' or ')} in ${require('./env.cjs').DEFAULT_ENV_FILE}`);
}

async function main() {
  let token;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { help(); return; }
    if (options.list) {
      console.log(['model\tmode\tsample_rate\tquota\tlanguage_hints', ...MODELS.map(m => [m.id, m.mode, m.sampleRate, m.quota, m.languageHints].join('\t'))].join('\n'));
      return;
    }
    const prepared = prepare(options);
    if (options['dry-run']) {
      console.log(JSON.stringify({ status: 'dry-run', ...prepared }, null, 2));
      return;
    }
    ({ key: token } = await readKey(options, KEY_VARS));
    const result = prepared.model.mode === 'realtime'
      ? await transcribeRealtime(prepared, token)
      : await transcribeAsyncFile(prepared, token);
    if (prepared.out) {
      fs.mkdirSync(path.dirname(prepared.out), { recursive: true });
      const content = path.extname(prepared.out).toLowerCase() === '.json'
        ? JSON.stringify(result, null, 2)
        : result.text;
      fs.writeFileSync(prepared.out, content, { flag: 'wx' });
    }
    console.log(JSON.stringify({ status: 'ok', provider: 'paraformer', model: prepared.model.id, mode: prepared.model.mode, taskId: result.taskId, text: result.text, output: prepared.out || null }, null, 2));
  } catch (error) {
    let message = String(error.message || error);
    if (token) message = message.replaceAll(token, '[REDACTED]');
    console.error(JSON.stringify({ status: 'error', message }));
    process.exitCode = 1;
  }
}

module.exports = { MODELS, resolveModel, parseArgs, prepare, buildRunTaskEvent, buildFinishTaskEvent, extractSentenceEvent };
if (require.main === module) main();
