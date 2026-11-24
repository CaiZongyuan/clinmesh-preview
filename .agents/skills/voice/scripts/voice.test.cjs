const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DEFAULT_ENV_FILE, parseEnvFile } = require('./env.cjs');
const sambert = require('./sambert.cjs');
const minimax = require('./minimax.cjs');
const paraformer = require('./paraformer.cjs');

test('paraformer catalog exposes all 4 models with 36K monthly quota', () => {
  assert.deepEqual(
    paraformer.MODELS.map(m => m.id),
    ['paraformer-realtime-v2', 'paraformer-realtime-8k-v2', 'paraformer-v2', 'paraformer-8k-v2']
  );
  for (const m of paraformer.MODELS) assert.equal(m.quota, '36K s/month');
  assert.throws(() => paraformer.resolveModel('paraformer-unknown'));
});

test('paraformer realtime preparation validates audio, sample rate, and language hints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-test-'));
  try {
    const wav = path.join(dir, 'clip.wav');
    fs.writeFileSync(wav, Buffer.alloc(64));
    const prepared = paraformer.prepare({
      model: 'paraformer-realtime-v2',
      'audio-file': wav,
      'language-hints': 'zh,en',
      'semantic-punctuation': true
    });
    assert.equal(prepared.parameters.format, 'wav');
    assert.equal(prepared.parameters.sample_rate, 16000);
    assert.deepEqual(prepared.parameters.language_hints, ['zh', 'en']);
    assert.equal(prepared.parameters.semantic_punctuation_enabled, true);

    assert.throws(() => paraformer.prepare({
      model: 'paraformer-realtime-8k-v2',
      'audio-file': wav,
      'sample-rate': '16000'
    }));
    assert.throws(() => paraformer.prepare({
      model: 'paraformer-realtime-8k-v2',
      'audio-file': wav,
      'language-hints': 'zh'
    }));
    const ok8k = paraformer.prepare({ model: 'paraformer-realtime-8k-v2', 'audio-file': wav });
    assert.equal(ok8k.parameters.sample_rate, 8000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('paraformer async-file preparation builds REST payload and validates URL', () => {
  const prepared = paraformer.prepare({
    model: 'paraformer-v2',
    'file-url': 'https://example.com/consult.mp3',
    'language-hints': 'zh,en'
  });
  assert.equal(prepared.body.model, 'paraformer-v2');
  assert.deepEqual(prepared.body.input.file_urls, ['https://example.com/consult.mp3']);
  assert.deepEqual(prepared.body.parameters.language_hints, ['zh', 'en']);
  assert.throws(() => paraformer.prepare({ model: 'paraformer-v2', 'file-url': 'ftp://example.com/a.mp3' }));
  assert.throws(() => paraformer.prepare({ model: 'paraformer-8k-v2', 'file-url': 'https://example.com/a.wav', 'language-hints': 'zh' }));
});

test('paraformer WebSocket event builders and sentence parser conform to protocol', () => {
  const run = paraformer.buildRunTaskEvent('tid-1', 'paraformer-realtime-v2', { format: 'pcm', sample_rate: 16000 });
  assert.equal(run.header.action, 'run-task');
  assert.equal(run.header.streaming, 'duplex');
  assert.equal(run.payload.task, 'asr');
  assert.equal(run.payload.function, 'recognition');

  const fin = paraformer.buildFinishTaskEvent('tid-1');
  assert.equal(fin.header.action, 'finish-task');
  assert.equal(fin.header.task_id, 'tid-1');

  assert.equal(paraformer.extractSentenceEvent({ payload: { output: { sentence: { heartbeat: true, text: '' } } } }), null);
  assert.deepEqual(
    paraformer.extractSentenceEvent({ payload: { output: { sentence: { text: '胸口发闷两天了', begin_time: 100, end_time: 1400, sentence_end: true } } } }),
    { text: '胸口发闷两天了', beginTime: 100, endTime: 1400, sentenceEnd: true }
  );
});

test('sambert, minimax, and env helpers remain intact in unified voice skill', () => {
  assert.equal(sambert.resolveVoice('16').model, 'sambert-zhichu-v1');
  assert.equal(DEFAULT_ENV_FILE, 'D:/Environment/.env');
  assert.deepEqual(parseEnvFile('BAILIAN-TOKEN="abc" # note'), { 'BAILIAN-TOKEN': 'abc' });
  assert.throws(() => paraformer.parseArgs(['--audio-file', 'a.wav', '--file-url', 'https://a.com/a.wav']));
  assert.throws(() => minimax.parseArgs(['--nope']));
});
