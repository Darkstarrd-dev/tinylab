// web/pg-media-render.test.js
// Contract test for Playground media attachments (PDF, Video, Audio, Image)
// and SVG icon rendering in thumbs and message history bubbles.
//
// Run:  node web/pg-media-render.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    console.log('  ok  ' + name);
  }).catch((err) => {
    failures++;
    console.error('  FAIL ' + name + ': ' + (err && (err.stack || err.message || err)));
  });
}

function makeEnv() {
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, Math, Promise, JSON, Object, Array, String, Number, Error, RegExp,
    document: {
      documentElement: { getAttribute: () => 'zh' },
      getElementById: function (id) {
        return {
          innerHTML: '',
          value: '',
          classList: { add: () => {}, remove: () => {}, toggle: () => {} },
          addEventListener: () => {}
        };
      }
    },
    localStorage: {
      getItem: () => 'zh',
      setItem: () => {}
    },
    window: {}
  };
  sandbox.window = sandbox;

  const files = [
    'web/playground/static-pg/playground/pg-i18n.js',
    'web/playground/static-pg/playground/pg-core.js',
    'web/playground/static-pg/playground/pg-render.js'
  ];

  for (const f of files) {
    const code = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: f });
  }

  return sandbox;
}

async function runAll() {
  console.log('playground media render & SVG icon contract');

  const env = makeEnv();

  await check('pgGetMediaType correctly identifies PDF types', () => {
    assert.strictEqual(env.pgGetMediaType('data:application/pdf;base64,JVBERi0xLjQK...'), 'pdf');
    assert.strictEqual(env.pgGetMediaType('https://example.com/docs/spec.pdf'), 'pdf');
    assert.strictEqual(env.pgGetMediaType('file:///C:/path/test.PDF?token=123'), 'pdf');
  });

  await check('pgGetMediaType correctly identifies Video types', () => {
    assert.strictEqual(env.pgGetMediaType('data:video/mp4;base64,AAAA...'), 'video');
    assert.strictEqual(env.pgGetMediaType('data:video/webm;base64,GkXf...'), 'video');
    assert.strictEqual(env.pgGetMediaType('https://example.com/demo.mp4'), 'video');
    assert.strictEqual(env.pgGetMediaType('/path/to/movie.mkv'), 'video');
    assert.strictEqual(env.pgGetMediaType('clip.mov'), 'video');
  });

  await check('pgGetMediaType correctly identifies Audio types', () => {
    assert.strictEqual(env.pgGetMediaType('data:audio/mp3;base64,//uQ...'), 'audio');
    assert.strictEqual(env.pgGetMediaType('data:audio/wav;base64,UklG...'), 'audio');
    assert.strictEqual(env.pgGetMediaType('https://example.com/voice.mp3'), 'audio');
    assert.strictEqual(env.pgGetMediaType('/track.wav'), 'audio');
    assert.strictEqual(env.pgGetMediaType('song.flac'), 'audio');
    assert.strictEqual(env.pgGetMediaType('note.m4a'), 'audio');
  });

  await check('pgGetMediaType correctly identifies Image types', () => {
    assert.strictEqual(env.pgGetMediaType('data:image/png;base64,iVBOR...'), 'image');
    assert.strictEqual(env.pgGetMediaType('data:image/jpeg;base64,/9j/4...'), 'image');
    assert.strictEqual(env.pgGetMediaType('https://example.com/avatar.jpg'), 'image');
    assert.strictEqual(env.pgGetMediaType('/imgs/test.webp'), 'image');
  });

  await check('pgGetMediaSvg returns non-empty SVG for all types', () => {
    const pdfSvg = env.pgGetMediaSvg('pdf', 24);
    assert(pdfSvg.includes('<svg') && pdfSvg.includes('</svg>'), 'PDF SVG must be valid XML');
    assert(pdfSvg.includes('24'), 'Must respect requested size');

    const videoSvg = env.pgGetMediaSvg('video', 28);
    assert(videoSvg.includes('<svg') && videoSvg.includes('polygon'), 'Video SVG must have play button');

    const audioSvg = env.pgGetMediaSvg('audio', 22);
    assert(audioSvg.includes('<svg'), 'Audio SVG must be valid');
  });

  await check('pgRenderMediaPart renders rich card for PDF/video/audio and <img> for image', () => {
    // Image
    const imgHtml = env.pgRenderMediaPart('data:image/png;base64,abc', '', '');
    assert(imgHtml.includes('<img class="pg-image-thumb"'), 'Image should be rendered as <img>');

    // PDF
    const pdfHtml = env.pgRenderMediaPart('data:application/pdf;base64,xyz', '', 'manual.pdf');
    assert(pdfHtml.includes('pg-media-card-pdf'), 'PDF should be rendered with pg-media-card-pdf');
    assert(pdfHtml.includes('manual.pdf'), 'PDF should display filename');
    assert(!pdfHtml.includes('<img class="pg-image-thumb" src="data:application/pdf'), 'PDF must not be rendered as <img>');

    // Video
    const videoHtml = env.pgRenderMediaPart('data:video/mp4;base64,vid', '', 'clip.mp4');
    assert(videoHtml.includes('pg-media-card-video'), 'Video should be rendered with pg-media-card-video');
    assert(!videoHtml.includes('<img class="pg-image-thumb" src="data:video'), 'Video must not be rendered as <img>');

    // Audio
    const audioHtml = env.pgRenderMediaPart('data:audio/mp3;base64,aud', '', 'music.mp3');
    assert(audioHtml.includes('pg-media-card-audio'), 'Audio should be rendered with pg-media-card-audio');
    assert(!audioHtml.includes('<img class="pg-image-thumb" src="data:audio'), 'Audio must not be rendered as <img>');
  });

  await check('i18n translations contain all required media keys', () => {
    const cn = env.PG_I18N.cn;
    const en = env.PG_I18N.en;
    const requiredKeys = [
      'pgPdfPreview', 'pgVideoPreview', 'pgAudioPreview',
      'pgPdfDoc', 'pgVideoFile', 'pgAudioFile',
      'pgClickToPreview', 'pgClickToPlay',
      'pgOpenInNewTab', 'pgDownloadMedia'
    ];
    for (const k of requiredKeys) {
      assert(cn[k], `Missing Chinese key: ${k}`);
      assert(en[k], `Missing English key: ${k}`);
    }
  });

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  } else {
    console.log('\npg-media-render.test.js: all checks passed');
  }
}

runAll().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
