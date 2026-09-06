/**
 * Editor V2 - Diff Web Worker
 * Offloads heavy diff computations (>1000 lines) from the main UI thread.
 */
'use strict';

let diffLoaded = false;

function ensureDiffCore() {
  if (diffLoaded) return;
  try {
    importScripts('/vendor/diff.min.js');
    importScripts('/utility/editor-v2/editor-v2-diff-core.js');
    diffLoaded = true;
  } catch (err) {
    throw new Error('Failed to importScripts in DiffWorker: ' + err.message);
  }
}

self.onmessage = function (e) {
  const { jobId, type, left, right } = e.data || {};
  if (type !== 'compare') return;

  try {
    ensureDiffCore();
    const rows = self.EditorV2DiffCore.compare(left || '', right || '', self.Diff);
    self.postMessage({ jobId, session: { rows } });
  } catch (err) {
    self.postMessage({ jobId, error: err.message || String(err) });
  }
};
