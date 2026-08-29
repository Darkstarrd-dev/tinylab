// web/static/gif-editor.js
// GIF / frame editor page for TinyRouter (header nav 6th button, data-page="gif").
// Pure local SPA, classic script execution under web/static/.
//
// Module split (docs/gif_upgrade.md §4): state/lifecycle, import (Import Modal),
// timeline (virtualized window + zoom), playback (First/Prev/Play/Next/Last),
// export (GIF/ZIP/sprite + MediaBridge) live in gif-editor-{state,import,
// timeline,playback,export}.js. This entry owns the page template, canvas
// stage (pan/zoom/crop gizmo/layer gizmo), chroma-key transparency, edge
// crop + grid slice, layer creation/editing and the shared compositor.

// Split: gif-editor-page.js
(function () {
  'use strict';

  var shared = window._gifEditorShared || (window._gifEditorShared = {});
  shared.dom = shared.dom || {};
  shared.canvas = shared.canvas || null;
  shared.ctx = shared.ctx || null;
  shared.rendered = shared.rendered || false;
  shared.renderContainer = shared.renderContainer || null;
  shared.suspended = shared.suspended || false;
  shared.layerBase = shared.layerBase || null;
  shared.fns = shared.fns || {};
  if (!shared.core) shared.core = window.GifEditorCore;
  var core = shared.core;

  function render(container) {
    teardown();
    if (!container) container = document.getElementById('page-content');
    if (!container) return null;
    shared.renderContainer = container;
    shared.suspended = false;
    container.style.height = '100%';
    container.style.overflow = 'hidden';
    container.innerHTML = pageTemplate();
    shared.fns.applyTemplateI18n(container);

    shared.fns.cacheDom();
    shared.canvas = shared.dom.canvas;
    shared.ctx = shared.dom.ctx;

    shared.fns.registerCoreCommands();
    shared.fns.bindEvents();
    shared.rendered = true;

    // Restore workspace state from memory if returning from another tab
    if ((core.state.slices || []).length > 0) {
      if (core.commands.updateSourcePanels) core.commands.updateSourcePanels(core.state.source.kind);
      if (core.timeline && core.timeline.render) core.timeline.render();
      if (core.playback && core.playback.updateButtons) core.playback.updateButtons();
      var selectedIdx = core.state.selectedSliceIdx >= 0 ? core.state.selectedSliceIdx : 0;
      shared.fns.updateSelectionUI(selectedIdx);
    } else {
      shared.fns.updateSelectionUI(-1);
    }

    shared.fns.draw();
    shared.fns.resetView();
    return container;
  }
  shared.fns.render = render;

  function suspend() {
    if (!shared.rendered && !core.state.playback.playing) {
      shared.suspended = true;
      return;
    }
    teardown();
    shared.suspended = true;
  }

  shared.fns.suspend = suspend;

  function resume() {
    if (!shared.suspended && shared.rendered) return shared.renderContainer;
    var pageContent = document.getElementById('page-content');
    var target = pageContent || shared.renderContainer;
    if (!target) return null;
    return render(target);
  }
  shared.fns.resume = resume;

  function cleanup() {
    teardown();
    // cleanupGifEditor remains the full teardown path for legacy callers.
    // Utility navigation must call suspend() instead to retain this project.
    if (core) {
      core.resetSlices();
      core.releaseSource();
    }
    shared.renderContainer = null;
    shared.suspended = false;
  }
  shared.fns.cleanup = cleanup;

  function teardown() {
    if (shared.rendered) {
      document.removeEventListener('keydown', shared.fns.onKeyDown, true);
      document.removeEventListener('dragover', shared.fns.onDragOver);
      document.removeEventListener('dragleave', shared.fns.onDragLeave);
      document.removeEventListener('drop', shared.fns.onDrop);
      document.removeEventListener('paste', shared.fns.onPaste);
      window.removeEventListener('mousemove', shared.fns.onPointerMove);
      window.removeEventListener('touchmove', shared.fns.onPointerMove);
      window.removeEventListener('mouseup', shared.fns.onPointerUp);
      window.removeEventListener('touchend', shared.fns.onPointerUp);
      window.removeEventListener('resize', shared.fns.onWindowResize);
      if (shared.dom.stage) {
        shared.dom.stage.removeEventListener('mousedown', shared.fns.handlePointerDown);
        shared.dom.stage.removeEventListener('touchstart', shared.fns.handlePointerDown);
        shared.dom.stage.removeEventListener('wheel', shared.fns.handleWheel);
      }
    }
    if (core) {
      core.cleanupModules();
    }
    shared.dom = {};
    shared.canvas = null;
    shared.ctx = null;
    shared.rendered = false;
  }
  shared.fns.teardown = teardown;

  function pageTemplate() {
    // Split Sheet grid mode persists in state across re-render/re-entry.
    var splitMode = core.state.splitMode === 'uneven' ? 'uneven' : 'even';
    return '' +
      '<div class="gif-workspace">' +
      '  <aside class="gif-sidebar">' +
      '    <div id="gif-panel-step1">' +
      '      <div id="gif-drop-zone-container">' +
      '        <div class="gif-drop-zone" id="gif-drop-zone">' +
      '          <div class="gif-drop-zone-icon">📁</div>' +
      '          <div class="gif-drop-zone-title" data-i18n="gifEditorDropTitle">点击选择或拖入文件</div>' +
      '          <div class="gif-drop-zone-desc" data-i18n="gifEditorDropDesc">支持 Image / GIF / Video，可直接粘贴</div>' +
      '          <input type="file" id="gif-file-input" style="display:none;" accept="image/*,video/*,.gif">' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '    <div id="gif-sidebar-editor-content" style="display:none;">' +
      '      <div class="gif-action-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; margin-bottom: 12px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="btn btn-primary" id="gif-open-export-btn" data-tooltip="' + shared.fns.t('gifEditorExportSettingsTitle', 'Export settings') + '" style="width:100%; display:flex; align-items:center; justify-content:center; padding:8px 12px; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorExportTitle">Export</span>' +
      '        </button>' +
      '        <button type="button" class="btn btn-ghost gif-reset-btn" id="gif-reload-btn" data-tooltip="' + shared.fns.t('gifEditorResetWorkspace', 'Reset workspace') + '" style="width:100%; display:flex; align-items:center; justify-content:center; padding:8px 12px; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorReload">Reset</span>' +
      '        </button>' +
      '      </div>' +

      '      <!-- 1. Crop -->' +
      '      <div id="gif-crop-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-global-crop-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorGlobalCrop">' + shared.fns.t('gifEditorGlobalCrop', 'Crop') + '</span>' +
      '        </button>' +
      '        <div class="gif-crop-panel gif-sidebar-panel" id="gif-crop-panel">' +
      '          <div class="gif-group-title" style="margin-bottom: 8px; font-weight: bold; font-size: 12px; color: var(--accent-color);" data-i18n="gifEditorCropAdjust">' + shared.fns.t('gifEditorCropAdjust', 'Crop area fine-tune') + '</div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-num-l" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropLeft">' + shared.fns.t('gifEditorCropLeft', 'Left:') + '</label>' +
      '            <div class="number-stepper" style="flex:1;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-l\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-crop-num-l" min="0" value="0">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-l\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-num-r" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropRight">' + shared.fns.t('gifEditorCropRight', 'Right:') + '</label>' +
      '            <div class="number-stepper" style="flex:1;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-r\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-crop-num-r" min="0" value="0">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-r\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-num-t" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropTop">' + shared.fns.t('gifEditorCropTop', 'Top:') + '</label>' +
      '            <div class="number-stepper" style="flex:1;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-t\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-crop-num-t" min="0" value="0">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-t\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; justify-content:space-between; width:100%; margin-bottom:8px;">' +
      '            <label for="gif-crop-num-b" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropBottom">' + shared.fns.t('gifEditorCropBottom', 'Bottom:') + '</label>' +
      '            <div class="number-stepper" style="flex:1;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-b\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-crop-num-b" min="0" value="0">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-crop-num-b\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-crop-action-btn" id="gif-apply-crop-btn" data-i18n="gifEditorApplyCrop">' + shared.fns.t('gifEditorApplyCrop', 'Apply') + '</button>' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-cancel-crop-btn" data-i18n="gifEditorCancelCrop">' + shared.fns.t('gifEditorCancelCrop', 'Cancel') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 2. Set Transparency -->' +
      '      <div id="gif-transparency-wrapper" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <input type="checkbox" id="gif-enable-trans" style="display:none;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-magic-wand-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorMagicWandTitle">' + shared.fns.t('gifEditorMagicWandTitle', 'Set Transparency') + '</span>' +
      '        </button>' +
      '        <div id="gif-trans-panel" class="gif-trans-panel gif-sidebar-panel">' +
      '          <div class="gif-split-mode-toggle" id="gif-trans-mode-toggle" style="margin-bottom:8px;">' +
      '            <button type="button" class="gif-split-mode-btn active" id="gif-trans-mode-color-btn" data-mode="color">' + shared.fns.t('gifEditorTransModeColor', 'Color Key') + '</button>' +
      '            <button type="button" class="gif-split-mode-btn" id="gif-trans-mode-flood-btn" data-mode="flood">' + shared.fns.t('gifEditorTransModeFlood', 'Flood Fill') + '</button>' +
      '          </div>' +
      '          <div id="gif-trans-color-controls">' +
      '            <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">' +
      '              <input type="color" id="gif-key-color" value="#ffffff" class="gif-key-color-input" style="width:36px; height:36px; padding:0; border:1px solid var(--glass-border); border-radius:4px; cursor:pointer;" data-tooltip="' + shared.fns.t('gifEditorPickColorTitle', 'Key color') + '">' +
      '              <button type="button" class="gif-btn gif-btn-primary gif-flex-1" id="gif-pick-color-btn" style="display:flex; align-items:center; justify-content:center; height:36px; font-weight:600;" data-tooltip="' + shared.fns.t('gifEditorPickColorTitle', 'Key color') + '">' +
      '                <span data-i18n="gifEditorPickColor">' + shared.fns.t('gifEditorPickColor', 'Pick Color') + '</span>' +
      '              </button>' +
      '            </div>' +
      '            <div class="gif-trans-hint" style="font-size:11px; color:var(--text-muted); margin-bottom:8px; line-height:1.3;" data-i18n="gifEditorPickColorHint">' + shared.fns.t('gifEditorPickColorHint', '* After clicking Pick Color, click background color on canvas') + '</div>' +
      '          </div>' +
      '          <div id="gif-trans-flood-controls" style="display:none;">' +
      '            <div class="gif-trans-hint" style="font-size:11px; color:var(--text-muted); margin-bottom:8px; line-height:1.3;" data-i18n="gifEditorFloodHint">' + shared.fns.t('gifEditorFloodHint', '* Click the image to add a seed: the connected same-color region becomes transparent') + '</div>' +
      '            <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">' +
      '              <span id="gif-seed-count" style="font-size:12px; color:var(--text-muted); flex-shrink:0;">' + shared.fns.t('gifEditorSeedCount', ['0'], '0 seeds') + '</span>' +
      '              <button type="button" class="gif-btn gif-btn-primary gif-flex-1" id="gif-flood-pick-btn" style="height:30px; font-size:12px; font-weight:600;" data-tooltip="' + shared.fns.t('gifEditorFloodPickTitle', 'Click the image to add a seed point') + '">' + shared.fns.t('gifEditorFloodPick', 'Pick Point') + '</button>' +
      '              <button type="button" class="gif-btn" id="gif-clear-seeds-btn" style="height:30px; font-size:12px;" data-tooltip="' + shared.fns.t('gifEditorClearSeeds', 'Clear all seeds') + '">' + shared.fns.t('gifEditorClearSeeds', 'Clear') + '</button>' +
      '            </div>' +
      '            <div class="gif-control-row" style="margin-bottom:8px;">' +
      '              <button type="button" class="gif-btn gif-full-width" id="gif-corner-flood-btn" style="height:30px; font-size:12px;" data-tooltip="' + shared.fns.t('gifEditorCornerFloodHint', 'Remove border-connected background from the four corners') + '">' + shared.fns.t('gifEditorCornerFlood', 'Remove Corner Background') + '</button>' +
      '          </div>' +
      '          <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">' +
      '            <span class="gif-muted-label" style="font-size:12px; color:var(--text-muted);" data-i18n="gifEditorFuzziness">' + shared.fns.t('gifEditorFuzziness', 'Tolerance:') + '</span>' +
      '            <input type="range" id="gif-fuzziness" min="0" max="100" value="15" class="gif-flex-1" data-tooltip="' + shared.fns.t('gifEditorFuzzinessTitle', 'Fuzziness') + '">' +
      '          </div>' +
      '          <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">' +
      '            <span class="gif-muted-label" style="font-size:12px; color:var(--text-muted);" data-i18n="gifEditorErode">' + shared.fns.t('gifEditorErode', 'Erode:') + '</span>' +
      '            <input type="range" id="gif-trans-erode" min="-10" max="10" step="1" value="0" class="gif-flex-1" data-tooltip="' + shared.fns.t('gifEditorErodeTitle', 'Expand (+) or shrink (-) the selection in pixels') + '">' +
      '          </div>' +
      '          <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">' +
      '            <span class="gif-muted-label" style="font-size:12px; color:var(--text-muted);" data-i18n="gifEditorErodeSmooth">' + shared.fns.t('gifEditorErodeSmooth', 'Erode Smooth:') + '</span>' +
      '            <input type="range" id="gif-trans-erode-smooth" min="0" max="20" step="1" value="0" class="gif-flex-1" data-tooltip="' + shared.fns.t('gifEditorErodeSmoothTitle', 'Feather the selection edge in pixels') + '">' +
      '          </div>' +
      '          <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">' +
      '            <label class="gif-check-label" style="display:flex; align-items:center; gap:4px; cursor:pointer; font-size:12px;"><input type="checkbox" id="gif-trans-c2a"> <span data-i18n="gifEditorSoftEdge">' + shared.fns.t('gifEditorSoftEdge', 'Soft edge (preserve anti-aliasing)') + '</span></label>' +
      '          </div>' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-crop-action-btn" id="gif-apply-trans-btn" data-i18n="gifEditorApplyTrans">' + shared.fns.t('gifEditorApplyTrans', 'Apply') + '</button>' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-cancel-trans-btn" data-i18n="gifEditorCancelTrans">' + shared.fns.t('gifEditorCancelTrans', 'Cancel') + '</button>' +
      '          </div>' +
      '          <div class="gif-control-row" style="margin-top: 8px;">' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-full-width" id="gif-disable-trans-btn" style="height:30px; font-size:12px;" data-i18n="gifEditorDisableTrans">' + shared.fns.t('gifEditorDisableTrans', 'Disable transparency') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 3. Split Sheet -->' +
      '      <div id="gif-split-sheet-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-split-sheet-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorSplitSheet">Split Sheet</span>' +
      '        </button>' +
      '        <div id="gif-split-sheet-panel" class="gif-split-sheet-panel gif-sidebar-panel">' +
      '          <div class="gif-import-row" style="display:flex; justify-content:space-between; font-size:12px; margin-bottom: 6px;">' +
      '            <span class="gif-import-label" style="color:var(--text-muted);">' + shared.fns.t('gifImportSourceResolution', 'Source Resolution:') + '</span>' +
      '            <span class="gif-import-value" id="gif-split-source-res" style="font-weight:bold; color:var(--accent-color);">2048 × 2048</span>' +
      '          </div>' +
      '          <div class="gif-import-col" style="margin-bottom: 8px;">' +
      '            <div class="gif-import-label-row" style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px;">' +
      '              <label for="gif-split-scale" class="gif-import-label" style="color:var(--text-muted);">' + shared.fns.t('gifEditorScale', 'Scale') + '</label>' +
      '              <span class="gif-import-value" id="gif-split-scale-display" style="font-weight:bold;">100%</span>' +
      '            </div>' +
      '            <input type="range" id="gif-split-scale" min="10" max="100" step="5" value="100" style="width:100%;">' +
      '          </div>' +
      '          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">' +
      '            <div class="gif-group-title" style="font-weight:bold; font-size:12px; color:var(--accent-color);">' + shared.fns.t('gifEditorGridSplitTitle', 'Sprite Sheet Grid Split') + '</div>' +
      '            <div class="gif-split-mode-toggle" id="gif-split-mode-toggle">' +
      '              <button type="button" class="gif-split-mode-btn' + (splitMode === 'even' ? ' active' : '') + '" data-mode="even">' + shared.fns.t('gifEditorEven', 'Even') + '</button>' +
      '              <button type="button" class="gif-split-mode-btn' + (splitMode === 'uneven' ? ' active' : '') + '" data-mode="uneven">' + shared.fns.t('gifEditorUneven', 'Uneven') + '</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-control-group" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 6px;">' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-split-cols" class="gif-import-label" id="gif-split-cols-label" style="font-size:11px; display:block; margin-bottom:2px;">' + shared.fns.t(splitMode === 'uneven' ? 'gifEditorCellWidth' : 'gifEditorSplitX', splitMode === 'uneven' ? 'Cell Width (px):' : 'X (Horizontal Split):') + '</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-split-cols\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-split-cols" min="1" max="' + (splitMode === 'uneven' ? '9999' : '100') + '" value="' + (splitMode === 'uneven' ? 64 : 3) + '">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-split-cols\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-split-rows" class="gif-import-label" id="gif-split-rows-label" style="font-size:11px; display:block; margin-bottom:2px;">' + shared.fns.t(splitMode === 'uneven' ? 'gifEditorCellHeight' : 'gifEditorSplitY', splitMode === 'uneven' ? 'Cell Height (px):' : 'Y (Vertical Split):') + '</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-split-rows\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-split-rows" min="1" max="' + (splitMode === 'uneven' ? '9999' : '100') + '" value="' + (splitMode === 'uneven' ? 64 : 3) + '">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-split-rows\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-control-group" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 6px;">' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-split-inner-gap" class="gif-import-label" style="font-size:11px; display:block; margin-bottom:2px;">' + shared.fns.t('gifEditorCenterGap', 'Center Gap (px):') + '</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-split-inner-gap\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-split-inner-gap" min="0" max="500" value="0">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-split-inner-gap\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-split-outer-margin" class="gif-import-label" style="font-size:11px; display:block; margin-bottom:2px;">' + shared.fns.t('gifEditorOuterMargin', 'Outer Margin (px):') + '</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-split-outer-margin\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-split-outer-margin" min="0" max="500" value="0">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-split-outer-margin\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-import-row" style="margin-bottom: 8px;">' +
      '            <label class="gif-check-label" style="font-size:12px;"><input type="checkbox" id="gif-split-enable-outer"> <span>' + shared.fns.t('gifEditorEnableOuterGap', 'Enable outer border gap') + '</span></label>' +
      '          </div>' +
      '          <div class="gif-import-summary-row" style="display:flex; justify-content:space-between; font-size:12px; margin-bottom: 8px; border-top: 1px dashed var(--glass-border); padding-top: 6px;">' +
      '            <div>' +
      '              <span class="gif-import-label">' + shared.fns.t('gifImportActualFrames', 'Actual Frames:') + ' </span>' +
      '              <span class="gif-import-summary-val" id="gif-split-actual-frames" style="font-weight:bold;">9</span>' +
      '            </div>' +
      '            <div>' +
      '              <span class="gif-import-label">' + shared.fns.t('gifImportDuration', 'Duration:') + ' </span>' +
      '              <span class="gif-import-summary-val" id="gif-split-duration">00:00:00.000</span>' +
      '            </div>' +
      '          </div>' +
      '          <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-split-apply-btn" style="margin-top: 4px;">' + shared.fns.t('gifEditorSplitBtn', 'Split') + '</button>' +
      '        </div>' +
      '      </div>' +
      '      <!-- Image tools: edge crop + grid slice (image source) -->' +
      '      <div id="gif-image-tools" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-image-tools-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorImageTools">' + shared.fns.t('gifEditorImageTools', 'Edge Crop & Grid Slice') + '</span>' +
      '        </button>' +
      '        <div id="gif-image-tools-panel" class="gif-image-tools-panel gif-sidebar-panel">' +
      '          <div class="gif-group-title" style="margin-bottom: 8px; font-weight: bold; font-size: 12px; color: var(--accent-color);" data-i18n="gifEditorEdgeCropTitle">' + shared.fns.t('gifEditorEdgeCropTitle', 'Edge Crop') + '</div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; gap:8px; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-t" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropTop">' + shared.fns.t('gifEditorCropTop', 'Top:') + '</label>' +
      '            <input type="range" id="gif-slider-t" min="0" max="100" value="0" style="flex:1;">' +
      '            <input type="number" id="gif-crop-t" min="0" value="0" style="width:64px;">' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; gap:8px; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-b" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropBottom">' + shared.fns.t('gifEditorCropBottom', 'Bottom:') + '</label>' +
      '            <input type="range" id="gif-slider-b" min="0" max="100" value="0" style="flex:1;">' +
      '            <input type="number" id="gif-crop-b" min="0" value="0" style="width:64px;">' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; gap:8px; width:100%; margin-bottom:6px;">' +
      '            <label for="gif-crop-l" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropLeft">' + shared.fns.t('gifEditorCropLeft', 'Left:') + '</label>' +
      '            <input type="range" id="gif-slider-l" min="0" max="100" value="0" style="flex:1;">' +
      '            <input type="number" id="gif-crop-l" min="0" value="0" style="width:64px;">' +
      '          </div>' +
      '          <div class="gif-import-field-row" style="display:flex; align-items:center; gap:8px; width:100%; margin-bottom:8px;">' +
      '            <label for="gif-crop-r" class="gif-import-label" style="width:50px; font-size:12px; flex-shrink:0;" data-i18n="gifEditorCropRight">' + shared.fns.t('gifEditorCropRight', 'Right:') + '</label>' +
      '            <input type="range" id="gif-slider-r" min="0" max="100" value="0" style="flex:1;">' +
      '            <input type="number" id="gif-crop-r" min="0" value="0" style="width:64px;">' +
      '          </div>' +
      '          <div class="gif-import-control-group" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 10px 0 6px;">' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-cols" class="gif-import-label" style="font-size:11px; display:block; margin-bottom:2px;">' + shared.fns.t('gifEditorGridCols', 'Cols:') + '</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-cols\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-cols" min="1" max="100" value="1">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-cols\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '            <div class="gif-import-field-vert">' +
      '              <label for="gif-rows" class="gif-import-label" style="font-size:11px; display:block; margin-bottom:2px;">' + shared.fns.t('gifEditorGridRows', 'Rows:') + '</label>' +
      '              <div class="number-stepper">' +
      '                <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-rows\', -1)">-</button>' +
      '                <input type="number" class="stepper-input" id="gif-rows" min="1" max="100" value="1">' +
      '                <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-rows\', 1)">+</button>' +
      '              </div>' +
      '            </div>' +
      '          </div>' +
      '          <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-slice-btn" style="margin-top: 4px;" data-i18n="gifEditorSliceBtn">' + shared.fns.t('gifEditorSliceBtn', 'Slice Grid') + '</button>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 4. Set Latency -->' +
      '      <div id="gif-global-delay-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-delay-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorGlobalDelay">' + shared.fns.t('gifEditorGlobalDelay', 'Set Latency') + '</span>' +
      '        </button>' +
      '        <div id="gif-delay-panel" class="gif-delay-panel gif-sidebar-panel">' +
      '          <div class="gif-import-field-vert" style="width: 100%; margin-bottom: 8px;">' +
      '            <label for="gif-batch-delay-input" class="gif-import-label" style="font-size: 11px; display: block; margin-bottom: 2px;" data-i18n="gifEditorDelayLabel">' + shared.fns.t('gifEditorDelayLabel', 'Frame Latency (ms):') + '</label>' +
      '            <div class="number-stepper" style="width: 100%;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-batch-delay-input\', -10)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-batch-delay-input" min="0" value="100" placeholder="100">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-batch-delay-input\', 10)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-crop-action-btn" id="gif-batch-delay-btn" data-i18n="gifEditorApplyDelay">' + shared.fns.t('gifEditorApplyDelay', 'Apply') + '</button>' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-cancel-delay-btn" data-i18n="gifEditorCancelDelay">' + shared.fns.t('gifEditorCancelDelay', 'Cancel') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 5. Batch Frame Delete -->' +
      '      <div id="gif-batch-delete-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-batch-delete-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorBatchDelete">' + shared.fns.t('gifEditorBatchDelete', 'Batch Frame Delete') + '</span>' +
      '        </button>' +
      '        <div id="gif-batch-delete-panel" class="gif-batch-delete-panel gif-sidebar-panel">' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px;">' +
      '            <input type="number" id="gif-del-start" placeholder="' + shared.fns.t('gifEditorStartFrame', 'Start') + '" min="1" style="width:100%; box-sizing:border-box;">' +
      '            <input type="number" id="gif-del-end" placeholder="' + shared.fns.t('gifEditorEndFrame', 'End') + '" min="1" style="width:100%; box-sizing:border-box;">' +
      '          </div>' +
      '          <div class="gif-control-row" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-delete-range-btn" data-i18n="gifEditorDelRange">' + shared.fns.t('gifEditorDelRange', 'Delete Range') + '</button>' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-crop-action-btn" id="gif-keep-range-btn" data-i18n="gifEditorKeepRange">' + shared.fns.t('gifEditorKeepRange', 'Keep Range') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 6. Reduce Frame -->' +
      '      <div id="gif-interval-delete-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-interval-delete-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorReduceFrame">' + shared.fns.t('gifEditorReduceFrame', 'Reduce Frame') + '</span>' +
      '        </button>' +
      '        <div id="gif-interval-delete-panel" class="gif-interval-delete-panel gif-sidebar-panel">' +
      '          <div class="gif-import-field-vert" style="width: 100%; margin-bottom: 8px;">' +
      '            <label for="gif-interval-delete-val" class="gif-import-label" style="font-size: 11px; display: block; margin-bottom: 2px;" data-i18n="gifEditorInterval">' + shared.fns.t('gifEditorInterval', 'Interval (N):') + '</label>' +
      '            <div class="number-stepper" style="width: 100%;">' +
      '              <button type="button" class="stepper-btn stepper-minus" tabindex="-1" onclick="changeStepper(\'gif-interval-delete-val\', -1)">-</button>' +
      '              <input type="number" class="stepper-input" id="gif-interval-delete-val" min="1" value="1" placeholder="1">' +
      '              <button type="button" class="stepper-btn stepper-plus" tabindex="-1" onclick="changeStepper(\'gif-interval-delete-val\', 1)">+</button>' +
      '            </div>' +
      '          </div>' +
      '          <div class="gif-muted-hint" data-i18n="gifEditorIntervalDeleteHint" style="font-size:11px; color:var(--text-muted); margin-bottom:10px; line-height:1.3;">' + shared.fns.t('gifEditorIntervalDeleteHint', '* Delete 1 frame every N frames, automatically adjusting delay to preserve total duration') + '</div>' +
      '          <div class="gif-control-row" style="margin-top: 10px;">' +
      '            <button type="button" class="gif-btn gif-btn-danger gif-crop-action-btn" id="gif-interval-delete-btn" style="width:100%;" data-i18n="gifEditorIntervalDeleteBtn">' + shared.fns.t('gifEditorIntervalDeleteBtn', 'Apply') + '</button>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +

      '      <!-- 7. Overlay -->' +
      '      <div id="gif-overlay-container" style="margin-top: 8px; margin-bottom: 8px; width: 100%; box-sizing: border-box;">' +
      '        <button type="button" class="gif-btn gif-btn-primary gif-full-width" id="gif-overlay-toggle-btn" style="width:100%; height:38px; display:flex; align-items:center; justify-content:center; font-weight:600; box-sizing:border-box;">' +
      '          <span data-i18n="gifEditorOverlay">' + shared.fns.t('gifEditorOverlay', 'Overlay') + '</span>' +
      '        </button>' +
      '        <div id="gif-overlay-panel" class="gif-overlay-panel gif-sidebar-panel">' +
      '          <div class="gif-group-title" style="margin-bottom:6px; font-weight:bold; font-size:12px; color:var(--accent-color);" data-i18n="gifEditorApplyTo">' + shared.fns.t('gifEditorApplyTo', 'Apply To') + '</div>' +
      '          <div class="gif-control-row" style="display:flex; gap:10px; align-items:center; margin-bottom:8px; font-size:12px;">' +
      '            <label class="gif-check-label" style="display:flex; align-items:center; gap:3px; cursor:pointer;"><input type="radio" name="gif-scope" value="current" checked> <span data-i18n="gifEditorScopeCurrent">' + shared.fns.t('gifEditorScopeCurrent', 'Current') + '</span></label>' +
      '            <label class="gif-check-label" style="display:flex; align-items:center; gap:3px; cursor:pointer;"><input type="radio" name="gif-scope" value="all"> <span data-i18n="gifEditorScopeAll">' + shared.fns.t('gifEditorScopeAll', 'All') + '</span></label>' +
      '            <label class="gif-check-label" style="display:flex; align-items:center; gap:3px; cursor:pointer;"><input type="radio" name="gif-scope" value="range"> <span data-i18n="gifEditorScopeRange">' + shared.fns.t('gifEditorScopeRange', 'Range') + '</span></label>' +
      '          </div>' +
      '          <div id="gif-crop-range-inputs" style="display:none; gap:8px; align-items:center; margin-bottom:8px;">' +
      '            <input type="number" id="gif-crop-start" placeholder="' + shared.fns.t('gifEditorStartFrame', 'Start') + '" min="1" style="width:50%; box-sizing:border-box; padding:4px 6px; font-size:12px;">' +
      '            <input type="number" id="gif-crop-end" placeholder="' + shared.fns.t('gifEditorEndFrame', 'End') + '" min="1" style="width:50%; box-sizing:border-box; padding:4px 6px; font-size:12px;">' +
      '          </div>' +
      '          <div class="gif-group-title" style="margin-top:8px; margin-bottom:6px; font-weight:bold; font-size:12px; color:var(--accent-color);" data-i18n="gifEditorAddTextTitle">' + shared.fns.t('gifEditorAddTextTitle', 'Add Text / Subtitle') + '</div>' +
      '          <div class="gif-control-row" style="margin-bottom:6px;">' +
      '            <input type="text" id="gif-text-input" placeholder="' + shared.fns.t('gifEditorAddTextPlaceholder', 'Enter text...') + '" style="width:100%; box-sizing:border-box; padding:6px 8px; font-size:12px;">' +
      '          </div>' +
      '          <div class="gif-control-row" style="display:flex; gap:6px; align-items:center; margin-bottom:8px;">' +
      '            <button type="button" class="gif-btn gif-btn-ghost" id="gif-btn-bold" style="font-weight:bold; width:30px; height:30px; padding:0;">B</button>' +
      '            <button type="button" class="gif-btn gif-btn-ghost" id="gif-btn-italic" style="font-style:italic; width:30px; height:30px; padding:0;">I</button>' +
      '            <button type="button" class="gif-btn gif-btn-ghost" id="gif-btn-underline" style="text-decoration:underline; width:30px; height:30px; padding:0;">U</button>' +
      '            <input type="color" id="gif-text-color" value="#ffffff" style="width:30px; height:30px; padding:0; border:none; cursor:pointer;" data-tooltip="' + shared.fns.t('gifEditorTextColor', 'Text Color') + '">' +
      '            <input type="color" id="gif-text-stroke-color" value="#000000" style="width:30px; height:30px; padding:0; border:none; cursor:pointer;" data-tooltip="' + shared.fns.t('gifEditorStrokeColor', 'Stroke Color') + '">' +
      '            <button type="button" class="gif-btn gif-btn-primary gif-flex-1" id="gif-add-text-btn" style="height:30px; padding:0 8px; font-size:12px;" data-i18n="gifEditorAddTextBtn">' + shared.fns.t('gifEditorAddTextBtn', '+ Add Text') + '</button>' +
      '          </div>' +
      '          <div class="gif-group-title" style="margin-top:10px; margin-bottom:6px; font-weight:bold; font-size:12px; color:var(--accent-color);" data-i18n="gifEditorAddImageTitle">' + shared.fns.t('gifEditorAddImageTitle', 'Add Image / Watermark') + '</div>' +
      '          <div class="gif-control-row" style="margin-bottom:8px;">' +
      '            <label class="gif-btn gif-btn-primary gif-full-width" style="display:flex; align-items:center; justify-content:center; height:32px; font-size:12px; cursor:pointer; width:100%; box-sizing:border-box;">' +
      '              <span data-i18n="gifEditorAddImageBtn">' + shared.fns.t('gifEditorAddImageBtn', '📷 Add Image / Watermark') + '</span>' +
      '              <input type="file" id="gif-add-image-input" accept="image/*" style="display:none;">' +
      '            </label>' +
      '          </div>' +
      '          <div id="gif-selected-layer-tools" style="margin-top:10px; border-top:1px dashed var(--glass-border); padding-top:8px;">' +
      '            <div class="gif-group-title" style="margin-bottom:6px; font-weight:bold; font-size:11px; color:var(--text-muted);" data-i18n="gifEditorLayerTools">' + shared.fns.t('gifEditorLayerTools', 'Layer Options') + '</div>' +
      '            <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">' +
      '              <span style="font-size:11px; color:var(--text-muted);" data-i18n="gifEditorLayerScale">' + shared.fns.t('gifEditorLayerScale', 'Scale:') + '</span>' +
      '              <input type="range" id="gif-layer-scale" min="0.2" max="3" step="0.05" value="1" style="flex:1;">' +
      '            </div>' +
      '            <div class="gif-control-row" style="display:flex; gap:8px; align-items:center; margin-bottom:6px;">' +
      '              <button type="button" class="gif-btn gif-btn-danger gif-full-width" id="gif-delete-layer-btn" style="height:28px; font-size:11px;" data-i18n="gifEditorDeleteLayer">' + shared.fns.t('gifEditorDeleteLayer', 'Delete Layer') + '</button>' +
      '            </div>' +
      '          </div>' +
      '          <div id="gif-layer-list" style="margin-top:8px; max-height:100px; overflow-y:auto; font-size:11px;"></div>' +
      '        </div>' +
      '      </div>' +

      '    </div>' +
      '  </aside>' +
      '  <main class="gif-stage-area" id="gif-stage-container">' +
      '    <div class="gif-stage-overlay-text" id="gif-stage-overlay-text">' + shared.fns.t('gifEditorStageIdle', 'Stage') + '</div>' +
      '    <div class="gif-canvas-wrapper" id="gif-canvas-wrapper">' +
      '      <canvas id="gif-preview-canvas"></canvas>' +
      '    </div>' +
      '    <div class="gif-stage-controls">' +
      '      <button type="button" class="gif-icon-btn" id="gif-zoom-out-btn" data-tooltip="' + shared.fns.t('gifEditorZoomOut', '缩小') + '">-</button>' +
      '      <button type="button" class="gif-icon-btn" id="gif-reset-view-btn" data-tooltip="' + shared.fns.t('gifEditorResetView', '重置') + '">1:1</button>' +
      '      <button type="button" class="gif-icon-btn" id="gif-zoom-in-btn" data-tooltip="' + shared.fns.t('gifEditorZoomIn', '放大') + '">+</button>' +
      '    </div>' +
      '  </main>' +
      '  <section class="gif-timeline-area" aria-label="' + shared.fns.t('gifEditorTimelineAria', 'GIF timeline') + '">' +
      '    <div class="gif-timeline-scroll" id="gif-timeline-scroll">' +
      '      <div class="gif-timeline-track" id="gif-timeline"></div>' +
      '    </div>' +
      '    <div class="gif-timeline-toolbar">' +
      '      <div class="gif-timeline-zoom-control">' +
      '        <span class="gif-zoom-label" style="font-size:12px; color:var(--text-muted); margin-right:2px;" data-i18n="gifTimelineZoom">' + shared.fns.t('gifTimelineZoom', '缩略图') + '</span>' +
      '        <input type="range" id="gif-timeline-zoom-range" min="0.2" max="3" step="0.05" value="1" style="width:100px; cursor:pointer;" data-tooltip="' + shared.fns.t('gifTimelineZoom', '缩略图') + '">' +
      '        <span id="gif-timeline-zoom-value" style="font-size:11px; color:var(--text-muted); min-width:35px;">100%</span>' +
      '      </div>' +
      '      <div class="gif-timeline-nav" role="group">' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-first" data-tooltip="' + shared.fns.t('gifTimelineFirst', '第一帧') + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 19 2 12 11 5 11 19"/><polygon points="22 19 13 12 22 5 22 19"/></svg></button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-prev" data-tooltip="' + shared.fns.t('gifTimelinePrev', '上一帧') + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-reverse" data-tooltip="' + shared.fns.t('gifTimelineReverse', '反向播放') + '" aria-label="' + shared.fns.t('gifTimelineReverse', '反向播放') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="19 3 5 12 19 21 19 3"/></svg></button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-play" data-tooltip="' + shared.fns.t('gifTimelinePlay', '播放') + '" aria-label="' + shared.fns.t('gifTimelinePlay', '播放') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-next" data-tooltip="' + shared.fns.t('gifTimelineNext', '下一帧') + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>' +
      '        <button type="button" class="gif-timeline-control" id="gif-timeline-last" data-tooltip="' + shared.fns.t('gifTimelineLast', '最后一帧') + '"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 19 22 12 13 5 13 19"/><polygon points="2 19 11 12 2 5 2 19"/></svg></button>' +
      '        <button type="button" class="gif-timeline-control gif-loop-toggle" id="gif-timeline-loop" data-tooltip="' + shared.fns.t('gifTimelineLoop', '循环') + '" aria-label="' + shared.fns.t('gifTimelineLoop', '循环') + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg></button>' +
      '      </div>' +
      '      <span class="gif-timeline-count" id="gif-timeline-count">0 / 0</span>' +
      '    </div>' +
      '  </section>' +

      '  <div class="gif-spinner-overlay" id="gif-loading-spinner">' +
      '    <div class="liquid-loader">' +
      '      <div class="loading-text">' +
      '        Loading<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>' +
      '      </div>' +
      '      <div class="loader-track">' +
      '        <div class="liquid-fill" id="gif-liquid-fill"></div>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +

      '</div>';
  }
  shared.fns.pageTemplate = pageTemplate;

  // Lifecycle globals: shared.fns may be populated across split files; wire window exports via shared.
  // The real window exports are also wired by gif-editor.js core as backup; this ensures page-load order independence.
  function wireGlobals(){
    if (shared.fns.render) window.renderGifEditor = shared.fns.render;
    if (shared.fns.cleanup) window.cleanupGifEditor = shared.fns.cleanup;
    if (shared.fns.suspend) window.suspendGifEditor = shared.fns.suspend;
    if (shared.fns.resume) window.resumeGifEditor = shared.fns.resume;
    if (shared.fns.render) window.GifEditor = { render: shared.fns.render, cleanup: shared.fns.cleanup, suspend: shared.fns.suspend, resume: shared.fns.resume };
  }
  wireGlobals();
  // Re-wire after any later split loads (in case page loaded before core)
  if (!window.GifEditor || !window.renderGifEditor) setTimeout(wireGlobals, 0);
})();
