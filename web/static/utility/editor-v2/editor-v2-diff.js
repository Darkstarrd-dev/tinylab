/**
 * Editor V2 - Diff UI Container & Step4-style line-by-line adoption
 */
(() => {
  'use strict';

  let activeDiffContainer = null;
  let currentDiffTab = null;
  const ROW_HEIGHT = 22; // estimated row height for virtual scroll & change navigation

  function escapeHtml(str) {
    return (str || '').replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  /**
   * Computes diff using Web Worker for large files (>1000 lines), or main thread fallback.
   */
  async function computeDiff(oldText, newText) {
    if (!window.EditorV2DiffCore) {
      throw new Error('EditorV2DiffCore module is not loaded');
    }

    const maxLines = Math.max(oldText.split('\n').length, newText.split('\n').length);
    if (maxLines > 1000 && typeof Worker !== 'undefined') {
      return await new Promise((resolve, reject) => {
        let worker;
        try {
          worker = new Worker('/utility/editor-v2/editor-v2-diff-worker.js');
        } catch (err) {
          reject(new Error('Failed to create Diff Worker: ' + err.message));
          return;
        }

        const jobId = 'diff_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
        let done = false;

        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          worker.terminate();
          reject(new Error('Diff Worker timed out after 20s'));
        }, 20000);

        worker.onmessage = (e) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          worker.terminate();
          if (e.data && e.data.jobId === jobId) {
            if (e.data.session && e.data.session.rows) {
              resolve(e.data.session.rows);
            } else if (e.data.error) {
              reject(new Error(e.data.error));
            } else {
              reject(new Error('Diff Worker returned empty payload'));
            }
          } else {
            reject(new Error('Diff Worker job mismatch'));
          }
        };

        worker.onerror = (err) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          worker.terminate();
          reject(new Error('Diff Worker error: ' + (err.message || 'Worker execution failed')));
        };

        worker.postMessage({ jobId, type: 'compare', left: oldText, right: newText });
      });
    }

    return window.EditorV2DiffCore.compare(oldText, newText, window.Diff);
  }

  /**
   * Opens a new Diff Tab and switches to it.
   */
  async function openDiffTab(title, oldText, newText, sourceTabId = null) {
    const tabId = 'diff_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const diffTab = {
      id: tabId,
      kind: 'diff',
      name: title || 'Diff: Document Compare',
      target: null,
      sourceTabId: sourceTabId,
      oldText: oldText,
      newText: newText,
      rows: null, // Computed lazily
      decisions: new Map(), // rowId -> 'accept' | 'reject'
      dirty: false,
      untitled: false,
      assets: new Map(),
      savePending: false,
      eol: (oldText.includes('\r\n') || newText.includes('\r\n')) ? 'CRLF' : 'LF',
    };

    const tabs = window.EditorV2.getTabs();
    tabs.push(diffTab);
    window.EditorV2.switchTab(diffTab.id);
  }

  /**
   * Renders diff view inside the container when a diff tab is activated.
   */
  async function renderDiffTab(tab, container) {
    currentDiffTab = tab;

    if (!activeDiffContainer) {
      activeDiffContainer = document.createElement('div');
      activeDiffContainer.className = 'ed2-diff-view';
      container.appendChild(activeDiffContainer);
    }
    activeDiffContainer.style.display = 'flex';
    activeDiffContainer.innerHTML = `
      <div class="ed2-diff-toolbar">
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="font-weight: 600; display: flex; align-items: center; gap: 6px;">
            <i class="codicon codicon-diff"></i>
            <span>${escapeHtml(tab.name)}</span>
          </span>
          <span id="ed2-diff-stats" style="color: var(--text-muted); font-size: 11px;">计算差异中...</span>
        </div>
        <div style="display: flex; align-items: center; gap: 6px;">
          <button class="btn btn-secondary btn-sm" id="ed2-diff-btn-prev" title="上一处差异 (Previous Change)">
            <i class="codicon codicon-arrow-up"></i>
          </button>
          <button class="btn btn-secondary btn-sm" id="ed2-diff-btn-next" title="下一处差异 (Next Change)">
            <i class="codicon codicon-arrow-down"></i>
          </button>
          <button class="btn btn-secondary btn-sm" id="ed2-diff-btn-reset" title="重置决策为默认采纳">
            <i class="codicon codicon-clear-all"></i> 重置
          </button>
          <button class="btn btn-secondary btn-sm" id="ed2-diff-btn-refresh" title="重新计算与刷新快照">
            <i class="codicon codicon-refresh"></i> 刷新
          </button>
          <button class="btn btn-secondary btn-sm" id="ed2-diff-btn-accept-all" disabled>
            <i class="codicon codicon-check"></i> 全部采纳 (B)
          </button>
          <button class="btn btn-secondary btn-sm" id="ed2-diff-btn-reject-all" disabled>
            <i class="codicon codicon-discard"></i> 全部保留 (A)
          </button>
          <button class="btn btn-primary btn-sm" id="ed2-diff-btn-open-result" disabled>
            <i class="codicon codicon-export"></i> 打开采纳结果为新标签
          </button>
        </div>
      </div>
      <div class="ed2-diff-grid-container" id="ed2-diff-scroll">
        <div class="ed2-diff-table" id="ed2-diff-table">
          <div style="grid-column: 1 / -1; padding: 32px; text-align: center; color: var(--text-muted);">
            正在对比文档行级内容，请稍候...
          </div>
        </div>
      </div>
    `;

    // Compute diff rows if not yet cached
    if (!tab.rows) {
      try {
        tab.rows = await computeDiff(tab.oldText, tab.newText);
        for (const r of tab.rows) {
          if (r.type !== 'context') {
            tab.decisions.set(r.id, 'accept');
          }
        }
      } catch (err) {
        if (currentDiffTab !== tab) return;
        const stats = activeDiffContainer.querySelector('#ed2-diff-stats');
        if (stats) stats.textContent = '计算失败';
        const table = activeDiffContainer.querySelector('#ed2-diff-table');
        if (table) {
          table.innerHTML = `
            <div style="grid-column: 1 / -1; padding: 40px; text-align: center; color: var(--danger, #e55353);">
              <div style="margin-bottom: 12px; font-weight: 600;">Diff 计算出错: ${escapeHtml(err.message)}</div>
              <button class="btn btn-secondary btn-sm" id="ed2-diff-retry-btn">
                <i class="codicon codicon-refresh"></i> 重试 (Retry)
              </button>
            </div>
          `;
          table.querySelector('#ed2-diff-retry-btn')?.addEventListener('click', () => {
            tab.rows = null;
            renderDiffTab(tab, container);
          });
        }
        return;
      }
    }

    if (currentDiffTab !== tab) return; // Tab switched during compute

    updateDiffStats(tab);
    bindDiffToolbar(tab);
    renderRowsVirtual(tab);
  }

  function hideDiffTab() {
    if (activeDiffContainer) {
      activeDiffContainer.style.display = 'none';
    }
    currentDiffTab = null;
  }

  function updateDiffStats(tab) {
    const statsEl = activeDiffContainer?.querySelector('#ed2-diff-stats');
    if (!statsEl || !tab.rows) return;

    let adds = 0;
    let dels = 0;
    let mods = 0;
    for (const r of tab.rows) {
      if (r.type === 'add') adds++;
      else if (r.type === 'del') dels++;
      else if (r.type === 'mod') mods++;
    }

    statsEl.innerHTML = `
      共 ${tab.rows.length} 行 (<span style="color: #22c55e;">+${adds}</span>, <span style="color: #ef4444;">-${dels}</span>, <span style="color: #eab308;">~${mods}</span>)
    `;
  }

  function bindDiffToolbar(tab) {
    const btnPrev = activeDiffContainer.querySelector('#ed2-diff-btn-prev');
    const btnNext = activeDiffContainer.querySelector('#ed2-diff-btn-next');
    const btnReset = activeDiffContainer.querySelector('#ed2-diff-btn-reset');
    const btnRefresh = activeDiffContainer.querySelector('#ed2-diff-btn-refresh');
    const btnAcceptAll = activeDiffContainer.querySelector('#ed2-diff-btn-accept-all');
    const btnRejectAll = activeDiffContainer.querySelector('#ed2-diff-btn-reject-all');
    const btnOpenResult = activeDiffContainer.querySelector('#ed2-diff-btn-open-result');

    btnAcceptAll.disabled = false;
    btnRejectAll.disabled = false;
    btnOpenResult.disabled = false;

    // Navigation between changes
    function findDiffIndices() {
      if (!tab.rows) return [];
      const indices = [];
      tab.rows.forEach((r, idx) => {
        if (r.type !== 'context') indices.push(idx);
      });
      return indices;
    }

    let currentNavChangeIdx = -1;
    function scrollToChange(targetIdx) {
      const scrollEl = activeDiffContainer.querySelector('#ed2-diff-scroll');
      if (!scrollEl) return;
      const targetScrollTop = targetIdx * ROW_HEIGHT;
      scrollEl.scrollTo({ top: targetScrollTop, behavior: 'smooth' });
    }

    if (btnPrev) {
      btnPrev.onclick = () => {
        const indices = findDiffIndices();
        if (indices.length === 0) return;
        currentNavChangeIdx = (currentNavChangeIdx <= 0) ? indices.length - 1 : currentNavChangeIdx - 1;
        scrollToChange(indices[currentNavChangeIdx]);
      };
    }

    if (btnNext) {
      btnNext.onclick = () => {
        const indices = findDiffIndices();
        if (indices.length === 0) return;
        currentNavChangeIdx = (currentNavChangeIdx >= indices.length - 1) ? 0 : currentNavChangeIdx + 1;
        scrollToChange(indices[currentNavChangeIdx]);
      };
    }

    if (btnReset) {
      btnReset.onclick = () => {
        if (!tab.rows) return;
        for (const r of tab.rows) {
          if (r.type !== 'context') tab.decisions.set(r.id, 'accept');
        }
        renderRowsVirtual(tab);
        updateDiffStats(tab);
        if (window.toast) window.toast('已重置全部决策', 'info');
      };
    }

    if (btnRefresh) {
      btnRefresh.onclick = async () => {
        if (tab.sourceTabId) {
          const srcTab = window.EditorV2.getTabById(tab.sourceTabId);
          if (srcTab && srcTab.model) {
            tab.oldText = srcTab.savedText || '';
            tab.newText = srcTab.model.getValue();
          }
        }
        tab.rows = null;
        tab.decisions.clear();
        await renderDiffTab(tab, activeDiffContainer.parentElement);
        if (window.toast) window.toast('已刷新 Diff 快照', 'info');
      };
    }

    btnAcceptAll.onclick = () => {
      for (const r of tab.rows) {
        if (r.type !== 'context') tab.decisions.set(r.id, 'accept');
      }
      renderRowsVirtual(tab);
      if (window.toast) window.toast('已全部设为采纳修改 (B)', 'info');
    };

    btnRejectAll.onclick = () => {
      for (const r of tab.rows) {
        if (r.type !== 'context') tab.decisions.set(r.id, 'reject');
      }
      renderRowsVirtual(tab);
      if (window.toast) window.toast('已全部设为保留原版 (A)', 'info');
    };

    btnOpenResult.onclick = () => {
      const assembledText = window.EditorV2DiffCore.assemble(tab.rows, tab.decisions);
      const newTab = window.EditorV2.createUntitledTab(assembledText);
      newTab.name = `Result of ${tab.name.replace(/^Diff:\s*/, '')}`;
      window.EditorV2.renderTabs();
      if (window.toast) window.toast('已在新标签页中打开比较采纳结果', 'success');
    };
  }

  /**
   * Renders rows with virtual slicing when row count > 200 to keep high performance.
   */
  function renderRowsVirtual(tab) {
    const scrollContainer = activeDiffContainer?.querySelector('#ed2-diff-scroll');
    const tableEl = activeDiffContainer?.querySelector('#ed2-diff-table');
    if (!scrollContainer || !tableEl || !tab.rows) return;

    const rows = tab.rows;
    const totalRows = rows.length;

    function renderSlice(startIdx, endIdx) {
      const slice = rows.slice(startIdx, endIdx);
      let html = '';

      // Top Spacer if start > 0
      if (startIdx > 0) {
        const topHeight = startIdx * ROW_HEIGHT;
        html += `<div style="grid-column: 1 / -1; height: ${topHeight}px;"></div>`;
      }

      for (let i = 0; i < slice.length; i++) {
        const r = slice[i];
        const rowId = r.id;
        const dec = tab.decisions.get(rowId) || 'accept';

        // Row css class
        let rowClass = 'ed2-diff-row ' + r.type;
        if (r.type !== 'context') {
          rowClass += (dec === 'accept' ? ' accepted' : ' rejected');
        }

        // Left Content
        const leftNum = r.left ? r.left.num : '';
        let leftCell = '';
        if (r.leftParts && r.leftParts.length > 0) {
          leftCell = r.leftParts.map(p => p.removed ? `<span class="ed2-diff-word-del">${escapeHtml(p.text)}</span>` : escapeHtml(p.text)).join('');
        } else if (r.left) {
          leftCell = escapeHtml(r.left.text);
        }

        // Right Content
        const rightNum = r.right ? r.right.num : '';
        let rightCell = '';
        if (r.rightParts && r.rightParts.length > 0) {
          rightCell = r.rightParts.map(p => p.added ? `<span class="ed2-diff-word-add">${escapeHtml(p.text)}</span>` : escapeHtml(p.text)).join('');
        } else if (r.right) {
          rightCell = escapeHtml(r.right.text);
        }

        // Control Cell
        let ctrlCell = '';
        if (r.type === 'context') {
          ctrlCell = '<span style="opacity: 0.3; font-size: 11px;">—</span>';
        } else {
          const isAccept = dec === 'accept';
          ctrlCell = `
            <button class="ed2-diff-ctrl-btn ${isAccept ? 'active-accept' : ''}" data-act="accept" data-row="${rowId}" title="采纳右侧 (B)">B</button>
            <button class="ed2-diff-ctrl-btn ${!isAccept ? 'active-reject' : ''}" data-act="reject" data-row="${rowId}" title="保留左侧 (A)">A</button>
          `;
        }

        html += `
          <div class="${rowClass}">
            <div class="ed2-diff-num">${leftNum}</div>
            <div class="ed2-diff-cell left">${leftCell}</div>
            <div class="ed2-diff-num">${rightNum}</div>
            <div class="ed2-diff-cell right">${rightCell}</div>
            <div class="ed2-diff-ctrl">${ctrlCell}</div>
          </div>
        `;
      }

      // Bottom Spacer if end < totalRows
      if (endIdx < totalRows) {
        const bottomHeight = (totalRows - endIdx) * ROW_HEIGHT;
        html += `<div style="grid-column: 1 / -1; height: ${bottomHeight}px;"></div>`;
      }

      tableEl.innerHTML = html;

      // Event delegation for accept/reject buttons
      tableEl.querySelectorAll('.ed2-diff-ctrl-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const targetRowId = parseInt(btn.dataset.row, 10);
          const act = btn.dataset.act;
          tab.decisions.set(targetRowId, act);
          renderRowsVirtual(tab);
        };
      });
    }

    if (totalRows <= 200) {
      renderSlice(0, totalRows);
    } else {
      // Virtual windowing on scroll
      function onScroll() {
        if (currentDiffTab !== tab) return;
        const scrollTop = scrollContainer.scrollTop;
        const viewportHeight = scrollContainer.clientHeight || 600;
        const startIdx = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 30);
        const endIdx = Math.min(totalRows, startIdx + Math.ceil(viewportHeight / ROW_HEIGHT) + 60);
        renderSlice(startIdx, endIdx);
      }

      scrollContainer.onscroll = onScroll;
      onScroll();
    }
  }

  // --- Diff Setup Modal ---

  function openDiffModal() {
    const tabs = window.EditorV2.getTabs().filter(t => t.kind === 'document');
    const activeTab = window.EditorV2.getActiveTab();
    const hasBaseline = activeTab && !activeTab.untitled && typeof activeTab.savedText === 'string';

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.zIndex = '99999';

    overlay.innerHTML = `
      <div class="modal modal-card" role="dialog" style="max-width: 620px; width: 92%;">
        <div class="modal-header" style="display: flex; justify-content: space-between; align-items: center;">
          <h3 style="margin: 0; display: flex; align-items: center; gap: 8px;">
            <i class="codicon codicon-diff"></i>
            <span>文档差异比较 (Diff Comparison)</span>
          </h3>
          <button class="ed2-icon-btn" id="ed2-diff-modal-close" style="font-size: 16px;">×</button>
        </div>

        <div class="modal-body" style="padding: 16px 0; display: flex; flex-direction: column; gap: 14px;">
          <!-- Mode Tabs -->
          <div style="display: flex; gap: 8px; border-bottom: 1px solid var(--border-color, #333); padding-bottom: 8px;">
            <button class="btn ${hasBaseline ? 'btn-primary' : 'btn-secondary'} btn-sm" id="ed2-diff-mode-saved" ${hasBaseline ? '' : 'disabled'} title="${hasBaseline ? '对比磁盘已保存快照与当前未保存修改' : '当前文档无磁盘基线（未保存或新建文档）'}">
              已保存 vs 当前草稿 (Saved vs Current)
            </button>
            <button class="btn ${hasBaseline ? 'btn-secondary' : 'btn-primary'} btn-sm" id="ed2-diff-mode-custom">
              双文档对比 (Two Tabs / Custom)
            </button>
          </div>

          <!-- Mode 1: Saved vs Current Panel -->
          <div id="ed2-diff-panel-saved" style="${hasBaseline ? 'display: block;' : 'display: none;'}">
            <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 8px;">
              将当前文档 <b>${escapeHtml(activeTab?.name || '')}</b> 的磁盘已保存版本 (A) 与当前编辑器的最新修改 (B) 进行比对。
            </div>
            <div style="font-size: 11px; padding: 8px; background: var(--bg-hover, rgba(255,255,255,0.05)); border-radius: 4px;">
              左侧 (A): 上次保存的基线内容 (${(activeTab?.savedText || '').length} 字符)<br>
              右侧 (B): 当前编辑器内容 (${activeTab?.model ? activeTab.model.getValue().length : 0} 字符)
            </div>
          </div>

          <!-- Mode 2: Two Tabs / Custom Panel -->
          <div id="ed2-diff-panel-custom" style="${hasBaseline ? 'display: none;' : 'display: block;'} display: flex; flex-direction: column; gap: 12px;">
            <div style="display: flex; justify-content: flex-end;">
              <button class="btn btn-secondary btn-sm" id="ed2-diff-btn-swap" style="font-size: 11px;">
                <i class="codicon codicon-arrow-swap"></i> 交换两侧 (Swap A ↔ B)
              </button>
            </div>
            <!-- Left Side (A / Original) -->
            <div>
              <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">原文档 (Original / A)</label>
              <select class="input" id="ed2-diff-select-left" style="width: 100%; font-size: 12px;">
                ${tabs.map(t => `<option value="${t.id}" ${t.id === activeTab?.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
                <option value="__custom__">-- 手动输入或粘贴文本 --</option>
              </select>
              <textarea class="input" id="ed2-diff-custom-left" rows="4" placeholder="在此粘贴原文档内容..." style="width: 100%; box-sizing: border-box; margin-top: 6px; display: none; font-size: 12px; font-family: monospace;"></textarea>
            </div>

            <!-- Right Side (B / Revised) -->
            <div>
              <label style="font-size: 12px; font-weight: 600; display: block; margin-bottom: 4px;">修改后文档 (Revised / B)</label>
              <select class="input" id="ed2-diff-select-right" style="width: 100%; font-size: 12px;">
                ${tabs.map((t, idx) => `<option value="${t.id}" ${idx === 1 ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
                <option value="__custom__" ${tabs.length <= 1 ? 'selected' : ''}>-- 手动输入或粘贴文本 --</option>
              </select>
              <textarea class="input" id="ed2-diff-custom-right" rows="4" placeholder="在此粘贴修改后的文档内容..." style="width: 100%; box-sizing: border-box; margin-top: 6px; ${tabs.length <= 1 ? 'display: block;' : 'display: none;'} font-size: 12px; font-family: monospace;"></textarea>
            </div>
          </div>
        </div>

        <div class="modal-actions" style="display: flex; justify-content: flex-end; gap: 8px;">
          <button class="btn btn-ghost" id="ed2-diff-btn-cancel">取消</button>
          <button class="btn btn-primary" id="ed2-diff-btn-start">开始比较</button>
        </div>
      </div>
    `;

    function cleanup() {
      overlay.remove();
    }

    let currentMode = hasBaseline ? 'saved' : 'custom';
    const btnModeSaved = overlay.querySelector('#ed2-diff-mode-saved');
    const btnModeCustom = overlay.querySelector('#ed2-diff-mode-custom');
    const panelSaved = overlay.querySelector('#ed2-diff-panel-saved');
    const panelCustom = overlay.querySelector('#ed2-diff-panel-custom');

    btnModeSaved.onclick = () => {
      if (!hasBaseline) return;
      currentMode = 'saved';
      btnModeSaved.className = 'btn btn-primary btn-sm';
      btnModeCustom.className = 'btn btn-secondary btn-sm';
      panelSaved.style.display = 'block';
      panelCustom.style.display = 'none';
    };

    btnModeCustom.onclick = () => {
      currentMode = 'custom';
      btnModeCustom.className = 'btn btn-primary btn-sm';
      btnModeSaved.className = 'btn btn-secondary btn-sm';
      panelCustom.style.display = 'flex';
      panelSaved.style.display = 'none';
    };

    const selLeft = overlay.querySelector('#ed2-diff-select-left');
    const customLeft = overlay.querySelector('#ed2-diff-custom-left');
    const selRight = overlay.querySelector('#ed2-diff-select-right');
    const customRight = overlay.querySelector('#ed2-diff-custom-right');
    const btnSwap = overlay.querySelector('#ed2-diff-btn-swap');

    selLeft.onchange = () => {
      customLeft.style.display = selLeft.value === '__custom__' ? 'block' : 'none';
    };
    selRight.onchange = () => {
      customRight.style.display = selRight.value === '__custom__' ? 'block' : 'none';
    };

    if (btnSwap) {
      btnSwap.onclick = () => {
        const tempSel = selLeft.value;
        selLeft.value = selRight.value;
        selRight.value = tempSel;

        const tempCustom = customLeft.value;
        customLeft.value = customRight.value;
        customRight.value = tempCustom;

        selLeft.onchange();
        selRight.onchange();
      };
    }

    overlay.querySelector('#ed2-diff-modal-close').onclick = cleanup;
    overlay.querySelector('#ed2-diff-btn-cancel').onclick = cleanup;

    overlay.querySelector('#ed2-diff-btn-start').onclick = async () => {
      let leftText = '';
      let leftName = 'DocA';
      let rightText = '';
      let rightName = 'DocB';
      let sourceTabId = null;

      if (currentMode === 'saved') {
        if (!activeTab || !activeTab.model) return;
        leftText = activeTab.savedText || '';
        leftName = `${activeTab.name} (Disk)`;
        rightText = activeTab.model.getValue();
        rightName = `${activeTab.name} (Current)`;
        sourceTabId = activeTab.id;
      } else {
        if (selLeft.value === '__custom__') {
          leftText = customLeft.value;
          leftName = 'Custom Left';
        } else {
          const t = window.EditorV2.getTabById(selLeft.value);
          if (t && t.model) {
            leftText = t.model.getValue();
            leftName = t.name;
          }
        }

        if (selRight.value === '__custom__') {
          rightText = customRight.value;
          rightName = 'Custom Right';
        } else {
          const t = window.EditorV2.getTabById(selRight.value);
          if (t && t.model) {
            rightText = t.model.getValue();
            rightName = t.name;
          }
        }
      }

      cleanup();
      await openDiffTab(`Diff: ${leftName} ↔ ${rightName}`, leftText, rightText, sourceTabId);
    };

    document.body.appendChild(overlay);
  }

  window.EditorV2Diff = {
    computeDiff,
    openDiffTab,
    renderDiffTab,
    hideDiffTab,
    openDiffModal,
  };
})();
