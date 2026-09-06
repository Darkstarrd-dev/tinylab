// Export all Monaco standalone API
export * from 'monaco-editor/esm/vs/editor/editor.api.js';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';

// Base editor widget and commands
import 'monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js';
import 'monaco-editor/esm/vs/editor/browser/coreCommands.js';

// Contributions
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/esm/vs/editor/contrib/comment/browser/comment.js';
import 'monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js';
import 'monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
import 'monaco-editor/esm/vs/editor/contrib/indentation/browser/indentation.js';
import 'monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js';
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/wordPartOperations/browser/wordPartOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/tokenization/browser/tokenization.js';
import 'monaco-editor/esm/vs/editor/contrib/readOnlyMessage/browser/contribution.js';

// Standalone quick access & codicons
import 'monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';

// Languages definitions
import 'monaco-editor/esm/vs/languages/definitions/markdown/register.js';
import 'monaco-editor/esm/vs/languages/definitions/javascript/register.js';
import 'monaco-editor/esm/vs/languages/definitions/typescript/register.js';
import 'monaco-editor/esm/vs/languages/definitions/go/register.js';
import 'monaco-editor/esm/vs/languages/definitions/yaml/register.js';
import 'monaco-editor/esm/vs/languages/definitions/html/register.js';
import 'monaco-editor/esm/vs/languages/definitions/css/register.js';
import 'monaco-editor/esm/vs/languages/definitions/xml/register.js';
import 'monaco-editor/esm/vs/languages/definitions/python/register.js';
import 'monaco-editor/esm/vs/languages/definitions/rust/register.js';
import 'monaco-editor/esm/vs/languages/definitions/cpp/register.js';
import 'monaco-editor/esm/vs/languages/definitions/java/register.js';
import 'monaco-editor/esm/vs/languages/definitions/shell/register.js';
import 'monaco-editor/esm/vs/languages/definitions/sql/register.js';
import 'monaco-editor/esm/vs/languages/definitions/lua/register.js';
import 'monaco-editor/esm/vs/languages/definitions/php/register.js';
import 'monaco-editor/esm/vs/languages/definitions/ruby/register.js';
import 'monaco-editor/esm/vs/languages/definitions/swift/register.js';
import 'monaco-editor/esm/vs/languages/definitions/kotlin/register.js';
import 'monaco-editor/esm/vs/languages/definitions/dart/register.js';
import 'monaco-editor/esm/vs/languages/definitions/ini/register.js';

// JSON registration using lightweight Monarch tokens (Prism-inspired, no LSP/worker)
monaco.languages.register({
  id: 'json',
  extensions: ['.json'],
  aliases: ['JSON', 'json'],
  mimetypes: ['application/json']
});

monaco.languages.setMonarchTokensProvider('json', {
  defaultToken: 'invalid',
  tokenPostfix: '.json',
  keywords: ['true', 'false', 'null'],
  tokenizer: {
    root: [
      // Numbers
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
      // Property keys
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'type.identifier'],
      // Strings
      [/"(?:[^"\\]|\\.)*"/, 'string'],
      // Delimiters
      [/[{}[\],:]/, 'delimiter'],
      // Whitespace
      [/\s+/, 'white'],
      // Keywords
      [/\b(?:true|false|null)\b/, 'keyword'],
    ]
  }
});

// Map .toml, .env, .cfg, .conf to ini
monaco.languages.register({
  id: 'ini',
  extensions: ['.toml', '.env', '.cfg', '.conf'],
  filenames: ['.env']
});
