let currentFilePath = null;
let openTabs = new Map();
let fileStructure = { 'root': { type: 'folder', children:[], expanded: true, displayName: 'root' } };
const defaultSettings = {
    autoCloseTags: true, matchBrackets: true, autoCloseBrackets: true,
    theme: 'monokai', wordWrap: false, tabWidth: 4, foldGutter: true,
    sidebarWidth: '250px', editorPaneFlexBasis: '50%', previewPaneFlexBasis: '50%',
    autoSaveSession: true, autoSaveOnBlur: false, fileTemplates: true,
    bracketColorization: true, autoSaveInterval: false, autoSaveIntervalMs: 30000,
    treeDeleteWindowMs: 1500, activeLineHighlight: true,
    consoleHeightPct: 30
};

const RECENT_FILES_MAX = 20;
let recentFiles = []; // [{ path, displayName, timestamp }]
let settings = { ...defaultSettings };
let untitledTabCounter = 1;
let currentWorkingDirectory = 'root';
let activeContextMenu = null;
let dragSrcPath = null; // currently dragged file-tree node path

// Tab state
let pinnedTabs = new Set(); // Set of pinned file paths

let lastClickedTreePath = null; // Last clicked file or folder in the tree
let lastClickedTreeTime = 0;   // Timestamp of that click

const VERSION = "0.4.0";
// v2 fork: namespace every storage key so coding-project-v2 never shares browser storage
// with the original coding-project (even when both are served from the same origin).
const STORAGE_NAMESPACE = 'codeEditV2';
const SESSION_STORAGE_KEY = `${STORAGE_NAMESPACE}_session_${VERSION}`;
const SETTINGS_STORAGE_KEY = `${STORAGE_NAMESPACE}_settings`;
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const LARGE_FILE_THRESHOLD_BYTES = 1 * 1024 * 1024;
const PREVIEWABLE_EXTENSIONS = new Set([
    'html', 'htm', 'md', 'markdown', 'tex', 'latex', 'ltx', 'csv', 'xlsx', 'svg',
    // Raster images (shown via <img> in preview pane or dedicated image view)
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tiff', 'tif', 'avif'
]);
// Single source of truth; used by layout.js guards and fileOps.js openFile

const modeNames = { 'htmlmixed': 'HTML', 'javascript': 'JavaScript', 'text/typescript': 'TypeScript', 'text/jsx': 'JSX', 'text/typescript-jsx': 'TSX', 'python': 'Python', 'css': 'CSS', 'text/x-scss': 'SCSS', 'text/x-less': 'Less', 'text/x-sass': 'Sass', 'application/json': 'JSON', 'markdown': 'Markdown', 'text/plain': 'Plain Text', 'text/x-csrc': 'C', 'text/x-c++src': 'C++', 'text/x-csharp': 'C#', 'text/x-java': 'Java', 'application/x-httpd-php': 'PHP', 'text/x-sql': 'SQL', 'text/x-yaml': 'YAML', 'text/x-sh': 'Shell', 'rust': 'Rust', 'go': 'Go', 'text/x-stex': 'LaTeX', 'text/x-ruby': 'Ruby', 'text/x-kotlin': 'Kotlin', 'text/x-swift': 'Swift', 'text/x-lua': 'Lua', 'text/x-perl': 'Perl', 'text/x-rsrc': 'R', 'text/x-dockerfile': 'Dockerfile', 'text/x-properties': 'Properties', 'text/x-toml': 'TOML', 'text/x-vue': 'Vue', 'text/x-svelte': 'Svelte', 'graphql': 'GraphQL', 'xml': 'XML' };

const jsHintOptions = { 
    browser: true, 
    esversion: 11, 
    undef: false,     
    unused: false,    
    globals: { console: false, window: false, document: false, setTimeout: false, setInterval: false, clearTimeout: false, clearInterval: false, Promise: false, fetch: false, localStorage: false, sessionStorage: false, CodeMirror: false, XLSX: false, fflate: false, saveAs: false, prettier: false, prettierPlugins: false, CSSLint: false, jsonlint: false, JSHINT: false, markdownit: false } 
};

let currentSearchQuery = '';
let isPreviewEnabled = false;
let _previewScrollHandler = null; // bound scroll handler for preview sync
let codeEditor;
let localSearchCaseSensitive = false;
let localSearchRegex = false;
let globalSearchCaseSensitive = false;

// Diff Variables
let isDiffEnabled = false;
let diffView = null;

// Auto-save interval handle
let autoSaveIntervalHandle = null;

let mdInstance = null;
function getMarkdownInstance() {
    if (!mdInstance && typeof markdownit !== 'undefined') {
        mdInstance = window.markdownit({ html: true, linkify: true, typographer: true });
    }
    return mdInstance;
}

let searchWorker = null;
let zipWorker = null;
let folderZipWorker = null;