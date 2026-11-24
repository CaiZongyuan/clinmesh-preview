// MiniMax T2A v2 (HTTP, synchronous). PAID service, billed per character (~$100/M hd, ~$60/M turbo).
// API notes: see references/minimax-api.md
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readKey } = require('./env.cjs');
const voices = require('../references/minimax-voices.json');

const KEY_VARS = ['MINIMAX_API_KEY', 'MINIMAX-TTS', 'MIMAMAX-TTS'];
const GROUP_VARS = ['MINIMAX_GROUP_ID', 'MINIMAX-GROUP-ID'];
const DEFAULT_BASE_URL = 'https://api.minimaxi.com'; // domestic endpoint; pass --base-url https://api.minimax.io for international keys

const MODELS = ['speech-2.8-hd', 'speech-2.8-turbo', 'speech-2.6-hd', 'speech-2.6-turbo', 'speech-02-hd', 'speech-02-turbo', 'speech-01-hd', 'speech-01-turbo'];
const FORMATS = { mp3: '.mp3', wav: '.wav', flac: '.flac', pcm: '.pcm', opus: '.opus' };
const SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100];
const BITRATES = [32000, 64000, 128000, 256000];
const EMOTIONS = ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'fluent', 'whisper'];
const MAX_CHARS = 10000;

function parseArgs(args) {
  const options = {};
  const flags = new Set(['list', 'dry-run', 'key-stdin', 'help']);
  const values = new Set(['voice', 'model', 'text-file', 'out', 'env-file', 'format', 'sample-rate', 'bitrate', 'speed', 'vol', 'pitch', 'emotion', 'language-boost', 'group-id', 'base-url']);
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
  if (!options.voice) throw new Error('--voice is required (voice_id, case-sensitive). Use --list for system voices; cloned voice IDs are also accepted.');
  if (!options['text-file'] || !options.out) throw new Error('--text-file and --out are required.');
  const text = fs.readFileSync(path.resolve(options['text-file']), 'utf8').replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('Text file is empty.');
  if (text.includes('\uFFFD')) throw new Error('Text has replacement characters; check UTF-8 encoding.');
  if ([...text].length > MAX_CHARS) throw new Error(`Text exceeds ${MAX_CHARS} characters; split by sentence into chunks.`);
  const format = options.format || 'mp3';
  if (!(format in FORMATS)) throw new Error(`Invalid --format: ${format}. Supported: ${Object.keys(FORMATS).join(', ')}.`);
  const output = path.resolve(options.out);
  if (path.extname(output).toLowerCase() !== FORMATS[format]) throw new Error(`--out must end in ${FORMATS[format]} for format ${format}.`);
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new filename.');
  const model = options.model || 'speech-2.8-hd';
  if (!MODELS.includes(model)) throw new Error(`Invalid --model: ${model}. Supported: ${MODELS.join(', ')}.`);
  const sampleRate = numberOption(options, 'sample-rate', 32000, 8000, 44100, true);
  if (!SAMPLE_RATES.includes(sampleRate)) throw new Error(`Unsupported --sample-rate: ${sampleRate}. Supported: ${SAMPLE_RATES.join(', ')}.`);
  const body = {
    model, text, stream: false, output_format: 'hex',
    voice_setting: {
      voice_id: options.voice,
      speed: numberOption(options, 'speed', 1, 0.5, 2),
      vol: numberOption(options, 'vol', 1, 0.01, 10),
      pitch: numberOption(options, 'pitch', 0, -12, 12, true)
    },
    audio_setting: { sample_rate: sampleRate, format, channel: 1 }
  };
  if (format === 'mp3') body.audio_setting.bitrate = (() => {
    const bitrate = numberOption(options, 'bitrate', 128000, 32000, 256000, true);
    if (!BITRATES.includes(bitrate)) throw new Error(`Unsupported --bitrate: ${bitrate}. Supported: ${BITRATES.join(', ')}.`);
    return bitrate;
  })();
  if (options.emotion) {
    if (!EMOTIONS.includes(options.emotion)) throw new Error(`Invalid --emotion: ${options.emotion}. Supported: ${EMOTIONS.join(', ')}.`);
    body.voice_setting.emotion = options.emotion;
  }
  if (options['language-boost']) body.language_boost = options['language-boost'];
  return { body, output };
}

function decodeAudio(hex) {
  if (typeof hex !== 'string' || !hex) throw new Error('Response contains no audio data.');
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) throw new Error('Audio payload is not valid hex.');
  const buffer = Buffer.from(hex, 'hex');
  if (!buffer.length) throw new Error('Audio payload decoded to zero bytes.');
  return buffer;
}

function validateResponse(json) {
  const base = json.base_resp || {};
  if (base.status_code !== 0) {
    const reasons = {
      1004: 'authentication failed — check the MINIMAX API key',
      1002: 'rate limit exceeded',
      1039: 'TPM rate limit exceeded',
      2013: 'invalid parameters',
      1042: 'invalid characters exceed 10% of text'
    };
    throw new Error(`MiniMax error ${base.status_code}: ${base.status_msg || 'request failed'}${reasons[base.status_code] ? ` (${reasons[base.status_code]})` : ''}`);
  }
  if (!json.data) throw new Error('MiniMax response has no data object.');
  return json;
}

function help() {
  console.log(`MiniMax T2A (PAID, per character; hd ~$100/M, turbo ~$60/M)
--list
--voice "<voice_id>" --text-file file.txt --out file.mp3 [--model speech-2.8-hd]
[--format mp3|wav|flac|pcm|opus] [--sample-rate 8000-44100] [--bitrate 32000|64000|128000|256000]
[--speed 0.5-2] [--vol 0-10] [--pitch -12..12] [--emotion happy|sad|angry|fearful|disgusted|surprised|calm|fluent|whisper]
[--language-boost auto] [--group-id id] [--base-url url] [--env-file file | --key-stdin] [--dry-run]
Key: ${KEY_VARS.join(' or ')} in ${require('./env.cjs').DEFAULT_ENV_FILE}`);
}

async function synthesize(body, key, groupId, baseUrl) {
  const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/v1/t2a_v2${groupId ? `?GroupId=${encodeURIComponent(groupId)}` : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? 'TTS timed out after 120 seconds; no automatic retry.' : `Network error: ${error.message}`);
  } finally {
    clearTimeout(timer);
  }
  let json;
  try { json = await response.json(); } catch { throw new Error(`HTTP ${response.status}: response is not JSON.`); }
  if (!response.ok && !(json.base_resp)) throw new Error(`HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return validateResponse(json);
}

async function main() {
  let key;
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { help(); return; }
    if (options.list) {
      console.log(['#\tvoiceId\tname\tlanguage', ...voices.map(v => [v.voiceId, v.name, v.language].join('\t'))].join('\n'));
      return;
    }
    const prepared = prepare(options);
    if (options['dry-run']) {
      console.log(JSON.stringify({ status: 'dry-run', provider: 'minimax', characters: [...prepared.body.text].length, body: prepared.body, output: prepared.output }, null, 2));
      return;
    }
    ({ key } = await readKey(options, KEY_VARS));
    let groupId = options['group-id'] || process.env[GROUP_VARS[0]] || process.env[GROUP_VARS[1]];
    if (!groupId) {
      try {
        const vars = require('./env.cjs').parseEnvFile(fs.readFileSync(require('./env.cjs').DEFAULT_ENV_FILE, 'utf8'));
        groupId = GROUP_VARS.map(n => vars[n]).find(Boolean);
      } catch { /* optional */ }
    }
    fs.mkdirSync(path.dirname(prepared.output), { recursive: true });
    const json = await synthesize(prepared.body, key, groupId, options['base-url']);
    const audio = decodeAudio(json.data.audio);
    fs.writeFileSync(prepared.output, audio, { flag: 'wx' });
    const info = json.extra_info || {};
    console.log(JSON.stringify({
      status: 'ok', provider: 'minimax', model: prepared.body.model, voice: prepared.body.voice_setting.voice_id,
      output: prepared.output, bytes: audio.length,
      audioLengthMs: info.audio_length, sampleRate: info.audio_sample_rate || prepared.body.audio_setting.sample_rate,
      usageCharacters: info.usage_characters, usageVoiceCount: info.usage_voice_count, traceId: json.trace_id
    }, null, 2));
  } catch (error) {
    let message = String(error.message || error);
    if (key) message = message.replaceAll(key, '[REDACTED]');
    console.error(JSON.stringify({ status: 'error', message }));
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, prepare, decodeAudio, validateResponse, MODELS, FORMATS };
if (require.main === module) main();
