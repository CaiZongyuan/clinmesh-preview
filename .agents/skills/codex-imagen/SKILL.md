---
name: codex-imagen
description: 使用用户 Codex 配置中的自定义 base_url 与 key 生成图片。用于用户要求 Codex imagen、复用 Codex 接口生图或通过该接口测试 GPT Image 2.6 的任务。
---

# Codex Imagen

这是用户 Codex 自定义接口的 API 路线，复用 imagegen 自带 CLI，不是 ChatGPT 订阅内置生图。仅在用户选择此路线时使用；不修改原有 CLI 或 Codex 配置。

- 模型：`gpt-image-2.6-flare`（快速迭代）、`gpt-image-2.6-sunburst`（精细构图与编辑）；用户指定模型时保留其选择，不静默换模型。
- 将最终提示词保存为 UTF-8 文本。若来源是教程/Markdown，提取并合并实际图片提示词，不把整份文档发给模型。
- 输出默认放当前项目 `output/imagegen/`；使用新文件名，避免覆盖已有图片。

## Windows PowerShell 调用

需要 `uv`。通过 `uv python find` 获取真实 Python（3.11+），避免 WindowsApps 的 `python.exe` 空壳。修改前三行后执行；密钥只经过内存和子进程环境，不打印配置或 provider 对象。

```powershell
$promptFile = (Resolve-Path '.\prompt.txt').Path
$model = 'gpt-image-2.6-flare'
$outFile = 'output/imagegen/example.png'

$imagenCodexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $env:USERPROFILE '.codex' }
$imagenConfigPath = Join-Path $imagenCodexDir 'config.toml'
$imagenCli = Join-Path $imagenCodexDir 'skills/.system/imagegen/scripts/image_gen.py'
$imagenPython = (& uv python find '>=3.11').Trim()
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $imagenCli)) { throw 'Python or imagegen CLI unavailable.' }

$imagenProviderJson = & $imagenPython -c "import json,os,pathlib,sys,tomllib; c=tomllib.loads(pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')); p=c['model_providers'][c['model_provider']]; print(json.dumps({'base_url':p.get('base_url'),'key':p.get('experimental_bearer_token') or os.environ.get(p.get('env_key',''),'')}))" $imagenConfigPath
if ($LASTEXITCODE -ne 0) { throw 'Could not read active Codex provider.' }
$imagenProvider = $imagenProviderJson | ConvertFrom-Json
if (-not $imagenProvider.base_url -or -not $imagenProvider.key) { throw 'Active provider needs base_url and bearer key (or env_key).' }
$imagenBase = $imagenProvider.base_url.TrimEnd('/')
if ($imagenBase -notmatch '/v1$') { $imagenBase += '/v1' }

$imagenOldKey = $env:OPENAI_API_KEY
$imagenOldBase = $env:OPENAI_BASE_URL
try {
    $env:OPENAI_API_KEY = $imagenProvider.key
    $env:OPENAI_BASE_URL = $imagenBase
    uv run --no-project --python $imagenPython --with openai --with pillow python $imagenCli generate --model $model --prompt-file $promptFile --size 1024x1024 --quality high --output-format png --n 1 --no-augment --out $outFile
    if ($LASTEXITCODE -ne 0) { throw 'Image generation failed; inspect the API error.' }
} finally {
    $env:OPENAI_API_KEY = $imagenOldKey
    $env:OPENAI_BASE_URL = $imagenOldBase
}
```

已验证本机接口使用 `/v1/images/generations`；base_url 已有 `/v1` 时不要重复追加。仅检查请求时给 CLI 追加 `--dry-run`，不会生成图片。

## 验收与故障

- 打开原图检查内容，用 Pillow 读取真实格式/尺寸；交付图片路径、最终提示词和请求模型。2026-11-13 本机接口曾将 `1024x1024` 请求返回为 `1199x1312`，不能仅凭成功响应断言参数生效，也不能把网关模型别名当作上游身份已验证。
- 401/403 检查当前 provider 的认证，404 检查 `/v1` 路径及模型 ID；可通过已认证的 `GET /v1/models` 查接口列出的模型。超时不要立即重复提交，先检查是否已有输出。
- 高阶参数先查看配套 CLI 的 `--help` / `references/cli.md`；它目前只接受 `low/medium/high/auto` 质量值。保留原始输出，不为掩盖尺寸偏差而拉伸或裁切。
