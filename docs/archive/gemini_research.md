# Gemini 命令行多模态推理指南（视频 / 图片 / 音频 / PDF）

> 通过 curl 调用 Google AI Studio API，覆盖：四模态媒体推理 + 两个端点的完整参数 + 多轮对话 + 工具调用 + 结构化输出 + 流式 + token 计数 + Interactions API + 内置工具 + 缓存 + Batch。
> 所有方法均已用免费额度 key + 本机代理实测通过（2026-08-17）；免费层不可用的项已标注。

---

## 0. 关键结论

- OMP（Oh My Pi）配置的 **OpenAI 兼容端点**只支持 `text + image`，**没有视频/音频/PDF 的 wire 格式**。
- 要命令行推理视频/图片/音频/PDF，必须用 **Gemini 原生 `generateContent` 端点**，鉴权用 `x-goog-api-key` 头（不是 `Authorization: Bearer`）。
- 这是一条**独立于 OMP 的旁路**，不影响 OMP 已配置的 `google-aistudio` provider。
- **工具调用关键兼容性**：两个端点都要求把首轮返回的 `thought_signature` 原样回传，否则 400。标准 OpenAI 客户端（不透传该字段）无法完成 Gemini 工具多轮（见第 10 节）。
- **免费层不可用**：Google 搜索接地（429 配额）、Batch API。代码执行、缓存、流式、token 计数、Interactions API 均可用。

## 1. 端点与鉴权对照

| | OpenAI 兼容（OMP 用的） | 原生 `generateContent`（本指南） | Interactions API（新推荐） |
|---|---|---|---|
| URL | `…/v1beta/openai/chat/completions` | `…/v1beta/models/{m}:generateContent` | `…/v1beta/interactions` |
| 鉴权头 | `Authorization: Bearer <key>` | `x-goog-api-key: <key>` | `x-goog-api-key: <key>` |
| 图片 | ✅ `image_url` | ✅ `inlineData`/`fileData` | ✅ `{type:image,...}` |
| 视频 | ❌ | ✅ | ✅ `{type:video,...}` |
| 音频 | ❌ | ✅ | ✅ `{type:audio,...}` |
| PDF | ❌ | ✅ | ✅ `{type:document,...}` |
| thinking | `reasoning_effort` | `generationConfig.thinkingConfig` | `generation_config.thinking_level` |
| 工具调用 | ✅ `tools`+`tool_calls` | ✅ `functionCall`/`functionResponse` | ✅ `steps`(function_call/result) |
| 结构化输出 | ✅ `response_format` | ✅ `responseSchema` | ✅ `response_format` |
| 服务端多轮状态 | ❌（自己维护 messages） | ❌（自己维护 contents） | ✅ `previous_interaction_id` |

统一前缀：`https://generativelanguage.googleapis.com`
本机需走代理（直连 POST 被 GFW 重置）：`-x http://127.0.0.1:2080`

## 2. 免费层可用模型（Gemini 3.x Flash / Flash-Lite）

已纳入 OMP 的 6 个模型，全部免费层可用、支持 thinking、1M 上下文、64K 输出、多模态：

| 模型 ID | 系列 | 状态 |
|---|---|---|
| `gemini-3.7-flash` | Flash | Stable（最新） |
| `gemini-3.6-flash` | Flash | Stable |
| `gemini-3.5-flash` | Flash | Stable |
| `gemini-3-flash-preview` | Flash | Preview |
| `gemini-3.5-flash-lite` | Flash-Lite | Stable |
| `gemini-3.1-flash-lite` | Flash-Lite | Stable |

> 图片/PDF/视频任一 Flash/Flash-Lite 均可；但**结构化任务（如 SRT 字幕分句+时间轴）必须用 Flash 全量**，Flash-Lite 只产骨架（见第 7 节）。
> `gemini-3.7-flash` 偶发 503 `UNAVAILABLE`（高需求），重试或换 lite 即可。

## 3. 两种媒体输入方式

| 方式 | 字段 | 适用 | 限制 |
|---|---|---|---|
| **inline 内联** | `inlineData:{mimeType, data}` | 小文件 | 总请求 <20MB；视频<100MB；PDF<50MB；base64×1.33 |
| **Files API 上传** | `fileData:{mimeType, fileUri}` | 大文件/复用 | 免费层单文件≤2GB；上传后 48h 自动删除 |

> 经验：**视频走 Files API**（inline 视频实测挂死 5 分钟）；**图片/PDF/音频走 inline**（小、快；1 分钟 MP3 ≈1MB）。

---

## 4. 图片推理（inline，已实测 ✅）

```bash
KEY="AQ.Ab8..."
MODEL="gemini-3.5-flash-lite"
URL="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent"

python -c "
import base64, json
d = base64.b64encode(open('C:/tmp/frame.png','rb').read()).decode()
p = {'contents':[{'parts':[
  {'text':'用中文一句话描述这张图片里的主体。'},
  {'inlineData':{'mimeType':'image/png','data':d}}
]}]}
open('C:/tmp/img_payload.json','w').write(json.dumps(p))
"

curl -sS -m 90 -x http://127.0.0.1:2080 -X POST "$URL" \
  -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
  --data-binary "@C:/tmp/img_payload.json" -o C:/tmp/img_resp.json

python -c "import json; d=json.load(open('C:/tmp/img_resp.json',encoding='utf-8')); \
print('\n'.join(pt['text'] for c in d.get('candidates',[]) for pt in c.get('content',{}).get('parts',[]) if 'text' in pt))"
```

**实测输出**（从 `2020.mp4` 抽帧）：
> 图像的主体是一位悬浮在云层之上的动漫风格女性角色，背景是一座金碧辉煌的宫殿。

支持 MIME：`image/png`、`image/jpeg`、`image/webp`、`image/gif` 等。

## 5. PDF 推理（inline，已实测 ✅）

与图片同构，`mimeType` 改为 `application/pdf`：

```bash
python -c "
import base64, json
d = base64.b64encode(open('C:/Users/Houpy/Downloads/劳动合同书.pdf','rb').read()).decode()
p = {'contents':[{'parts':[
  {'text':'请用中文总结这份文件的关键内容，列出3-5个要点。'},
  {'inlineData':{'mimeType':'application/pdf','data':d}}
]}]}
open('C:/tmp/pdf_payload.json','w').write(json.dumps(p))
"

curl -sS -m 90 -x http://127.0.0.1:2080 -X POST "$URL" \
  -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
  --data-binary "@C:/tmp/pdf_payload.json" -o C:/tmp/pdf_resp.json
```

**实测输出**（劳动合同书）：
> 甲方：广西壮大氢能源科技有限公司；乙方：刘玉洁；期限 2026/6/1–2027/6/1；岗位总经理助理；月薪 3,800 元；社保依法办理…

## 6. 视频推理（Files API 上传 + fileData 引用，已实测 ✅）

四步：启动可恢复上传 → 上传二进制 → 轮询到 `ACTIVE` → `generateContent` 引用 `fileUri`。
完整脚本见 `C:/tmp/test_video.sh`，核心：

```bash
KEY="AQ.Ab8..."
MODEL="gemini-3.5-flash-lite"
VIDEO="C:/Users/Houpy/Downloads/2020.mp4"
MIME="video/mp4"
NUM_BYTES=$(wc -c < "$VIDEO" | tr -d ' ')

# 1) 启动可恢复上传，从响应头取 upload_url
curl -s -x http://127.0.0.1:2080 \
  "https://generativelanguage.googleapis.com/upload/v1beta/files" \
  -H "x-goog-api-key: ${KEY}" -D C:/tmp/hdr.txt \
  -H "X-Goog-Upload-Protocol: resumable" -H "X-Goog-Upload-Command: start" \
  -H "X-Goog-Upload-Header-Content-Length: ${NUM_BYTES}" \
  -H "X-Goog-Upload-Header-Content-Type: ${MIME}" \
  -H "Content-Type: application/json" \
  -d '{"file":{"display_name":"test_video"}}' -o /dev/null
UPLOAD_URL=$(grep -i "x-goog-upload-url:" C:/tmp/hdr.txt | sed 's/.*: //I' | tr -d '\r\n')

# 2) 上传二进制
curl -s -x http://127.0.0.1:2080 "$UPLOAD_URL" \
  -H "Content-Length: ${NUM_BYTES}" -H "X-Goog-Upload-Offset: 0" \
  -H "X-Goog-Upload-Command: upload, finalize" \
  --data-binary "@${VIDEO}" -o C:/tmp/file_info.json
FILE_NAME=$(python -c "import json;print(json.load(open('C:/tmp/file_info.json'))['file']['name'])")
FILE_URI=$(python -c "import json;print(json.load(open('C:/tmp/file_info.json'))['file']['uri'])")

# 3) 轮询到 ACTIVE
until [ "$(curl -s -x http://127.0.0.1:2080 "https://generativelanguage.googleapis.com/v1beta/${FILE_NAME}" -H "x-goog-api-key: ${KEY}" | python -c 'import sys,json;print(json.load(sys.stdin).get("state","?"))')" = ACTIVE ]; do
  sleep 3
done

# 4) generateContent 引用 fileUri
curl -s -m 180 -x http://127.0.0.1:2080 -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent" \
  -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
  -d '{"contents":[{"parts":[{"text":"请用中文描述这个视频的内容。"},
  {"fileData":{"mimeType":"video/mp4","fileUri":"'"${FILE_URI}"'"}}]}]}'
```

**实测输出**（`2020.mp4`，~8 秒）：
> 视频中，一个有着粉色长发的二次元动漫美少女悬浮在空中的云海之上，眼中闪烁魔法光彩，随后长出彩色羽翼、手持魔法棒。

支持视频 MIME：`video/mp4`、`video/mpeg`、`video/mov`、`video/avi`、`video/x-flv`、`video/webm` 等。

## 7. 音频推理与 SRT 字幕（inline，已实测 ✅）

音频走 inline（1 分钟 MP3 ≈1MB，**与视频不同，无需 Files API**）。场景：ffmpeg 抽音频 → 提交 → 输出 SRT。

```bash
KEY="AQ.Ab8..."
MODEL="gemini-3.5-flash"          # 字幕任务用 Flash 全量
URL="https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent"

ffmpeg -y -i "input.mkv" -t 60 -vn -acodec libmp3lame -b:a 128k -ac 1 -ar 44100 C:/tmp/audio1min.mp3

python -c "
import base64, json
d = base64.b64encode(open('C:/tmp/audio1min.mp3','rb').read()).decode()
p = {'contents':[{'parts':[
  {'text':'请将这段音频转录为 SRT 字幕。要求：1.标准 SRT 2.HH:MM:SS,mmm 3.按语义分句 4.时间轴准确 5.只输出 SRT\n\n示例：\n1\n00:00:01,200 --> 00:00:04,800\n哈喽大家好。\n'},
  {'inlineData':{'mimeType':'audio/mp3','data':d}}
]}]}
open('C:/tmp/audio_payload.json','w').write(json.dumps(p))
"

curl -sS -m 180 -x http://127.0.0.1:2080 -X POST "$URL" \
  -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
  --data-binary "@C:/tmp/audio_payload.json" -o C:/tmp/audio_resp.json
```

### 关键发现：Flash-Lite 不适合字幕任务

| | `gemini-3.5-flash-`**`lite`** | `gemini-3.5-flash`（全量） |
|---|---|---|
| 字幕段数 | **0**（整段塞一条） | **20 段** |
| 时间轴 | 单条 `00:00:00→01:21,500`（超 60s、不准） | 逐段递增 `00:00:00,100→01:06,600` |
| 内容 | 400 字，被 `…` 截断 | 1117 字，完整（finishReason: STOP） |

> 结构化任务**必须用 Flash 全量** + few-shot 示例；Flash-Lite 只产骨架。
> 音频 MIME：`audio/mp3`、`audio/wav`、`audio/aac`、`audio/ogg`、`audio/flac` 等。

---

## 8. 可选：开启 thinking

```json
{"contents":[{"parts":[{"text":"..."}]}],
 "generationConfig":{"thinkingConfig":{"thinkingLevel":"high"}}}
```
Gemini 3 thinking level：`minimal / low / medium / high`（**无法关闭**）。

## 9. 多轮对话（已实测 ✅）

工具调用回环（第 10 节）本身是 3 轮对话，已验证多轮可用。

**OpenAI 兼容** — `messages` 数组，role: `system`/`user`/`assistant`/`tool`（`developer` 不支持，OMP 已设 `supportsDeveloperRole: false`）：
```json
{"messages":[
  {"role":"system","content":"你是助手。"},
  {"role":"user","content":"我叫张三。"},
  {"role":"assistant","content":"你好，张三。"},
  {"role":"user","content":"我叫什么？"}
]}
```

**原生 generateContent** — `contents` 数组 role: `user`/`model`；系统指令是顶层 `systemInstruction`：
```json
{"contents":[
  {"role":"user","parts":[{"text":"我叫张三。"}]},
  {"role":"model","parts":[{"text":"你好，张三。"}]},
  {"role":"user","parts":[{"text":"我叫什么？"}]}
],
 "systemInstruction":{"parts":[{"text":"你是助手。"}]}}
```

## 10. 工具/函数调用（已实测 ✅，含 thought_signature 兼容性）

两端均支持函数调用：① 模型返回 function call → ② 喂回工具结果 → 模型给最终答案。

### ⚠️ 核心兼容性：thought_signature 必须原样回传

Gemini 首轮的 function call 附带 `thought_signature`。**回传 assistant 轮时必须原样塞回**，否则两端都 400：
> `Function call is missing a thought_signature in functionCall parts... required for tools to work correctly`

这是 **Gemini 独有、非 OpenAI 标准**——标准 OpenAI 客户端不透传该字段，**无法直接跑通 Gemini 工具多轮**。

**OpenAI 兼容**（已实测 ✅）：签名在 `tool_calls[].extra_content.google.thought_signature`，回传时整条 tool_calls（含签名 + 真 `id`）原样塞回，再附 `role:"tool"`（`tool_call_id` 对齐）。
- ❌ 省略签名 → 400
- ✅ 回传 →「北京现在是 18 度，天气晴朗。」

**原生 generateContent**（已实测 ✅）：`thoughtSignature` 是 `functionCall` 的**同级字段**（同 part 内），model 轮 part 带上它，再附 `functionResponse`。
- ❌ 省略 → 400
- ✅ 回传 →「北京现在的气温是 18 度，天气晴朗。」

> 详见 [thought-signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)。

## 11. 结构化输出（已实测 ✅）

原生用 `generationConfig.responseMimeType` + `responseSchema` 强制 JSON 按-schema：
```json
{"contents":[{"role":"user","parts":[{"text":"从'张三今年28岁在南宁做工程师'提取信息"}]}],
 "generationConfig":{
   "responseMimeType":"application/json",
   "responseSchema":{"type":"object","properties":{"name":{"type":"string"},"age":{"type":"integer"},"city":{"type":"string"},"job":{"type":"string"}},"required":["name","age","city","job"]},
   "temperature":0.2,"topP":0.9,"maxOutputTokens":256}}
```
**实测输出**：`{"name":"张三","age":28,"city":"南宁","job":"工程师"}`。
OpenAI 兼容等价 `response_format`（`json_object` / `json_schema`）。

## 12. 完整参数清单

### OpenAI 兼容端点（`/v1beta/openai/chat/completions`）

| 参数 | 说明 | Gemini 备注 |
|---|---|---|
| `model` | 模型 id | 必填 |
| `messages` | role: system/user/assistant/tool | 多轮 |
| `reasoning_effort` | `minimal`/`low`/`medium`/`high` | thinking；Gemini 3 无法关闭 |
| `tools` | `[{type:function,function:{name,description,parameters}}]` | 函数调用 |
| `tool_choice` | `auto`/`none`/指定 | |
| `response_format` | `json_object` / `json_schema` | 结构化输出 |
| `stream` | `true` | SSE 流式 |
| `temperature` `top_p` `max_tokens` `stop` `n` `presence_penalty` `frequency_penalty` `seed` `logprobs` | 标准采样 | |
| `extra_body.google.thinkingConfig` | `{thinkingLevel, includeThoughts}` | 与 reasoning_effort 互斥 |
| `extra_content.google.thought_signature` | 工具调用回传 | **必填**，见第 10 节 |
| 图片 | `messages[].content` 内 `image_url` | 仅图片 |

### 原生 `generateContent`（`/v1beta/models/{model}:generateContent`）

| 参数 | 字段 | 说明 |
|---|---|---|
| 对话 | `contents:[{role,parts}]` | role: user/model |
| 系统指令 | `systemInstruction:{parts:[{text}]}` | 顶层独立 |
| 工具 | `tools:[{functionDeclarations:[{name,description,parameters}]}]` | 函数调用 |
| 工具配置 | `toolConfig.functionCallingConfig` | mode: AUTO/ANY/NONE；`allowedFunctionNames` |
| 结构化 | `generationConfig.responseMimeType`=application/json | |
| 结构化 | `generationConfig.responseSchema` | JSON Schema |
| thinking | `generationConfig.thinkingConfig` | `{thinkingLevel, includeThoughts}` |
| 采样 | `generationConfig.temperature`/`topP`/`topK`/`maxOutputTokens`/`stopSequences`/`candidateCount` | topK 为 Gemini 特有 |
| 采样 | `generationConfig.presencePenalty`/`frequencyPenalty`/`responseLogprobs`/`logprobs` | |
| 安全 | `safetySettings:[{category,threshold}]` | 内容安全阈值 |
| 媒体 | `parts[].inlineData` / `parts[].fileData` | 图片/视频/音频/PDF |
| 工具回传 | `parts[].thoughtSignature`（functionCall 同级） | **必填**，见第 10 节 |
| 流式 | `:streamGenerateContent`（`?alt=sse`） | SSE |
| 计数 | `:countTokens` | 预估 token |
| 缓存 | 顶层 `cachedContent` 引用 | 显式缓存（仅 generateContent） |

---

## 13. 流式输出与 token 计数（已实测 ✅）

**streamGenerateContent** — SSE 增量返回（`?alt=sse`，每块是部分 candidates）：
```bash
curl -N -x http://127.0.0.1:2080 -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:streamGenerateContent?alt=sse" \
  -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"你好"}]}]}'
```
> 实测：6 字回复 → 2 个 `data: {...}` SSE chunk。OpenAI 兼容等价 `stream:true`。

**countTokens** — 预估 token 数（不消耗推理额度）：
```bash
curl -s -x http://127.0.0.1:2080 -X POST \
  "https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:countTokens" \
  -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
  -d '{"contents":[{"role":"user","parts":[{"text":"一首关于秋天的短诗。"}]}]}'
```
> 实测：`{"totalTokens":13,"promptTokensDetails":[{"modality":"TEXT","tokenCount":13}]}`

## 14. Interactions API（新推荐端点，已实测 ✅）

Google 2026-06 GA 的统一端点 `POST /v1beta/interactions`，所有新功能在此上线；`generateContent` 仍支持但算 legacy。请求体用 `model` + `input`（字符串或 `{type,data,...}` 数组）+ `tools` + `response_format` + `system_instruction` + `generation_config`：
```bash
curl -s -x http://127.0.0.1:2080 -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash-lite","input":"用中文一句话说你好","store":false}'
```
响应是 `steps[]` 数组（执行步骤），**不是** `candidates`/`output_text`：
```json
{"status":"completed","model":"gemini-3.5-flash-lite",
 "usage":{"total_tokens":9,"total_input_tokens":7,"total_cached_tokens":0,"total_output_tokens":2,...},
 "steps":[
   {"type":"thought","signature":"..."},
   {"type":"model_output","content":[{"type":"text","text":"你好！"}]}
 ]}
```
步骤类型：`thought` / `model_output` / `function_call` / `function_result` / `code_execution_call` / `code_execution_result` / `google_search_call` / `google_search_result`。

特性：
- **服务端状态**：`previous_interaction_id` 续接对话（不必重发历史）；`store=true`（默认）保留——免费层 1 天 / 付费 55 天；`store=false` 无状态（不能用 previous_interaction_id）。
- **隐式缓存**：Interactions API 仅支持隐式缓存（显式缓存要 generateContent，见第 16 节）。
- **Interactions API 不支持**（需 generateContent）：video_metadata、Batch API、自动函数调用(Python)、显式缓存、自定义 safety settings。

## 15. 内置工具：代码执行 & Google 搜索接地

**代码执行**（已实测 ✅）— `tools:[{type:"code_execution"}]`，模型生成并在沙箱跑 Python：
```bash
curl -s -x http://127.0.0.1:2080 -X POST "https://generativelanguage.googleapis.com/v1beta/interactions" \
  -H "x-goog-api-key: ${KEY}" -H "Content-Type: application/json" \
  -d '{"model":"gemini-3.5-flash-lite","store":false,
       "input":"前50个质数之和是多少？生成并运行代码。",
       "tools":[{"type":"code_execution"}]}'
```
实测：模型写 `is_prime()` → 沙箱执行 → `code_execution_call`(代码) + `code_execution_result`(质数列表) + `model_output`(答案)。Gemini 3 Flash 还能用代码操作图片（需同时开 thinking）。

**Google 搜索接地**（免费层不可用 ❌）— `tools:[{type:"google_search"}]`：
实测免费 key → `429 too_many_requests: You exceeded your current quota`。
> 定价表确认 grounding 免费层 "Not available"（仅 AI Studio 内可试）；付费层每月 5000 次免费搜索（Gemini 3.x 共享），之后 $14/1000 次。响应含 `google_search_call`(queries) + `google_search_result`(search_suggestions HTML) + `model_output.content[].annotations`(url_citation 内联引用)。同族还有 Google Maps 接地（仅 Gemini 3.5 Flash+，付费）。

## 16. 上下文缓存

- **隐式缓存**（自动）：Gemini 2.5+ 默认开启；3.x 最小 4096 token 才可能命中。把大段公共内容放 prompt 前部、短时间发同前缀请求可提高命中率。命中数看 `usage.total_cached_tokens`（Interactions）/ `usageMetadata.cacheRead`（generateContent）。免费层缓存价格 "Free of charge"。
- **显式缓存**（手动 `createCachedContent` + 引用 `cachedContent`）：**仅 generateContent 支持**，Interactions API 不支持。适合复用固定大上下文（如长文档/系统提示），可设 TTL。

## 17. Batch API（免费层不可用 ❌）

`POST /v1beta/models/{model}:batchGenerateContent`，异步批处理，标准价 5 折，24h 内返回。两种输入：
- **内联 requests 列表**（<20MB，`batch.input_config.requests.requests[]`）
- **JSONL 输入文件**（Files API 上传，≤2GB，每行一个 `GenerateContentRequest`）
> 定价表确认免费层 Batch "Not available"，需付费层；且 Batch 仅 generateContent 支持（Interactions API 不支持）。

---

## 18. 已知坑

| 坑 | 说明 | 解法 |
|---|---|---|
| **工具调用漏 thought_signature** | 回传 assistant 轮不带首轮 `thought_signature` → 400 | 把首轮 `extra_content.google.thought_signature`（兼容）/`thoughtSignature`（原生）原样塞回，id 对齐 |
| **Google 搜索接地免费层不可用** | `google_search` 工具在免费层返回 429 配额错误 | 升付费层；或免费层仅 AI Studio 内可试 |
| **Batch API 免费层不可用** | `batchGenerateContent` 免费层不可用 | 升付费层 |
| **Windows `/tmp` 路径错位** | Windows Python 把 `/tmp/x`→`C:\tmp\x`，Git Bash curl/ls→MSYS 挂载点 → curl 报 `error reading file` | 全程用绝对路径 `C:/tmp/xxx` |
| **curl 单行命令解析失败** | 单行长 curl 偶发 `option : blank argument` | 用脚本文件或反斜杠续行多行 |
| **直连 POST 被重置** | 直连 generativelanguage.googleapis.com 的 POST 被 GFW 重置（返回空） | 加 `-x http://127.0.0.1:2080` 走代理 |
| **inline 视频挂死** | 1MB 视频 inline 走代理 5 分钟无响应 | 视频走 Files API（上传→ACTIVE→引用） |
| **Flash-Lite 不产结构化输出** | 字幕/分句任务 Lite 只产一坨文本、时间轴不准、易截断 | 结构化任务用 Flash 全量 + few-shot |
| **Interactions API 响应无 output_text** | 原生 REST 返回 `steps[]`，SDK 的 `output_text` 便利字段不在 REST 顶层 | 解析 `steps`，取 `model_output.content[].text` |
| **免费层限制** | 单文件≤2GB；上传文件 48h 自动删；RPM/TPM/RPD 速率限制；内容可能被 Google 用于产品改进 | 大量调用需升 Tier；敏感数据慎用免费层 |

## 19. 文件清单（本机已留存）

| 文件 | 用途 |
|---|---|
| `C:/tmp/test_image.sh` | 图片 inline 推理 |
| `C:/tmp/test_pdf.sh` | PDF inline 推理 |
| `C:/tmp/test_video.sh` | 视频 Files API 推理（四步） |
| `C:/tmp/test_audio_srt.sh` / `test_audio_srt_flash.sh` | 音频 SRT 转录（Lite / 全量+few-shot） |
| `C:/tmp/test_oai_tools.sh` / `test_oai_tools2.sh` | OpenAI 兼容端工具调用（首轮 / 回环含 sig） |
| `C:/tmp/test_native_tools.sh` / `test_native_tools2.sh` | 原生端工具调用（首轮 / 回环含 sig） |
| `C:/tmp/test_struct.sh` | 原生结构化输出（responseSchema） |
| `C:/tmp/test_extra.sh` | countTokens / 流式 / Interactions / 代码执行 / 搜索接地 |
| `C:/Users/Houpy/Downloads/太空戰士6_audio1min.srt` | 实测生成的 SRT 字幕（20 段） |
| `C:/tmp/*_payload.json` / `*_resp.json` | 各次请求/响应留档 |

## 20. 与 OMP 的关系

- OMP `models.yml` 的 `google-aistudio` provider 走 **OpenAI 兼容端点**（`openai-completions`），只能 text+image。
- 本指南的 curl 调用走**原生 `generateContent` / Interactions API**，是 OMP 之外的能力补充。
- OMP 的 `input` 字段硬约束 `("text" | "image")[]`，源码无 video/audio/pdf 媒体管线——**无法通过改 OMP 配置让模型收到视频/音频**。需要时直接用本指南的 curl 脚本。
- **三条独立路径**：① OMP 内置模型调用（OpenAI 兼容，text+image）；② OMP `toolconv` 层的 Gemini `tool_code` 方言工具调用；③ 本指南手工 curl（原生/Interactions，全模态）。若 OMP 未透传 `thought_signature`，其内置 Gemini 工具多轮可能受第 10 节的 400 约束（取决于 OMP 版本是否处理签名）。

---

*源：[models/定价](https://ai.google.dev/gemini-api/docs/models)、[video-understanding](https://ai.google.dev/gemini-api/docs/video-understanding)、[audio](https://ai.google.dev/gemini-api/docs/audio)、[files](https://ai.google.dev/gemini-api/docs/files)、[function-calling](https://ai.google.dev/gemini-api/docs/function-calling)、[structured-output](https://ai.google.dev/gemini-api/docs/structured-output)、[thought-signatures](https://ai.google.dev/gemini-api/docs/thought-signatures)、[openai 兼容](https://ai.google.dev/gemini-api/docs/openai)、[interactions-overview](https://ai.google.dev/gemini-api/docs/interactions-overview)、[code-execution](https://ai.google.dev/gemini-api/docs/code-execution)、[caching](https://ai.google.dev/gemini-api/docs/caching)、[batch-api](https://ai.google.dev/gemini-api/docs/batch-api)、[google-search](https://ai.google.dev/gemini-api/docs/google-search)；OMP 限制见 [oh-my-pi models.md](https://github.com/can1357/oh-my-pi/blob/main/docs/models.md) `input: ("text" | "image")[]`。除 Batch/显式缓存（免费层不可用/复杂）外，命令均经实测。*