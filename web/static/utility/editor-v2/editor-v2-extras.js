/**
 * Editor V2 - Extras (Image handling, Save-As asset collection, AI Assistant)
 */
(() => {
  'use strict';

  let layoutRefs = null;
  let currentCodeEditor = null;
  let activeAbortController = null;

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function getActiveTab() {
    return window.EditorV2 ? window.EditorV2.getActiveTab() : null;
  }

  function sanitizeStem(name) {
    if (!name) return 'doc';
    const base = name.replace(/\.[^/.]+$/, '');
    const clean = base.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
    return clean || 'doc';
  }

  // --- Image Compression & Insertion ---

  /**
   * Compresses image using HTML5 Canvas (or preserves GIF)
   * Target: webp quality 0.7, max dimension 1920
   */
  async function compressImageFile(file) {
    if (file.type === 'image/gif') {
      return { blob: file, ext: 'gif' };
    }

    return new Promise((resolve) => {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(objectUrl);
        let { width, height } = img;
        const maxDim = 1920;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        if (canvas.toBlob) {
          canvas.toBlob((blob) => {
            if (blob) {
              resolve({ blob, ext: 'webp' });
            } else {
              resolve({ blob: file, ext: file.type.split('/')[1] || 'png' });
            }
          }, 'image/webp', 0.7);
        } else {
          resolve({ blob: file, ext: file.type.split('/')[1] || 'png' });
        }
      };

      img.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        resolve({ blob: file, ext: file.type.split('/')[1] || 'png' });
      };

      img.src = objectUrl;
    });
  }

  async function processImageFile(file, optAltName = '') {
    if (!file || !file.type.startsWith('image/')) return;
    const tab = getActiveTab();
    if (!tab || !currentCodeEditor) return;

    try {
      const { blob, ext } = await compressImageFile(file);
      const uuid = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
      const filename = `img_${uuid}.${ext}`;

      const stem = sanitizeStem(tab.name);
      const folderName = tab.untitled ? 'untitled_imgs' : `${stem}_imgs`;
      const assetKey = `${folderName}/${filename}`;

      if (!tab.assets) {
        tab.assets = new Map();
      }
      tab.assets.set(assetKey, blob);

      const relPath = `./${folderName}/${filename}`;
      const altText = optAltName || (file.name ? file.name.replace(/\.[^/.]+$/, '') : filename);
      const mdText = `\n![${altText}](${relPath})\n`;

      const sel = currentCodeEditor.getSelection();
      currentCodeEditor.pushUndoStop();
      currentCodeEditor.executeEdits('insert-image', [{
        range: sel,
        text: mdText,
        forceMoveMarkers: true,
      }]);
      currentCodeEditor.pushUndoStop();
      currentCodeEditor.focus();

      if (window.toast) {
        window.toast(`已插入图片: ${filename}`, 'success');
      }
    } catch (err) {
      console.error('[EditorV2Extras] Failed to process image:', err);
      if (window.toast) {
        window.toast('处理图片失败: ' + err.message, 'error');
      }
    }
  }

  // --- Save As External Image Harvesting ---

  /**
   * Scans markdown text for referenced local images.
   * If not already in tab.assets and tab has a target (pathGrantId / fileId),
   * fetches image blob from /api/editor/file-image and populates tab.assets.
   */
  async function prepareSaveAsAssets(tab) {
    if (!tab || !tab.model) return;
    if (!tab.target || (!tab.target.pathGrantId && !tab.target.fileId)) return;
    if (!tab.assets) tab.assets = new Map();

    const text = tab.model.getValue();
    const mdImageRegex = /!\[.*?\]\(((\.?\/)?([a-zA-Z0-9_\-\./]+?\.(png|jpe?g|gif|webp|bmp|svg)))\)/gi;

    let match;
    const toFetch = [];

    while ((match = mdImageRegex.exec(text)) !== null) {
      const fullPath = match[1];
      if (fullPath.startsWith('http://') || fullPath.startsWith('https://') || fullPath.startsWith('data:')) {
        continue;
      }
      // Normalize relative path
      const rel = fullPath.startsWith('./') ? fullPath.slice(2) : fullPath;
      if (!tab.assets.has(rel) && !tab.assets.has(rel.split('/').pop())) {
        toFetch.push(rel);
      }
    }

    if (toFetch.length === 0) return;

    for (const rel of toFetch) {
      let url = '/api/editor/file-image?rel=' + encodeURIComponent(rel);
      if (tab.target.pathGrantId) {
        url += '&pathGrantId=' + encodeURIComponent(tab.target.pathGrantId);
      } else if (tab.target.fileId) {
        url += '&fileId=' + encodeURIComponent(tab.target.fileId);
      }

      const res = await fetch(url);
      if (res.ok) {
        const blob = await res.blob();
        tab.assets.set(rel, blob);
      } else {
        throw new Error(`无法读取引用的图片 "${rel}" (${res.status} ${res.statusText})`);
      }
    }
  }

  // --- Insert Image Modal ---

  function showImageModal() {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.zIndex = '99999';

    overlay.innerHTML = `
      <div class="modal modal-card" role="dialog" style="max-width: 480px; width: 90%;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center;">
          <h3 style="margin: 0; display: flex; align-items: center; gap: 8px;">
            <i class="codicon codicon-file-media"></i>
            <span>插入图片 (Insert Image)</span>
          </h3>
          <button class="ed2-icon-btn" id="ed2-img-modal-close" style="font-size: 16px;">×</button>
        </div>
        <div class="modal-body" style="padding: 16px 0; display: flex; flex-direction: column; gap: 14px;">
          <!-- Local Upload Drop Zone -->
          <div>
            <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 6px;">本地图片 (支持粘贴、拖拽或点击选择)</label>
            <div id="ed2-img-drop-zone" style="border: 2px dashed var(--border-color, #444); border-radius: 8px; padding: 20px; text-align: center; cursor: pointer; background: var(--bg-hover, rgba(255,255,255,0.03));">
              <i class="codicon codicon-cloud-upload" style="font-size: 28px; display: block; margin-bottom: 6px; opacity: 0.7;"></i>
              <div style="font-size: 13px; color: var(--text-base, #eee);">点击选择本地图片或拖入文件</div>
              <div style="font-size: 11px; color: var(--text-muted, #888); margin-top: 4px;">将自动压缩为高质量 WebP 并存入当前文档资产</div>
              <input type="file" id="ed2-img-file-input" accept="image/*" style="display: none;" />
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 8px; opacity: 0.5; font-size: 11px;">
            <div style="flex: 1; height: 1px; background: var(--border-color, #444);"></div>
            <span>或者输入网络图片</span>
            <div style="flex: 1; height: 1px; background: var(--border-color, #444);"></div>
          </div>

          <!-- Web URL -->
          <div>
            <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">图片 URL</label>
            <input type="text" class="input" id="ed2-img-url" placeholder="https://example.com/image.png" style="width: 100%; box-sizing: border-box;" />
          </div>
          <div>
            <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">替代文本 (Alt Text)</label>
            <input type="text" class="input" id="ed2-img-alt" placeholder="图片说明" style="width: 100%; box-sizing: border-box;" />
          </div>
        </div>

        <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 8px;">
          <button class="btn btn-ghost" id="ed2-img-btn-cancel">取消</button>
          <button class="btn btn-primary" id="ed2-img-btn-insert-url">插入网络图片</button>
        </div>
      </div>
    `;

    function cleanup() {
      overlay.remove();
    }

    const fileInput = overlay.querySelector('#ed2-img-file-input');
    const dropZone = overlay.querySelector('#ed2-img-drop-zone');
    const urlInput = overlay.querySelector('#ed2-img-url');
    const altInput = overlay.querySelector('#ed2-img-alt');

    overlay.querySelector('#ed2-img-modal-close').onclick = cleanup;
    overlay.querySelector('#ed2-img-btn-cancel').onclick = cleanup;

    dropZone.onclick = () => fileInput.click();

    dropZone.ondragover = (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--accent-color, #4f46e5)';
    };

    dropZone.ondragleave = () => {
      dropZone.style.borderColor = 'var(--border-color, #444)';
    };

    dropZone.ondrop = async (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--border-color, #444)';
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0 && files[0].type.startsWith('image/')) {
        cleanup();
        await processImageFile(files[0]);
      }
    };

    fileInput.onchange = async () => {
      if (fileInput.files && fileInput.files.length > 0) {
        cleanup();
        await processImageFile(fileInput.files[0]);
      }
    };

    overlay.querySelector('#ed2-img-btn-insert-url').onclick = () => {
      const url = urlInput.value.trim();
      if (!url) {
        if (window.toast) window.toast('请输入网络图片 URL', 'warning');
        return;
      }
      const alt = altInput.value.trim() || 'image';
      cleanup();
      if (currentCodeEditor) {
        const sel = currentCodeEditor.getSelection();
        const mdText = `![${alt}](${url})\n`;
        currentCodeEditor.pushUndoStop();
        currentCodeEditor.executeEdits('insert-web-image', [{
          range: sel,
          text: mdText,
          forceMoveMarkers: true,
        }]);
        currentCodeEditor.pushUndoStop();
        currentCodeEditor.focus();
      }
    };

    document.body.appendChild(overlay);
  }

  // --- AI Assistant Modal & Streaming ---

  const PROMPT_TEMPLATES = [
    {
      id: 'polish',
      label: '润色优化 (Polish)',
      systemPrompt: '你是一个专业的写作与文字编辑助手。请根据用户的要求优化给定的文本，修正语法错误、病句、错别字，保持原意并使表达更通畅精炼。只输出优化后的文本正文，严禁输出任何前言、后记、问候语或解释。',
      userPromptTpl: (txt) => `请帮我润色优化以下文本，使其通顺、专业、自然：\n\n${txt}`
    },
    {
      id: 'continue',
      label: '自然续写 (Continue)',
      systemPrompt: '你是一个专业的创意与逻辑写作助手。请根据用户提供的文本与上下文，进行自然、连贯、富有洞见的续写。只输出续写的正文内容，严禁输出任何问候或对话说明。',
      userPromptTpl: (txt) => `请根据以下前文内容，承接上下文进行自然续写：\n\n${txt}`
    },
    {
      id: 'summarize',
      label: '要点摘要 (Summarize)',
      systemPrompt: '你是一个精炼的分析助手。请对给定文本提炼出核心要点，条理清晰、言简意赅。只输出摘要内容。',
      userPromptTpl: (txt) => `请总结并提炼以下内容的核心要点：\n\n${txt}`
    },
    {
      id: 'rewrite',
      label: '风格改写 (Rewrite)',
      systemPrompt: '你是一个语言表达专家。请在忠实原意的前提下，换用另一种更生动、通俗易懂或更严谨有力的风格改写给定文本。只输出改写后的正文。',
      userPromptTpl: (txt) => `请用更具表现力的方式重新表述以下内容：\n\n${txt}`
    },
    {
      id: 'explain',
      label: '概念解释 (Explain)',
      systemPrompt: '你是一个博学的技术与知识导师。请对给定文本中的核心概念、背景或术语进行通俗透彻的解释说明。',
      userPromptTpl: (txt) => `请详细解释以下内容中的概念与含义：\n\n${txt}`
    },
    {
      id: 'custom',
      label: '自定义指令 (Custom)',
      systemPrompt: '你是一个高效智能的写作助手。请根据用户的指令完成任务，只输出最终正文。',
      userPromptTpl: (txt) => txt ? `文本内容：\n${txt}\n\n请按要求处理。` : ''
    },
  ];

  function showAiModal() {
    if (!currentCodeEditor) return;
    const model = currentCodeEditor.getModel();
    if (!model) return;

    const sel = currentCodeEditor.getSelection();
    const hasSelection = sel && !sel.isEmpty();
    const selectedText = hasSelection ? model.getValueInRange(sel).trim() : '';

    let selectedModel = localStorage.getItem('tinylab_editor_ai_model') || '';
    let currentTplIndex = 0;
    let accumulatedReply = '';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.zIndex = '99999';

    overlay.innerHTML = `
      <div class="modal modal-card" role="dialog" style="max-width: 620px; width: 92%; max-height: 90vh; display: flex; flex-direction: column;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border-color, rgba(255,255,255,0.1)); padding-bottom: 12px;">
          <h3 style="margin: 0; display: flex; align-items: center; gap: 8px;">
            <i class="codicon codicon-sparkle" style="color: var(--accent-color, #6366f1);"></i>
            <span>AI 写作与编辑助手</span>
          </h3>
          <button class="ed2-icon-btn" id="ed2-ai-modal-close" style="font-size: 16px;">×</button>
        </div>

        <div class="modal-body" style="padding: 14px 0; overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 12px;">
          <!-- Model Selection Row -->
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <label style="font-size: 12px; font-weight: 600; white-space: nowrap;">选择模型 (Model):</label>
            <button type="button" class="btn btn-outline" id="ed2-ai-model-btn" style="flex: 1; display: flex; justify-content: space-between; align-items: center; padding: 6px 12px; font-size: 12px;">
              <span id="ed2-ai-model-label" style="font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(selectedModel || '-- 点击选择 AI 模型 --')}</span>
              <span style="opacity: 0.6; font-size: 10px;">▼</span>
            </button>
          </div>

          <!-- Selection Context Display -->
          ${hasSelection ? `
            <div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <label style="font-size: 12px; font-weight: 600;">选中文本 (${selectedText.length} 字符)</label>
              </div>
              <div style="max-height: 80px; overflow-y: auto; padding: 8px; background: var(--bg-hover, rgba(0,0,0,0.25)); border: 1px solid var(--border-color, rgba(255,255,255,0.08)); border-radius: 6px; font-size: 12px; color: var(--text-muted, #aaa); white-space: pre-wrap; word-break: break-all;">${escapeHtml(selectedText.slice(0, 300))}${selectedText.length > 300 ? '...' : ''}</div>
            </div>
          ` : ''}

          <!-- Template Row -->
          <div style="display: flex; align-items: center; gap: 12px;">
            <label style="font-size: 12px; font-weight: 600; white-space: nowrap;">任务模板:</label>
            <select class="input" id="ed2-ai-tpl-select" style="flex: 1; font-size: 12px; padding: 4px 8px;">
              ${PROMPT_TEMPLATES.map((tpl, idx) => `<option value="${idx}">${escapeHtml(tpl.label)}</option>`).join('')}
            </select>
          </div>

          <!-- Prompt Instruction Textarea -->
          <div>
            <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">提示词与要求 (Prompt)</label>
            <textarea class="input" id="ed2-ai-prompt-input" rows="3" style="width: 100%; box-sizing: border-box; resize: vertical; font-size: 12px; line-height: 1.4;"></textarea>
          </div>

          <!-- Output Preview Area -->
          <div style="flex: 1; display: flex; flex-direction: column;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
              <label style="font-size: 12px; font-weight: 600;">生成结果 (Live Response)</label>
              <span id="ed2-ai-status-tag" style="font-size: 11px; color: var(--text-muted, #888);">就绪</span>
            </div>
            <div id="ed2-ai-output-box" style="min-height: 120px; max-height: 220px; overflow-y: auto; padding: 10px; background: var(--bg-input, rgba(0,0,0,0.3)); border: 1px solid var(--border-color, rgba(255,255,255,0.1)); border-radius: 6px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; font-family: var(--font-mono, monospace);"></div>
          </div>
        </div>

        <div class="modal-actions" style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-color, rgba(255,255,255,0.1)); padding-top: 12px;">
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-primary" id="ed2-ai-btn-generate">
              <i class="codicon codicon-play" style="margin-right: 4px;"></i>
              <span>开始生成</span>
            </button>
            <button class="btn btn-secondary" id="ed2-ai-btn-stop" style="display: none;">
              <i class="codicon codicon-debug-stop" style="margin-right: 4px;"></i>
              <span>停止</span>
            </button>
          </div>

          <div style="display: flex; gap: 6px;">
            ${hasSelection ? `<button class="btn btn-secondary" id="ed2-ai-btn-replace" disabled>替换选区</button>` : ''}
            <button class="btn btn-secondary" id="ed2-ai-btn-insert" disabled>插入光标</button>
            <button class="btn btn-secondary" id="ed2-ai-btn-new-tab" disabled>新建标签</button>
            <button class="btn btn-ghost" id="ed2-ai-btn-cancel">关闭</button>
          </div>
        </div>
      </div>
    `;

    function cleanup() {
      if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
      }
      overlay.remove();
    }

    const modelBtn = overlay.querySelector('#ed2-ai-model-btn');
    const modelLabel = overlay.querySelector('#ed2-ai-model-label');
    const tplSelect = overlay.querySelector('#ed2-ai-tpl-select');
    const promptInput = overlay.querySelector('#ed2-ai-prompt-input');
    const outputBox = overlay.querySelector('#ed2-ai-output-box');
    const statusTag = overlay.querySelector('#ed2-ai-status-tag');
    const btnGenerate = overlay.querySelector('#ed2-ai-btn-generate');
    const btnStop = overlay.querySelector('#ed2-ai-btn-stop');
    const btnReplace = overlay.querySelector('#ed2-ai-btn-replace');
    const btnInsert = overlay.querySelector('#ed2-ai-btn-insert');
    const btnNewTab = overlay.querySelector('#ed2-ai-btn-new-tab');

    overlay.querySelector('#ed2-ai-modal-close').onclick = cleanup;
    overlay.querySelector('#ed2-ai-btn-cancel').onclick = cleanup;

    // Model Picker integration
    modelBtn.onclick = () => {
      if (typeof window.openModelPickerModal === 'function') {
        window.openModelPickerModal(selectedModel, (newModel) => {
          if (newModel) {
            selectedModel = newModel;
            modelLabel.textContent = selectedModel;
            localStorage.setItem('tinylab_editor_ai_model', selectedModel);
          }
        });
      }
    };

    // Update prompt on template change
    function updatePromptFromTemplate() {
      const tpl = PROMPT_TEMPLATES[currentTplIndex];
      if (tpl) {
        promptInput.value = tpl.userPromptTpl(selectedText);
      }
    }
    tplSelect.onchange = (e) => {
      currentTplIndex = parseInt(e.target.value, 10) || 0;
      updatePromptFromTemplate();
    };
    updatePromptFromTemplate();

    // Streaming Generation
    async function startGeneration() {
      if (!selectedModel) {
        if (window.toast) window.toast('请先选择 AI 模型', 'warning');
        return;
      }
      const userPrompt = promptInput.value.trim();
      if (!userPrompt) {
        if (window.toast) window.toast('请输入提示词要求', 'warning');
        return;
      }

      const tpl = PROMPT_TEMPLATES[currentTplIndex];
      const messages = [
        { role: 'system', content: tpl.systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      accumulatedReply = '';
      outputBox.textContent = '';
      statusTag.textContent = '生成中...';
      statusTag.style.color = 'var(--accent-color, #6366f1)';
      btnGenerate.style.display = 'none';
      btnStop.style.display = 'inline-flex';
      if (btnReplace) btnReplace.disabled = true;
      btnInsert.disabled = true;
      btnNewTab.disabled = true;

      activeAbortController = new AbortController();

      try {
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: selectedModel,
            messages: messages,
            stream: true,
          }),
          signal: activeAbortController.signal,
        });

        if (!res.ok) {
          let errText = res.statusText;
          try {
            const errJson = await res.json();
            if (errJson.error && errJson.error.message) errText = errJson.error.message;
          } catch (_) {}
          throw new Error(`HTTP ${res.status}: ${errText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.startsWith('data:')) continue;
            const dataStr = trimmed.slice(5).trim();
            if (dataStr === '[DONE]') continue;

            try {
              const data = JSON.parse(dataStr);
              const delta = data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
              if (delta) {
                accumulatedReply += delta;
                outputBox.textContent = accumulatedReply;
                outputBox.scrollTop = outputBox.scrollHeight;
              }
            } catch (_) {}
          }
        }

        statusTag.textContent = '完成';
        statusTag.style.color = 'var(--color-success, #10b981)';
      } catch (err) {
        if (err.name === 'AbortError') {
          statusTag.textContent = '已停止';
          statusTag.style.color = 'var(--text-muted, #888)';
        } else {
          statusTag.textContent = '生成失败';
          statusTag.style.color = 'var(--color-error, #ef4444)';
          outputBox.textContent = '错误: ' + err.message;
        }
      } finally {
        activeAbortController = null;
        btnGenerate.style.display = 'inline-flex';
        btnStop.style.display = 'none';
        const hasResult = accumulatedReply.trim().length > 0;
        if (btnReplace) btnReplace.disabled = !hasResult;
        btnInsert.disabled = !hasResult;
        btnNewTab.disabled = !hasResult;
      }
    }

    btnGenerate.onclick = startGeneration;
    btnStop.onclick = () => {
      if (activeAbortController) activeAbortController.abort();
    };

    if (btnReplace) {
      btnReplace.onclick = () => {
        if (!accumulatedReply) return;
        cleanup();
        currentCodeEditor.pushUndoStop();
        currentCodeEditor.executeEdits('ai-replace-selection', [{
          range: sel,
          text: accumulatedReply,
          forceMoveMarkers: true,
        }]);
        currentCodeEditor.pushUndoStop();
        currentCodeEditor.focus();
        if (window.toast) window.toast('已替换选中文本', 'success');
      };
    }

    btnInsert.onclick = () => {
      if (!accumulatedReply) return;
      cleanup();
      const pos = currentCodeEditor.getPosition() || { lineNumber: 1, column: 1 };
      const range = new window.Ed2Monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
      currentCodeEditor.pushUndoStop();
      currentCodeEditor.executeEdits('ai-insert-cursor', [{
        range: range,
        text: accumulatedReply,
        forceMoveMarkers: true,
      }]);
      currentCodeEditor.pushUndoStop();
      currentCodeEditor.focus();
      if (window.toast) window.toast('已插入生成结果', 'success');
    };

    btnNewTab.onclick = () => {
      if (!accumulatedReply) return;
      cleanup();
      if (window.EditorV2 && window.EditorV2.createUntitledTab) {
        window.EditorV2.createUntitledTab(accumulatedReply);
        if (window.toast) window.toast('已在新标签页中打开生成内容', 'success');
      }
    };

    document.body.appendChild(overlay);
  }

  // --- Monaco Paste & Drag Listener Setup ---

  function setupHostInteractions(refs, editor) {
    if (!refs.monacoHost) return;

    // Intercept image paste in Monaco host
    refs.monacoHost.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.startsWith('image/')) {
          const file = items[i].getAsFile();
          if (file) {
            e.preventDefault();
            e.stopImmediatePropagation();
            processImageFile(file, 'pasted_image');
            break;
          }
        }
      }
    }, true);

    // Intercept drag and drop files
    refs.monacoHost.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    });

    refs.monacoHost.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          if (files[i].type && files[i].type.startsWith('image/')) {
            e.preventDefault();
            e.stopPropagation();
            processImageFile(files[i]);
            break;
          }
        }
      }
    });
  }

  function init(refs, editor) {
    layoutRefs = refs;
    currentCodeEditor = editor;
    setupHostInteractions(refs, editor);
  }

  window.EditorV2Extras = {
    init,
    processImageFile,
    prepareSaveAsAssets,
    showImageModal,
    showAiModal,
  };
})();
