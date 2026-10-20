# CodeEdit User Guide

CodeEdit is a fully open-source, portable, persistent, and lightweight code editor built mainly in JS that runs entirely within your web browser.

The ambitious goal of this editor is to eventually make the user question not what they can do, but what they cannot do; a question I eventually seek to answer with, 'nothing.'

## 🔀 About this fork (v2)
This is **coding-project-v2**, a fork of [mtb-coding/coding-project](https://github.com/mtb-coding/coding-project) starting at v0.4.0. It keeps the full history of the original up to v0.3.4 and stores its session and settings under its own `codeEditV2_` browser storage keys, so it never reads or overwrites data saved by the original editor.

## ⚠️ Warning
**For the stable versions, see releases. Repo code is the current WIP version and might be broken.**

## 🖥️ Console
*   **Run JS**: Open the **Console** panel (`Console` button, `Ctrl+\``, or the command palette) and press **▶ Run** (`Ctrl+Enter` in the editor or console) to run the active `.js` file. It runs in an isolated sandbox with no access to the editor or its storage, and works offline. While a script is running, or still has timers pending, the button becomes **■ Stop**. Output is capped at 5,000 lines per run.
*   **Output**: `console.log`, `warn`, `error`, uncaught errors and unhandled promise rejections appear in the panel. Errors link to `file:line`; repeated lines collapse into ×N. Filter by All / Log / Warn / Error, and **Clear** (`Ctrl+L` in the panel) to empty it.
*   When the panel is closed, a badge in the status bar shows any errors or warnings; click it to reopen.
*   **Run Python**: `.py` files run the same way, using [Pyodide](https://pyodide.org) (CPython 3.14 in WebAssembly, pinned to v314.0.7) in its own sandboxed worker. Nothing is downloaded until your first `.py` run, which shows *Loading Python runtime (~5 MB, first run only)…*; the runtime then stays loaded so later runs start instantly. It loads from the jsDelivr CDN, and falls back to the bundled copy in `vendor/pyodide/` when the CDN is unreachable (offline needs the editor served over http(s), not `file://`). `print()` goes to the console and anything on stderr, including tracebacks, shows as an error row with a `file:line` link. **■ Stop** ends the run by restarting Python (*Restarting Python…*). `input()` is not supported (there is no stdin), and only the active file runs: importing your other project files isn't supported yet. Pyodide packages such as `numpy` load automatically from the CDN when imported; the bundled offline copy is the standard library only.

## 📂 Project & File Management
*   **New Project**: Resets the current environment and starts a fresh project.
*   **Open Directory**: Use the **Open Directory** button to load an entire folder structure into the editor. Your browser will keep these files in its local storage database.
*   **File Explorer**: The collapsible **File Explorer** panel on the left lets you navigate your project.
    *   **Right-click** any file or folder to access context menus for Renaming, Deleting, Creating new sub-items, Copying the path, and downloading a folder as a ZIP.
    *   **Root**: Right-click the root folder to rename the project, collapse/expand all folders, or sort files by extension.
    *   **Drag and Drop**: You can drag files or folders directly into the sidebar to import them into your workspace. You can also drag items within the explorer to reorder or move them (this also updates their paths). A blue insert-line indicator shows exactly where the item will land.
*   **Recent Files**: A collapsible **Recent Files** panel above the File Explorer tracks the last 20 files you opened. Click any entry to reopen it; click `×` to remove it from the list. Recent files are persisted across sessions.
*   **Downloading**: Click **Download Project** to zip your current workspace and save it to your computer. Right-click any folder in the tree and choose **Download Folder** to zip just that subtree. (Note: Windows may flag the downloaded zip — right-click it, open Properties, then click 'Unblock'.)

## ✍️ The Editor
*   **Tabs**: Manage multiple open files at the top of the editor pane.
    *   Right-click a tab for a context menu with options including "Close others," "Close all," and Rename (which renames the file in the explorer as well).
    *   An asterisk (`*`) indicates unsaved changes.
    *   Warnings appear when attempting to close a tab with unsaved changes.
    *   **Pin tabs** by right-clicking and selecting Pin — pinned tabs show a coloured top border and stay anchored to the left. Pinned tabs cannot close. To close, unpin the tab first.
        * Files can also be pinned by right clicking a file in the tree and selecting "Open and Pin."
    *   Use `Ctrl+Tab` / `Ctrl+Shift+Tab` to cycle between open tabs.
*   **Local Search & Replace**: Press `Ctrl+F` (Find) or `Ctrl+H` (Replace) to open the floating widget in the top-right of the editor.
    *   Click the **Aa** button (or press `Alt+C` while the widget is open) to toggle **case-sensitive** matching.
    *   Click the **.\*** button to toggle RegEx mode 
    *   Search matches are annotated as yellow tick marks on the scrollbar so you can see their distribution across the whole file at a glance.
*   **Global Search & Replace**: Use the top header input fields to search across **every file in your project**. Click **Replace All** to perform a project-wide replacement.
*   **Symbol Outline Palette**:  Scans the current file and presents a searchable jump list of symbols
*   **Breadcrumb**: Beneath the tabs is the full filepath to the current file. Click the filename to copy the path to your clipboard. Folder segments are clickable and update the current working directory.
*   **Go to Line / Column**: Press `Ctrl+G` (or click the `Ln/Col` indicator in the status bar) to jump to a specific line. Enter a line number (e.g. `42`) or a `line:column` pair (e.g. `42:10`).
*   **Formatting**: Use the **Format** button or `Ctrl+Shift+F` to automatically clean up your code using Prettier. Supported languages include JS, TS, JSX, TSX, CSS, HTML, JSON, Markdown, and GraphQL.
*   **Word Wrap**: Toggle word wrap from the `···` overflow menu in the toolbar. The current state is indicated by a checkmark.
*   **Diff Viewer**: Click the **Diff** button to open a side-by-side view of your unsaved changes vs. the last saved state. Edits made in the right (modified) pane are reflected back in the main editor.
*   **Auto-Save on Focus Loss**: Enable in Settings to automatically save the active file whenever you switch away from the browser tab.
*   **Timed Auto-Save**: Enable in Settings to automatically save all unsaved files on a configurable interval (minimum 5 seconds).
*   **Copy Contents**: Available in the `···` overflow menu — copies the full contents of the current file to the clipboard.
*   **Save All**: Available in the `···` overflow menu or via `Ctrl+Shift+S` — saves every open file with unsaved changes at once.
*   **Minimap**: A canvas-based minimap sits to the right of the editor. Click anywhere on it to jump to that position, or drag the viewport band to scroll.

## 🔧 Settings
There are many settings. Here's a list of them with a short description explaining what they do:
### Editor
- **Auto-Close Tags**: automatically closes tags
- **Match Brackets**: highlights the other bracket if you hover over its pair
- **Auto-Close Brackets**: automatically closes brackets
- **Bracket Pair Colorization**: colorizes bracket pairs, with alternating colors for each nested pair
- **Active Line Highlight**: highlights the current selected line
- **Code Folding**: whether or not code should be foldable
- **Word Wrap**: if the code goes off-screen, enabling this would wrap it to the next line but still treat it as one line
- **File Templates on New Files**: start your new files with prebuilt templates for that specific coding language
- **Delete Key Window (ms)**: the time the editor should wait till the delete key no longer triggers deletion after clicking a file or folder in the tree
### Session
- **Auto Save/Load Session**: Automatically saves and loads sessions to and from the browser
- **Auto-Save on Focus Loss**: Automatically saves session if window loses focus
- **Timed Auto-Save**: Automatically saves periodically
- **Save interval (s)**: The time interval the editor waits between each autosave
### Appearance
- **Theme**: Customizable color theme
- **Tab Width**: The number of spaces a `tab` press generates

## 🎨 Appearance & Themes
*   **Theme**: Choose from five editor themes in Settings — **Dark (Monokai)**, **Dracula**, **Solarized Dark**, **Solarized Light**, and **Light**. Each theme has a unique feel.
*   **Bracket Colorization**: Matching bracket pairs are coloured by nesting depth (three cycling colours). Can be toggled in Settings.
*   **Font**: The editor uses Fira Code with fallbacks to Consolas and Monaco for ligature and monospace rendering.

## ⚙️ Command Palette
Can't remember a shortcut?
*   **Open**: Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on Mac).
*   **Usage**: Type to filter through available commands (e.g., "save," "new," "format," "goto"). Use arrow keys to navigate and `Enter` to execute. Press `Esc` to close.

## 👁️ Preview Mode
Click the **Preview** button to enable the split-pane preview.
### Supported Files:
*   **Markdown**: Automatically renders headers, formatting, blockquotes, tables, and code blocks.
*   **HTML**: Renders the raw HTML content in real-time. (Linked external CSS/JS files are not resolved.)
*   **LaTeX**: `.tex` and `.bib` files render a live KaTeX preview. Math, sections, lists, and common environments are supported.
*   **CSV and XLSX**: These render as simple tables with filter functionality.
*   **SVG**: Renders the image. (This also means you have a live SVG editor, sweet!)

## 🛠️ Workspace Isolation
Because CodeEdit persists your work in your browser's database, you may want to separate different projects. To do this:
1.  Open `js/globals.js`.
2.  Update the `VERSION` constant (e.g. `"0.2.3"` or any other string). Note, the page title by default appends `v[VERSION]` to the end. To change this behavior, you can edit line 17 of `main.js`.
3.  The editor will treat this as a completely separate workspace, isolating files, tabs, and session state from any other version.

## ⌨️ Keyboard Shortcuts Reference

| Action | Shortcut |
| :--- | :--- |
| **Open Command Palette** | `Ctrl + Shift + P` |
| **Save Current File** | `Ctrl + S` |
| **Save All Files** | `Ctrl + Shift + S` |
| **New File** | `Ctrl + Shift + N` |
| **New Folder** | `Ctrl + Shift + D` |
| **New Untitled Tab** | `Ctrl + N` |
| **Close Tab** | `Ctrl + W` |
| **Cycle Tabs Forward** | `Ctrl + Tab` |
| **Cycle Tabs Backward** | `Ctrl + Shift + Tab` |
| **Format Document** | `Ctrl + Shift + F` |
| **Find in File** | `Ctrl + F` |
| **Replace in File** | `Ctrl + H` |
| **Toggle Case Sensitive (Find)** | `Alt + C` (widget open) |
| **Go to Line / Column** | `Ctrl + G` |
| **Toggle Comment** | `Ctrl + /` |
| **Global Search Focus** | `Ctrl + Shift + G` |
| **Search Files** | `Ctrl + P` |
| **Go to Symbol in File** | `Ctrl + Shift + O` |
| **Regex Search Mode** | `Alt + R` |

## ⚠️ Known Limitations
1. The console only runs JavaScript and Python (no compiler or other languages yet)
2. Binary files, videos, and certain unsupported formats are currently unsupported.

---
*Pro-Tip: CodeEdit is persistent. If you close your browser tab and come back later, your files, folders, open tabs, and recent file history will be exactly where you left them.*
