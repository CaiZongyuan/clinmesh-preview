// Aliyun Bailian Sambert TTS via WebSocket. Free tier is generous; billed per character beyond it.
// Protocol notes: see references/sambert-api.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { readKey } = require('./env.cjs');
const voices = require('../references/sambert-voices.json');

const KEY_VARS = ['BAILIAN_TOKEN', 'BAILIAN-TOKEN'];

function resolveVoice(value) {
  const raw = String(value || '').trim().toLowerCase();
  const entry = /^\d{1,2}$/.test(raw)
    ? voices.find(v => Number(v.number) === Number(raw))
    : voices.find(v => v.model === raw || v.model === `sambert-${raw}-v1`);
  if (!entry) throw new Error(`Unknown voice: ${value}. Use --list for the fixed 01–43 mapping.`);
  return entry;
}

function parseArgs(args) {
  const options = {};
  const flags = new Set(['list', 'dry-run', 'key-stdin', 'help']);
  const values = new Set(['voice', 'text-file', 'out', 'env-file', 'rate', 'pitch', 'volume', 'sample-rate']);
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
  return options;
}

function numberOption(options, key, fallback, min, max, integer = false) {
  const n = options[key] === undefined ? fallback : Number(options[key]);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new Error(`Invalid --${key}: expected ${min}–${max}${integer ? ' integer' : ''}.`);
  }
  return n;
}

function prepare(options) {
  const voice = resolveVoice(options.voice);
  if (!options['text-file'] || !options.out) throw new Error('--text-file and --out are required.');
  const text = fs.readFileSync(path.resolve(options['text-file']), 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('Text file is empty.');
  if (text.includes('\uFFFD')) throw new Error('Text has replacement characters; check UTF-8 encoding.');
  const output = path.resolve(options.out);
  if (path.extname(output).toLowerCase() !== '.wav') throw new Error('--out must end in .wav.');
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new filename.');
  const parameters = {
    text_type: 'PlainText', format: 'wav',
    sample_rate: numberOption(options, 'sample-rate', voice.sampleRate === '48k' ? 16000 : 16000, 8000, 24000, true),
    volume: numberOption(options, 'volume', 50, 0, 100, true),
    rate: numberOption(options, 'rate', 1, 0.5, 2),
    pitch: numberOption(options, 'pitch', 1, 0.5, 2)
  };
  if (![8000, 16000, 22050, 24000].includes(parameters.sample_rate)) throw new Error('Unsupported sample rate.');
  return { voice, text, output, parameters };
}

// Sambert streams PCM with sentinel lengths; finalize only after task-finished.
function normalizeFinishedWav(buffer) {
  const result = Buffer.from(buffer);
  if (result.length >= 44 && result.toString('ascii', 0, 4) === 'RIFF' && result.toString('ascii', 8, 12) === 'WAVE' && result.readUInt32LE(4) === 0x7fffffbf) {
    for (let offset = 12; offset + 8 <= result.length;) {
      const id = result.toString('ascii', offset, offset + 4), size = result.readUInt32LE(offset + 4);
      if (id === 'data' && size === 0x7fffff9b) {
        result.writeUInt32LE(result.length - offset - 8, offset + 4);
        result.writeUInt32LE(result.length - 8, 4);
        break;
      }
      if (offset + 8 + size > result.length) break;
      offset += 8 + size + (size % 2);
    }
  }
  return result;
}

function inspectWav(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Service returned invalid WAV audio.');
  let fmt; let dataBytes = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const id = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > buffer.length) throw new Error('Truncated WAV chunk.');
    if (id === 'fmt ' && size >= 16) fmt = { encoding: buffer.readUInt16LE(start), channels: buffer.readUInt16LE(start + 2), sampleRate: buffer.readUInt32LE(start + 4), byteRate: buffer.readUInt32LE(start + 8), bits: buffer.readUInt16LE(start + 14) };
    if (id === 'data') dataBytes += size;
    offset = start + size + (size % 2);
  }
  if (!fmt || fmt.encoding !== 1 || !fmt.byteRate || !dataBytes) throw new Error('WAV contains no valid PCM audio.');
  return { ...fmt, dataBytes, durationSeconds: Number((dataBytes / fmt.byteRate).toFixed(3)) };
}

const WS_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';

// Node >= 22 ships a global WebSocket (undici) that accepts a non-standard
// `headers` option, so no npm install is needed. Node 18–21 falls back to `ws`.
function createSocket(token) {
  if (typeof WebSocket === 'function') {
    return new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${token}` } });
  }
  let WS;
  try { WS = require('ws'); } catch {
    throw new Error('No built-in WebSocket (requires Node 22+). On Node 18–21 run `npm ci --omit=dev` in the skill directory to install the `ws` fallback.');
  }
  return new WS(WS_URL, { headers: { Authorization: `Bearer ${token}` }, handshakeTimeout: 20000 });
}

function synthesize(prepared, token) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = createSocket(token); } catch (error) { reject(error); return; }
    const taskId = randomUUID();
    const chunks = []; let done = false;
    let pending = Promise.resolve(); // preserves binary frame order for Blob payloads
    const handshake = setTimeout(() => finish(new Error('WebSocket handshake timed out after 20 seconds.')), 20000);
    const timer = setTimeout(() => finish(new Error('TTS timed out after 120 seconds; no automatic retry.')), 120000);
    function finish(error) {
      if (done) return; done = true; clearTimeout(handshake); clearTimeout(timer);
      const open = ws.readyState === 1, closed = ws.readyState === 3;
      if (open) { try { ws.close(); } catch {} } else if (!closed) { try { ws.terminate?.(); } catch { try { ws.close(); } catch {} } }
      error ? reject(error) : resolve({ audio: Buffer.concat(chunks), taskId });
    }
    function onText(text) {
      let message; try { message = JSON.parse(text); } catch { finish(new Error('Invalid JSON service event.')); return; }
      const h = message.header || {};
      if (h.task_id && h.task_id !== taskId) { finish(new Error('Service task ID mismatch.')); return; }
      if (h.event === 'task-failed') { finish(new Error(`${h.error_code || 'TaskFailed'}: ${h.error_message || 'Speech synthesis failed'}`)); return; }
      if (h.event === 'task-finished') {
        pending.then(() => finish(chunks.length ? null : new Error('Task finished without audio.')), () => finish(new Error('Failed to decode streamed audio frames.')));
      }
    }
    function onBinary(data) {
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        pending = pending.then(() => data.arrayBuffer()).then(ab => { if (!done) chunks.push(Buffer.from(ab)); });
        return;
      }
      if (!done) chunks.push(Buffer.from(data));
    }
    function onOpen() {
      clearTimeout(handshake);
      ws.send(JSON.stringify({ header: { action: 'run-task', task_id: taskId, streaming: 'out' }, payload: { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: prepared.voice.model, parameters: prepared.parameters, input: { text: prepared.text } } }));
    }
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', e => { if (done) return; typeof e.data === 'string' ? onText(e.data) : onBinary(e.data); });
      ws.addEventListener('error', () => finish(new Error('WebSocket connection error (handshake or network).')));
      ws.addEventListener('close', () => { if (!done) finish(new Error('Connection closed before task-finished.')); });
    } else {
      ws.on('open', onOpen);
      ws.on('message', data => { if (done) return; typeof data === 'string' ? onText(data) : onBinary(data); });
      ws.on('error', error => finish(new Error(String(error.message || error))));
      ws.on('close', () => { if (!done) finish(new Error('Connection closed before task-finished.')); });
    }
  });
}

function help() {
  console.log(`Sambert TTS (Aliyun Bailian, free quota)
--list
--voice 01|zhichu|sambert-zhichu-v1 --text-file file.txt --out file.wav
[--env-file file | --key-stdin] [--rate 0.5-2] [--pitch 0.5-2] [--volume 0-100] [--sample-rate 8000|16000|22050|24000] [--dry-run]
Key: ${KEY_VARS.join(' or ')} in ${require('./env.cjs').DEFAULT_ENV_FILE}`);
}

async function main() {
  let token;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { help(); return; }
    if (options.list) {
      console.log(['#\tnumber\tmodel\tname\tfeature\tlanguage', ...voices.map(v => [v.number, v.model, v.name, v.feature, v.language].join('\t'))].join('\n'));
      return;
    }
    const prepared = prepare(options);
    if (options['dry-run']) {
      console.log(JSON.stringify({ status: 'dry-run', ...prepared.voice, preview: undefined, characters: [...prepared.text].length, parameters: prepared.parameters, output: prepared.output }, null, 2));
      return;
    }
    ({ key: token } = await readKey(options, KEY_VARS));
    fs.mkdirSync(path.dirname(prepared.output), { recursive: true });
    const response = await synthesize(prepared, token);
    const audio = normalizeFinishedWav(response.audio), taskId = response.taskId;
    const wav = inspectWav(audio);
    fs.writeFileSync(prepared.output, audio, { flag: 'wx' });
    console.log(JSON.stringify({ status: 'ok', provider: 'sambert', model: prepared.voice.model, number: prepared.voice.number, output: prepared.output, bytes: audio.length, ...wav, parameters: prepared.parameters, taskId }, null, 2));
  } catch (error) {
    let message = String(error.message || error);
    if (token) message = message.replaceAll(token, '[REDACTED]');
    console.error(JSON.stringify({ status: 'error', message }));
    process.exitCode = 1;
  }
}

module.exports = { resolveVoice, parseArgs, prepare, inspectWav, normalizeFinishedWav };
if (require.main === module) main();
