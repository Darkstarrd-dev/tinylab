// web/demo-designer.test.js
// Zero-dependency wiring contract for the Game Designer Demo tool.
// Asserts: index wiring (menu + script order), app-demo lifecycle, app-router
// route/cleanup, i18n keys, and the demo-designer.js source contract.
// Run: node web/demo-designer.test.js
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) {
    failures++;
    console.error('FAIL  ' + name + ': ' + (e && e.message));
  }
}

const STATIC = path.join(__dirname, 'static');
const WEB = path.join(__dirname, '..', 'web');

console.log('designer wiring:');

check('both index variants have data-demo-tool="design" and load demo-designer.js after demo-games.js', () => {
  for (const f of ['index.html', 'index-nopg.html']) {
    const html = fs.readFileSync(path.join(STATIC, f), 'utf8');
    assert.ok(html.indexOf('data-demo-tool="design"') > 0, f + ' missing design menu button');
    assert.ok(html.indexOf('>Game Designer</button>') > 0, f + ' design button must say Game Designer');
    const g = html.indexOf('<script src="/demo-games.js"></script>');
    const d = html.indexOf('<script src="/demo-designer.js"></script>');
    assert.ok(g > 0, f + ' missing demo-games.js script tag');
    assert.ok(d > g, f + ' demo-designer.js must be after demo-games.js');
  }
});

check('app-demo.js: DEMO_TOOLS contains design entry', () => {
  const src = fs.readFileSync(path.join(STATIC, 'app-demo.js'), 'utf8');
  assert.ok(src.indexOf("id: 'design'") >= 0 || src.indexOf('id: "design"') >= 0 || src.indexOf("id: 'design', labelKey: 'design'") >= 0, 'missing { id: design, labelKey: design } entry');
  assert.ok(src.includes("labelKey: 'design'"), 'design entry must use labelKey design');
});

check('app-demo.js: demoHasTool("design") checks GameDesigner', () => {
  const src = fs.readFileSync(path.join(STATIC, 'app-demo.js'), 'utf8');
  assert.ok(src.includes("id === 'design'") && src.includes('GameDesigner'), 'design hasTool branch missing');
  assert.ok(src.includes("typeof GameDesigner !== 'undefined'"), 'design hasTool must guard typeof GameDesigner');
});

check('app-demo.js: lifecycle has design suspend hook', () => {
  const src = fs.readFileSync(path.join(STATIC, 'app-demo.js'), 'utf8');
  assert.ok(src.includes("design: { suspend: 'cleanupGameDesigner'"), 'design lifecycle hook missing');
});

check('app-demo.js: renderDemoWithMenu branches to GameDesigner.render when design active', () => {
  const src = fs.readFileSync(path.join(STATIC, 'app-demo.js'), 'utf8');
  assert.ok(src.includes("demoActiveTool === 'design'") && src.includes('GameDesigner.render(container)'), 'design render branch missing');
  assert.ok(src.includes('renderGameDesigner failed'), 'design render branch must log renderGameDesigner failed');
});

check('app-router.js: case "design" routes to renderDemoWithMenu', () => {
  const src = fs.readFileSync(path.join(STATIC, 'app-router.js'), 'utf8');
  // tolerant to whitespace variations: navigateTo switch includes exactly one case 'design'
  assert.ok(/case\s*'design':\s*return\s*renderDemoWithMenu\(container\)/.test(src), 'missing case design in navigateTo');
});

check('app-router.js: leaving demo cleans up GameDesigner', () => {
  const src = fs.readFileSync(path.join(STATIC, 'app-router.js'), 'utf8');
  assert.ok(src.includes('typeof cleanupGameDesigner ===') && src.includes('cleanupGameDesigner()'), 'missing cleanupGameDesigner fallback on leave');
});

check('demo-games.js: __dgames seam has loadPhaser and injectScript for designer', () => {
  const src = fs.readFileSync(path.join(STATIC, 'demo-games.js'), 'utf8');
  assert.ok(src.includes('loadPhaser: dgLoadPhaser'), 'missing loadPhaser in __dgames seam');
  assert.ok(src.includes('injectScript: dgInjectScript'), 'missing injectScript in __dgames seam');
});

check('i18n: design + designer* keys in en and zh', () => {
  const i18n = fs.readFileSync(path.join(STATIC, 'i18n.js'), 'utf8');
  for (const k of ['design:', 'designerNewProject:', 'designerRun:', 'designerStop:', 'designerReload:', 'designerProjectIdPrompt:', 'designerDeleteProjectConfirm:']) {
    const n = i18n.split(k).length - 1;
    assert.ok(n >= 2, k + ' defined ' + n + ' time(s), expected en+zh (2+)');
  }
});

check('demo-designer.js: editor API calls go through ?root=games and use required verbs', () => {
  const src = fs.readFileSync(path.join(STATIC, 'demo-designer.js'), 'utf8');
  assert.ok(src.includes("?root=games"), 'demo-designer must query with root=games');
  assert.ok(src.includes('/api/editor/tree'), 'missing /api/editor/tree call');
  assert.ok(src.includes('/api/editor/open'), 'missing /api/editor/open call');
  assert.ok(src.includes('/api/editor/save'), 'missing /api/editor/save call');
  assert.ok(src.includes('/api/editor/delete'), 'missing /api/editor/delete call');
  assert.ok(src.includes('root=games'), 'all editor calls must scope to games root');
});

check('demo-designer.js: new project writes game.json matching plugin contract (id=dir, title, entry)', () => {
  const src = fs.readFileSync(path.join(STATIC, 'demo-designer.js'), 'utf8');
  assert.ok(src.includes('/game.json'), 'template must create <id>/game.json');
  assert.ok(src.includes('entry') && src.includes('main.js'), 'manifest must set entry to main.js');
  assert.ok(src.includes('/main.js'), 'template must create <id>/main.js');
  assert.ok(src.includes('TRGames.register'), 'main.js template must call TRGames.register');
  assert.ok(src.includes('launch: function (host)'), 'main.js template must provide launch(host)');
  assert.ok(src.includes('Phaser.Game'), 'main.js template must construct Phaser.Game');
  assert.ok(src.includes('window.__trgame'), 'template should expose __trgame seam');
});

check('demo-designer.js: preview flow uses blob injection + TRGames.register and host adapter', () => {
  const src = fs.readFileSync(path.join(STATIC, 'demo-designer.js'), 'utf8');
  assert.ok(src.includes('URL.createObjectURL'), 'preview must use blob injection');
  assert.ok(src.includes('loadPhaser'), 'preview must call loadPhaser');
  assert.ok(src.includes('injectScript'), 'preview must call injectScript');
  assert.ok(src.includes('makeHost'), 'preview must call makeHost');
  assert.ok(src.includes('delete') && src.includes('registry'), 'preview must evict registry before re-inject');
  assert.ok(src.includes('did not call TRGames.register'), 'preview must detect missing register');
});

check('demo-designer.js: reuses EditorLayout and modal prompts', () => {
  const src = fs.readFileSync(path.join(STATIC, 'demo-designer.js'), 'utf8');
  assert.ok(src.includes('EditorLayout.create'), 'must use EditorLayout.create');
  assert.ok(src.includes('EditorLayout.renderTree'), 'must use EditorLayout.renderTree');
  assert.ok(src.includes('promptModal') || src.includes('prompt('), 'must prompt via promptModal');
  assert.ok(src.includes('confirmModal'), 'must confirm deletes via confirmModal');
});

check('demo-designer.js: exports render/cleanup globals and mounts with class dgn-root', () => {
  const src = fs.readFileSync(path.join(STATIC, 'demo-designer.js'), 'utf8');
  assert.ok(src.includes('GameDesigner'), 'must export GameDesigner');
  assert.ok(src.includes('cleanupGameDesigner'), 'must export cleanupGameDesigner');
  assert.ok(src.includes('dgn-root'), 'must add dgn-root class for style scoping');
  // Global aliases for app-router / lifecycle that reference window.* directly
  assert.ok(src.includes('renderGameDesigner') && src.includes('cleanupGameDesigner'), 'must also expose renderGameDesigner / cleanupGameDesigner');
});

console.log(failures ? ('FAILED: ' + failures + ' check(s)') : '  all checks passed');
process.exit(failures ? 1 : 0);
