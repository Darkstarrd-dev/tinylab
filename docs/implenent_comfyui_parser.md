# ComfyUI 元数据读取/写入实现笔记

> 目标：① 从 ComfyUI 生成的图片/视频中读取 prompt 等信息；② 给图片/视频写入与 ComfyUI **完全同模式** 的元数据（拖回 ComfyUI 画布可直接还原工作流）。
> 读取全部可用纯标准库实现（不依赖 ComfyUI / PIL / PyAV）；PNG 写入同样纯标准库，MP4 写入用 PyAV（ComfyUI 自带的库）或 ffmpeg。

---

## 1. ComfyUI 元数据格式规范（写入端源码依据）

元数据固定为两个 JSON 字符串键：

| 键 | 内容 | 用途 |
|---|---|---|
| `prompt` | API 格式：`{节点ID: {inputs, class_type, _meta}}` | POST `/prompt` 可原样重跑 |
| `workflow` | UI 图格式：`{id, revision, last_node_id, links, nodes[]}` | 前端画布直接重建 |

**PNG 写入**（`ComfyUI/nodes.py` `SaveImage.save_images`，约 1692-1703 行）：

```python
metadata = PngInfo()
metadata.add_text("prompt", json.dumps(prompt))          # 注意 ensure_ascii=True（默认）
for x in extra_pnginfo:                                  # extra_pnginfo 含前端传来的 workflow
    metadata.add_text(x, json.dumps(extra_pnginfo[x]))
img.save(path, pnginfo=metadata)
```

PIL 把可 latin-1 编码的文本写成 **tEXt 块**。`json.dumps` 默认 `ensure_ascii=True`，中文变成 `\uXXXX` 转义 → 纯 ASCII → 全部落在 tEXt 块里（实测 Anima 文件的 `_meta.title` 就是 `"\u4fdd\u5b58\u56fe\u50cf"` 形式）。新版还有 `comfy_extras/nodes_images.py::inject_png_metadata` 手工在 IHDR 后插 tEXt 块，格式一致。

**MP4 写入**（`comfy_extras/nodes_video.py` SaveVideo → `comfy_api/latest/_input_impl/video_types.py` `save_to`/`write_output_metadata`）：PyAV 打开输出容器时 `options={"movflags": "use_metadata_tags"}`，然后 `output.metadata[key] = json.dumps(value)`。FFmpeg mov muxer 把标签写进 **`moov/udta/meta`**（mdta 风格：`keys` 盒 + `ilst` 盒）。实测真实文件结构（MiniMax_H3 MP4）：

```
moov
 └ udta
    └ meta                 ← full box：version/flags 4 字节后才是子盒
       ├ hdlr
       ├ keys              ← 53 字节
       │   00 00 00 00            version/flags
       │   00 00 00 03            entry_count = 3
       │   00 00 00 10 6d 64 74 61 77 6f 72 6b 66 6c 6f 77   条目1: size=16, namespace='mdta', "workflow"
       │   00 00 00 0e 6d 64 74 61 70 72 6f 6d 70 74         条目2: size=14, namespace='mdta', "prompt"
       │   00 00 00 0f 6d 64 74 61 65 6e 63 6f 64 65 72      条目3: size=15, namespace='mdta', "encoder"
       └ ilst
            00 00 77 fd 00 00 00 01   条目: size=30717, index=1（对应 keys 第 1 项）
            00 00 77 f5 64 61 74 61   data 子盒: size, 'data'
            00 00 00 01 00 00 00 00   type/flags=1(UTF-8), locale=0
            {"id": "e3f2b845-..."}    值 = workflow JSON
            ...（index=2 → prompt，index=3 → encoder）
```

> 坑：FFmpeg 的 `keys` 条目格式是 `size(4) + namespace(4) + value`，**没有** `'key '` 4CC（早期理解错会读偏 4 字节，把 `workflow` 读成 `flow`）。

---

## 2. 读取实现（纯标准库）

### 2.1 PNG — 遍历 chunk

```python
_PNG_SIG = b"\x89PNG\r\n\x1a\n"

def read_png_text(data: bytes) -> dict:
    """返回 {关键字: 文本}，支持 tEXt / zTXt / iTXt。"""
    out = {}
    pos, end = 8, len(data)
    while pos + 8 <= end:
        length = struct.unpack(">I", data[pos:pos+4])[0]
        ctype = data[pos+4:pos+8]
        body = data[pos+8:pos+8+length]
        if ctype == b"IEND":
            break
        if ctype in (b"tEXt", b"zTXt", b"iTXt"):
            key, _, rest = body.partition(b"\x00")
            key = key.decode("latin-1")                 # 关键字按 latin-1
            if ctype == b"tEXt":
                out[key] = rest.decode("latin-1")
            elif ctype == b"zTXt":
                out[key] = zlib.decompress(rest[1:]).decode("latin-1")
            else:  # iTXt: compflag(1) compmethod(1) lang\0 translated\0 text
                compflag = rest[0]
                text = rest.partition(b"\x00")[2].partition(b"\x00")[2]
                if compflag:
                    text = zlib.decompress(text)
                out[key] = text.decode("utf-8")
        pos += 12 + length
    return out
```

### 2.2 MP4 — 走盒到 moov/udta/meta，解析 keys + ilst

```python
def walk_boxes(data, start, end, wanted):
    """一层内找 wanted 中的盒，返回 {type: [(body_start, body_end)]}。"""
    found, pos = {}, start
    while pos + 8 <= end:
        size, typ = struct.unpack(">I4s", data[pos:pos+8])
        hdr = 8
        if size == 1:
            size = struct.unpack(">Q", data[pos+8:pos+16])[0]; hdr = 16
        elif size == 0:
            size = end - pos
        if size < hdr or pos + size > end:
            break
        if typ in wanted:
            found.setdefault(typ, []).append((pos + hdr, pos + size))
        pos += size
    return found

def read_mp4_meta(data: bytes) -> dict:
    """返回 {键: 值文本}。moov → udta → meta（跳过 4 字节 version/flags）→ keys + ilst。"""
    for mstart, mend in walk_boxes(data, 0, len(data), {b"moov"}).get(b"moov", []):
        for ustart, uend in walk_boxes(data, mstart, mend, {b"udta"}).get(b"udta", []):
            for metastart, metaend in walk_boxes(data, ustart, uend, {b"meta"}).get(b"meta", []):
                body = walk_boxes(data, metastart + 4, metaend, {b"keys", b"ilst"})
                # keys: version/flags(4) count(4) 条目=size(4)+namespace(4)+value
                keys = {}
                for ks, ke in body.get(b"keys", []):
                    count = struct.unpack(">I", data[ks+4:ks+8])[0]
                    pos = ks + 8
                    for i in range(count):
                        size = struct.unpack(">I", data[pos:pos+4])[0]
                        keys[i+1] = data[pos+8:pos+size].decode("utf-8", "replace")
                        pos += size
                # ilst: 条目=size(4)+index(4)+子盒; 'data'子盒=type(4)+locale(4)+值
                items = {}
                for ls, le in body.get(b"ilst", []):
                    pos = ls
                    while pos + 8 <= le:
                        size = struct.unpack(">I", data[pos:pos+4])[0]
                        idx = data[pos+4:pos+8]                       # mdta: 1基索引
                        for ds, de in walk_boxes(data, pos+8, pos+size, {b"data"}).get(b"data", []):
                            items[idx] = data[ds+8:de].decode("utf-8", "replace")
                        pos += size
                out = {}
                for idx, val in items.items():
                    n = int.from_bytes(idx, "big")
                    if n in keys:
                        out[keys[n]] = val          # mdta 风格
                    else:
                        out[idx.decode("latin-1")] = val   # iTunes 风格 4CC 兜底
                if out:
                    return out
    return {}
```

**验证结果**（`C:\ComfyUI\ComfyUI\ComfyUI\output`，2026-08-10 实测）：
- 23/23 PNG、48/48 MP4 全部提取出 `prompt` + `workflow`
- MP4 提取结果与 PyAV 解复用器（`av.open().metadata`）**字节级一致**
- 读取无需任何依赖；文件类型按魔数自动识别（PNG 签名 / RIFF+WEBP / 其他按 MP4 尝试）

---

## 3. 写入实现（与 ComfyUI 同模式）

### 3.1 PNG — 纯标准库构造 tEXt 块

```python
def tex_chunk(keyword: str, text: str) -> bytes:
    """PNG 块: 长度(4, 不含type!) + 'tEXt' + keyword\0text + CRC32(type+data)。"""
    data = keyword.encode("latin-1") + b"\x00" + text.encode("utf-8")
    chunk = struct.pack(">I", len(data)) + b"tEXt" + data
    chunk += struct.pack(">I", zlib.crc32(chunk[4:]) & 0xFFFFFFFF)
    return chunk

def write_png_metadata(path: str, metadata: dict, out_path: str = None) -> None:
    data = open(path, "rb").read()
    parts, inserted = [data[:8]], False
    for pos in range(8, len(data)):                 # 逐块遍历（见读取实现）
        ...  # ① IHDR 块后插入新 tEXt 块（每键一个）
        ...  # ② 删除同关键字旧文本块（tEXt/zTXt/iTXt），其余原样保留
    open(out_path or path, "wb").write(b"".join(parts))
```

写入要点（全部踩过坑，已验证）：

1. **length 字段 = data 长度，不含 `tEXt` 类型 4 字节**。写错整个文件被读坏（PIL 无法识别）。
2. **CRC32 覆盖 type + data**（即 chunk 从第 4 字节起）。
3. **`json.dumps(..., ensure_ascii=True)`（默认）**——ComfyUI 就是默认。PIL 读 tEXt 按 **latin-1**，非 ASCII 的 UTF-8 字节会乱码；`\uXXXX` 转义则安全往返。实测中文 prompt 写入后 PIL 读回完全一致。
4. **替换语义**：读端对重复关键字的行为不一致（PIL 取第一个），写入时删除同键旧块再插新块，结果确定。
5. 新块插在 IHDR 之后即可（ComfyUI 也这么做）；IDAT/IEND 及像素数据完全不碰，文件无需重编码。

### 3.2 MP4 — 与 ComfyUI 同款 PyAV 路径

```python
import av
def write_mp4_metadata(path: str, metadata: dict, out_path: str = None) -> None:
    with av.open(path, mode="r") as container:
        with av.open(out_path or path, mode="w",
                     options={"movflags": "use_metadata_tags"}) as output:
            for key, value in container.metadata.items():   # 保留原标签
                if key not in metadata:
                    output.metadata[key] = value
            for key, value in metadata.items():             # 叠加/覆盖新键
                output.metadata[key] = json.dumps(value, ensure_ascii=True)
            for stream in container.streams:                # 流模板复制 + 包透传
                if stream.codec_context is None:
                    continue
                out_stream = output.add_stream_from_template(template=stream, opaque=True)
            for packet in container.demux():
                ...
```

这正是 `ComfyUI/comfy_api/latest/_input_impl/video_types.py` `save_to()` 的机制（重封装/流复制，不改像素）。等价 ffmpeg CLI：

```bash
ffmpeg -i in.mp4 -c copy \
  -metadata prompt='{"1":{"inputs":{...},"class_type":"SaveVideo"}}' \
  -metadata workflow='{"id":"..."}' \
  -movflags use_metadata_tags out.mp4
```

纯手写 moov 手术（不依赖 PyAV）理论可行：构造 `keys` + `ilst` 盒插入 `moov/udta/meta`，逐层重算父盒 size，整个文件按增量平移；但复杂度高、易错，MP4 写入场景建议直接用 PyAV（ComfyUI 环境自带）或 ffmpeg。

### 3.3 写入验证记录（实证）

| 测试 | 方法 | 结果 |
|---|---|---|
| PNG 写入 | 纯 stdlib 构造 tEXt，替换旧块 | PIL 读回 keys=`['prompt','workflow']`，值与写入完全一致；文件仅差元数据字节，像素未动 |
| PNG 中文 | `ensure_ascii=True` | PIL 往返一致（latin-1 安全） |
| MP4 写入 | PyAV remux + use_metadata_tags | 纯 stdlib 解析器读回 `prompt`/`workflow` 正确；PyAV 交叉验证一致 |

---

## 4. 交付工具

`C:\ComfyUI\comfy_metadata_extract.py`（纯标准库读取 + PNG 纯标准库写入 + MP4 PyAV 写入）：

```bash
# 读取：扫描目录 / 单文件 / 只取某键 / 导出侧车 JSON
python comfy_metadata_extract.py "C:\ComfyUI\ComfyUI\ComfyUI\output"
python comfy_metadata_extract.py -k workflow "output\video\MiniMax_H3_00001_.mp4"
python comfy_metadata_extract.py -o sidecars "output\Anima_00001_.png"

# 写入：与 ComfyUI 同格式（原地覆盖；--out 指定输出文件）
python comfy_metadata_extract.py --set 'prompt={"1":{"inputs":{"filename_prefix":"x"},"class_type":"SaveImage"}}' \
                                  --set 'workflow={"id":"x","nodes":[],"links":[]}' 图片.png
python comfy_metadata_extract.py --set 'prompt=...' --set 'workflow=...' 视频.mp4
```

写入后再把文件拖回 ComfyUI 画布即可还原/加载工作流。

---

## 5. 注意事项

- ComfyUI 以 `--disable-metadata` 启动时不写任何元数据；老版本视频还会写成旁路 `.json`（当前版本不会）。
- 平台/聊天软件转存、截图、重编码会剥掉元数据（tEXt 块、MP4 标签都经不起重封装）。
- PIL 读 PNG tEXt 按 latin-1；`ensure_ascii=False` 写入的中文会乱码——这是最容易踩的坑。
- 在线 API（Google Nano Banana / OpenAI GPT Image）不嵌 prompt，只嵌 C2PA 签名溯源 + SynthID 水印，与本文档的"ComfyUI 模式"无关。
