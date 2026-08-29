// web/static/music/music.js
// Music module — decoupled from Gallery/Download/Playground.
// Rendered via `renderGalleryWithMenu` when galleryActiveTool==='music'.
// See docs/music-implementation-plan.md for the full fusion blueprint.

function renderMusic(container) {
  container.innerHTML = '' +
    '<div style="padding:28px;max-width:780px">' +
      '<h2 style="margin:0 0 8px 0;font-size:18px">'+escapeHtml(t('music')||'Music')+'</h2>' +
      '<p style="color:var(--text-secondary);line-height:1.6;margin:0 0 16px 0">' +
        escapeHtml(t('comingSoon')||'Coming soon') +
        ' — ' + escapeHtml('See docs/music-implementation-plan.md for the implementation blueprint.') +
      '</p>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
        '<button class="btn btn-ghost" onclick="openPathSettingsModal({title:t(\'pathSettings\'),sections:{musicDir:true}})">'+escapeHtml(t('pathSettings')||'Path Settings')+'</button>' +
        '<span style="align-self:center;color:var(--text-tertiary);font-size:12px">'+escapeHtml((function(){try{return t("musicDir")||"Default Music Dir";}catch(e){return "Default Music Dir";}})())+' → Musics</span>' +
      '</div>' +
      '<div style="margin-top:20px;padding:12px;border:1px dashed var(--glass-border);border-radius:8px;color:var(--text-tertiary);font-size:12px;line-height:1.6">' +
        '<div><b>Planned stack</b>: MusicFree plugin host + Listen1/LX providers + Azusa Bilibili + Jamendo CC + yt-dlp/ffmpeg (zero new deps).</div>' +
        '<div style="margin-top:6px">Next steps: host.js + player &lt;audio&gt; + Jamendo search → playable MVP.</div>' +
      '</div>' +
    '</div>';
}

function cleanupMusic() {
  // No-op until player/timers exist; kept for galleryToolLifecycle symmetry.
}

function suspendMusic(){}
function resumeMusic(){}
