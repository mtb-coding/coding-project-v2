function toggleToolbarMenu(e) {
    e.stopPropagation();
    const menu = document.getElementById('toolbarOverflowMenu');
    const isOpen = menu.classList.contains('open');
    closeToolbarMenu();
    if (!isOpen) menu.classList.add('open');
}

function closeToolbarMenu() {
    const menu = document.getElementById('toolbarOverflowMenu');
    if (menu) menu.classList.remove('open');
}

document.addEventListener('DOMContentLoaded', async () => {
    // Abort gracefully if CodeMirror itself failed to load from CDN.
    // vendor-fallbacks.js will have replaced the page with an error message.
    if (typeof CodeMirror === 'undefined') return;

    initWorkers();

    document.title = `CodeEdit v${VERSION}`;

    codeEditor = CodeMirror(document.getElementById('codeEditor'), {
        lineNumbers: true, tabSize: settings.tabWidth, mode: 'text/plain', theme: settings.theme,
        foldGutter: settings.foldGutter, gutters: ["CodeMirror-linenumbers", "CodeMirror-foldgutter", "CodeMirror-lint-markers"],
        matchBrackets: settings.matchBrackets, autoCloseBrackets: settings.autoCloseBrackets, autoCloseTags: settings.autoCloseTags,
        lineWrapping: settings.wordWrap, lint: true,
        extraKeys: { 
            "Ctrl-Q": cm => cm.foldCode(cm.getCursor()), 
            "Ctrl-F": () => openLocalSearch(false), 
            "Cmd-F": () => openLocalSearch(false), 
            "Ctrl-H": () => openLocalSearch(true), 
            "Cmd-Option-F": () => openLocalSearch(true), 
            "Ctrl-G": () => openGoToLine(), "Cmd-L": () => openGoToLine(),
            "Ctrl-Space": "autocomplete", "Cmd-Space": "autocomplete", 
            "Ctrl-S": saveCurrentFile, "Cmd-S": saveCurrentFile, 
            "Ctrl-Shift-F": formatCode, "Cmd-Shift-F": formatCode, 
            "Ctrl-/": "toggleComment", "Cmd-/": "toggleComment",
            "Ctrl-Tab": () => cycleTab(1),
            "Ctrl-Shift-Tab": () => cycleTab(-1),
            "Delete": (cm) => {
                if (lastClickedTreePath && lastClickedTreePath !== 'root' && (Date.now() - lastClickedTreeTime) < (settings.treeDeleteWindowMs ?? 1500)) {
                    deleteEntry(lastClickedTreePath);
                } else {
                    return CodeMirror.Pass; // let CM handle normal deletion
                }
            },
            "Enter": (cm) => {
                // Only activate in Markdown mode
                if (cm.getOption('mode') !== 'markdown') return CodeMirror.Pass;

                const cursor = cm.getCursor();
                const line   = cm.getLine(cursor.line);

                // Match unordered bullet:  optional indent + (- | * | +) + space + content
                const unordered = line.match(/^(\s*)([-*+])\s(.*)/);
                // Match ordered bullet:    optional indent + digits + . + space + content
                const ordered   = line.match(/^(\s*)(\d+)\.\s(.*)/);

                if (unordered) {
                    const [, indent, marker, content] = unordered;
                    // Empty bullet — clear the line and pass through so CM inserts a plain newline
                    if (!content.trim()) {
                        cm.replaceRange('', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
                        return CodeMirror.Pass;
                    }
                    cm.replaceRange('\n' + indent + marker + ' ', { line: cursor.line, ch: line.length }, { line: cursor.line, ch: line.length });
                    cm.setCursor({ line: cursor.line + 1, ch: (indent + marker + ' ').length });
                    return;
                }

                if (ordered) {
                    const [, indent, num, content] = ordered;
                    if (!content.trim()) {
                        cm.replaceRange('', { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
                        return CodeMirror.Pass;
                    }
                    const next = String(parseInt(num, 10) + 1);
                    cm.replaceRange('\n' + indent + next + '. ', { line: cursor.line, ch: line.length }, { line: cursor.line, ch: line.length });
                    cm.setCursor({ line: cursor.line + 1, ch: (indent + next + '. ').length });
                    return;
                }

                return CodeMirror.Pass;
            }
        },
        hintOptions: { completeSingle: false }, indentUnit: settings.tabWidth, indentWithTabs: false, smartIndent: true
    });

    codeEditor.on("inputRead", function(cm, change) { 
        if (!cm.state.completionActive && change.origin !== "paste" && change.text[0]?.match(/[a-zA-Z<]/)) 
            setTimeout(() => cm.showHint({ completeSingle: false }), 50); 
    });

    codeEditor.on('change', (cm, change) => {
        // Denylist the system-only origins that should never mark a file unsaved.
        // 'setValue' fires when openFile loads content programmatically.
        // Everything else ('+input', '+delete', 'paste', 'cut', 'undo', 'redo',
        // 'complete', drag-drop, etc.) is a genuine user edit.
        const systemOrigins = ['setValue'];
        if (!systemOrigins.includes(change.origin)) {
            if (currentFilePath && fileStructure[currentFilePath]) {
                if (!fileStructure[currentFilePath].unsaved) {
                    fileStructure[currentFilePath].unsaved = true;
                    updateTabs();
                }
                fileStructure[currentFilePath].content = cm.getValue();
            }
        }
        updateStatusBar();
        if (codeEditor.getOption('lint')) setTimeout(() => codeEditor.performLint(), 500);
    });

    codeEditor.on('cursorActivity', updateStatusBar);
    const _debouncedBracketColorize = debounce(() => {
        if (settings.bracketColorization) applyBracketColorizationToEditor();
    }, 300);
    codeEditor.on('change', () => {
        if (settings.bracketColorization) _debouncedBracketColorize();
    });

    if (!fileStructure || !fileStructure.root) { fileStructure = { 'root': { type: 'folder', children: [], expanded: true, displayName: 'root' } }; }
    
    loadSettings();
    initSidebarResize();
    initEditorPreviewResize();
    initAutoSaveOnBlur();
    
    await loadSession();

    updatePreviewLayout();

    // Initialise minimap now that the editor and session are ready
    if (typeof initMinimap === 'function') initMinimap();

    // Capture-phase listener for Ctrl+W — Edge intercepts this at browser level
    // before the bubbling keydown fires, so we must use capture to beat it.
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'w') {
            e.preventDefault();
        }
        // Intercept Delete before CodeMirror when a tree node was the last thing clicked
        if (e.key === 'Delete' && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const tag = document.activeElement?.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && lastClickedTreePath && lastClickedTreePath !== 'root' && (Date.now() - lastClickedTreeTime) < (settings.treeDeleteWindowMs ?? 1500)) {
                e.preventDefault();
                e.stopPropagation();
                deleteEntry(lastClickedTreePath);
            }
        }
    }, true);

    document.addEventListener('keydown', async (e) => {
        if (e.key === 'Escape') { 
            closeContextMenu();
            closeToolbarMenu();
            const paletteVisible = document.getElementById('commandPalette').style.display !== 'none';
            const filePaletteVisible = document.getElementById('filePalette').style.display !== 'none';
            const symbolPaletteVisible = document.getElementById('symbolPalette').style.display !== 'none';
            const settingsVisible = document.getElementById('settingsOverlay').style.display !== 'none';
            hideCommandPalette();
            hideFilePalette();
            hideSymbolPalette();
            if (settingsVisible) toggleSettings();
            if (paletteVisible || filePaletteVisible || symbolPaletteVisible || settingsVisible) {
                setTimeout(() => codeEditor && codeEditor.focus(), 0);
            }
        }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') { 
            e.preventDefault(); 
            openLocalSearch(true); 
        }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && !e.shiftKey) { 
            e.preventDefault(); 
            openLocalSearch(false); 
        }
        else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); showCommandPalette(); }
        else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); showFilePalette(); }
        else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') { e.preventDefault(); showSymbolPalette(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); newTab(); }
        else if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveCurrentFile(); }
        else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveAllFiles(); }
        else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') { e.preventDefault(); createNewFile(currentWorkingDirectory || 'root'); }
        else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); createNewFolder(currentWorkingDirectory || 'root'); }
        else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); document.getElementById('searchInput').focus(); document.getElementById('searchInput').select(); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'w') {
            e.preventDefault();
            if (currentFilePath) { closeTab(currentFilePath); }
            else {
                const content = codeEditor.getValue();
                if (content.length > 0) { 
                    const confirmed = await showConfirmDialog("Close Buffer", "Close buffer? Changes will be lost.", "Discard", "Cancel", true);
                    if (!confirmed) return; 
                }
                if (openTabs.size === 0) { codeEditor.setValue(''); codeEditor.clearHistory(); updateStatusBar(); }
            }
        }

    });

    const searchInput = document.getElementById('searchInput');
    searchInput.addEventListener('input', debouncedPerformSearch);
    searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') performSearch(); });
    
    document.getElementById('replaceInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') performGlobalReplace(); });

    // Prevent default drag and drop behavior for the entire document to avoid accidental navigation away from app
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());

    const dropZone = document.getElementById('fileTree');
    dropZone.addEventListener('dragover', (e) => { 
        if (dragSrcPath) return; 
        e.preventDefault(); 
        dropZone.style.outline = '2px solid var(--accent-color)'; 
        dropZone.style.outlineOffset = '-2px'; 
    });
    dropZone.addEventListener('dragleave', () => { 
        if (dragSrcPath) return; 
        dropZone.style.outline = ''; 
        dropZone.style.outlineOffset = ''; 
    });
    
    dropZone.addEventListener('drop', async (e) => {
        if (dragSrcPath) return;
        
        e.preventDefault(); 
        dropZone.style.outline = ''; 
        dropZone.style.outlineOffset = '';

        const items = e.dataTransfer.items;
        const files = e.dataTransfer.files;

        if ((!items || items.length === 0) && (!files || files.length === 0)) return;

        showNotification('Processing dropped items...', false, 3000);
        let filesProcessed = 0; 
        
        const targetDropElement = e.target.closest('li[data-path]');
        let baseDropPath = currentWorkingDirectory || 'root';
        if (targetDropElement) {
            const potentialDropPath = targetDropElement.dataset.path;
            if (fileStructure[potentialDropPath]) {
                baseDropPath = fileStructure[potentialDropPath].type === 'folder' 
                    ? potentialDropPath 
                    : (potentialDropPath.substring(0, potentialDropPath.lastIndexOf('/')) || 'root');
            }
        }

        // --- MODERN API: File System Access API ---
        const processHandle = async (handle, currentParentPath) => {
            if (handle.kind === 'file') {
                const file = await handle.getFile();
                if (file.size > MAX_FILE_SIZE_BYTES) {
                    createFile(`${currentParentPath}/${file.name}`, `[File too large: ${file.name}]`, false);
                    filesProcessed++; return;
                }
                await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const fullPath = `${currentParentPath}/${file.name}`;
                        if (!fileStructure[fullPath] || fileStructure[fullPath].isUntitled) {
                            createFile(fullPath, event.target.result, false);
                        }
                        filesProcessed++; resolve();
                    };
                    reader.onerror = () => { filesProcessed++; resolve(); };
                    const readMode = getFileReadMode(file.name);
                    if (readMode === 'dataurl') reader.readAsDataURL(file);
                    else if (readMode === 'text') reader.readAsText(file);
                    else { createFile(`${currentParentPath}/${file.name}`, `[Binary file: ${file.name}]`, false); filesProcessed++; resolve(); }
                });
            } else if (handle.kind === 'directory') {
                if (SKIP_DIRS.has(handle.name)) return;
                const newFolderPath = `${currentParentPath}/${handle.name}`;
                if (!fileStructure[newFolderPath]) createFolder(newFolderPath, true);
                else fileStructure[newFolderPath].expanded = true;

                for await (const entry of handle.values()) {
                    await processHandle(entry, newFolderPath);
                }
            }
        };

        // --- LEGACY API: File and Directory Entries API ---
        const processEntry = (entry, currentPathInZip) => {
            return new Promise((resolveEntry, rejectEntry) => {
                if (entry.isFile) {
                    entry.file((file) => {
                        if (file.size > MAX_FILE_SIZE_BYTES) {
                            createFile(`${baseDropPath}/${currentPathInZip}`, `[File too large: ${file.name}]`, false); 
                            filesProcessed++; resolveEntry(); return;
                        }
                        const reader = new FileReader();
                        reader.onload = (event) => {
                            const fullPath = `${baseDropPath}/${currentPathInZip}`;
                            if (!fileStructure[fullPath] || fileStructure[fullPath].isUntitled) {
                                createFile(fullPath, event.target.result, false);
                            }
                            filesProcessed++; resolveEntry();
                        };
                        reader.onerror = () => { filesProcessed++; resolveEntry(); };
                        const readMode = getFileReadMode(file.name);
                        if (readMode === 'dataurl') reader.readAsDataURL(file);
                        else if (readMode === 'text') reader.readAsText(file);
                        else { createFile(`${baseDropPath}/${currentPathInZip}`, `[Binary file: ${file.name}]`, false); filesProcessed++; resolveEntry(); }
                    }, (err) => { 
                        rejectEntry(err); // Trigger catch block for Chrome EncodingError
                    });
                } else if (entry.isDirectory) {
                    if (SKIP_DIRS.has(entry.name)) { filesProcessed++; resolveEntry(); return; }
                    const dirPathInStructure = `${baseDropPath}/${currentPathInZip}`;
                    if (!fileStructure[dirPathInStructure]) createFolder(dirPathInStructure, true);
                    else fileStructure[dirPathInStructure].expanded = true;
                    
                    const dirReader = entry.createReader(); 
                    const allEntries = [];
                    const readEntriesRecursive = () => new Promise((res, rej) => {
                        dirReader.readEntries(chunks => {
                            if (chunks.length) {
                                allEntries.push(...chunks);
                                readEntriesRecursive().then(res).catch(rej);
                            } else {
                                res();
                            }
                        }, (err) => rej(err)); // Catch Chrome EncodingError here
                    });
                    
                    readEntriesRecursive().then(async () => {
                        for (const subEntry of allEntries) {
                            try {
                                await processEntry(subEntry, `${currentPathInZip}/${subEntry.name}`);
                            } catch (err) {
                                rejectEntry(err); return;
                            }
                        }
                        filesProcessed++; resolveEntry();
                    }).catch(err => rejectEntry(err));
                } else { 
                    filesProcessed++; resolveEntry(); 
                }
            });
        };

        // --- DIRECT FILE API: Fallback for basic files ---
        const processFileDirect = (file, pathPrefix) => {
            return new Promise((resolve) => {
                if (!file) { resolve(); return; }
                if (file.size > MAX_FILE_SIZE_BYTES) {
                    createFile(`${pathPrefix}/${file.name}`, `[File too large: ${file.name}]`, false);
                    filesProcessed++; resolve(); return;
                }
                const reader = new FileReader();
                reader.onload = (event) => {
                    const fullPath = `${pathPrefix}/${file.name}`;
                    if (!fileStructure[fullPath] || fileStructure[fullPath].isUntitled) {
                        createFile(fullPath, event.target.result, false);
                    }
                    filesProcessed++; resolve();
                };
                reader.onerror = () => { filesProcessed++; resolve(); };
                const readMode = getFileReadMode(file.name);
                if (readMode === 'dataurl') reader.readAsDataURL(file);
                else if (readMode === 'text') reader.readAsText(file);
                else { createFile(`${pathPrefix}/${file.name}`, `[Binary file: ${file.name}]`, false); filesProcessed++; resolve(); }
            });
        };

        // Snapshot EVERYTHING from the DataTransfer synchronously, before any await.
        // Browsers clear DataTransferItemList/FileList once the drop handler yields, so any
        // item, entry, or File not captured here is lost — that is what made multi-file drops
        // import only one file (and made the legacy fallback see an empty list).
        const dropSnapshots = [];
        if (items && items.length > 0) {
            const canUseHandles = 'getAsFileSystemHandle' in DataTransferItem.prototype;
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                if (item.kind !== 'file') continue;
                let handlePromise = null;
                if (canUseHandles) {
                    try {
                        handlePromise = item.getAsFileSystemHandle().catch(err => {
                            console.warn('FileSystemHandle failed for one item; falling back for that item:', err);
                            return null;
                        });
                    } catch (err) { handlePromise = null; }
                }
                let entry = null;
                try { entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null; } catch (err) { entry = null; }
                let file = null;
                try { file = item.getAsFile(); } catch (err) { file = null; }
                dropSnapshots.push({ handlePromise, entry, file });
            }
        }
        if (dropSnapshots.length === 0 && files && files.length > 0) {
            for (let i = 0; i < files.length; i++) dropSnapshots.push({ handlePromise: null, entry: null, file: files[i] });
        }

        // Process one dropped item: File System Access handle first, then legacy entry
        // (needed for folders), then the plain File. Each item falls back on its own, so one
        // failure never drops the rest.
        const processSnapshot = async (snap) => {
            const handle = snap.handlePromise ? await snap.handlePromise : null;
            if (handle) {
                try { await processHandle(handle, baseDropPath); return; }
                catch (err) { console.warn('Handle processing failed; trying legacy path for this item:', err); }
            }
            if (snap.entry && snap.entry.isDirectory) {
                await processEntry(snap.entry, snap.entry.name);
                return;
            }
            // Top-level files bypass entry.file() to prevent EncodingError on basic file drops.
            if (snap.file) await processFileDirect(snap.file, baseDropPath);
        };

        try {
            const results = await Promise.allSettled(dropSnapshots.map(processSnapshot));
            const failures = results.filter(r => r.status === 'rejected');
            if (failures.length > 0) {
                failures.forEach(f => console.error('Dropped item failed:', f.reason));
                const encodingFailure = failures.some(f => f.reason && (f.reason.name === 'EncodingError' || (f.reason.message && f.reason.message.includes('URI'))));
                if (encodingFailure) {
                    showNotification("Browser security restricted folder drop on file://. Please use the 'Open Directory' button instead.", true, 6000);
                } else if (filesProcessed === 0) {
                    showNotification("Error processing dropped items.", true);
                }
            }

            renderFileTree(); 
            updateStatusBar(); 
            if (settings.autoSaveSession) saveSession();
            
            if (filesProcessed > 0) {
                showNotification(`Done — ${filesProcessed} item(s) dropped.`, false, 4000);
            }

        } catch (err) {
            console.error("Drop processing failed:", err);
            if (err.name === 'EncodingError' || (err.message && err.message.includes('URI'))) {
                showNotification("Browser security restricted folder drop on file://. Please use the 'Open Directory' button instead.", true, 6000);
                renderFileTree(); // Render whatever managed to load
            } else {
                showNotification("Error processing dropped items.", true);
            }
        }
    });
    
    initCommandPalette();
    initFilePalette();
    initSymbolPalette();

    document.addEventListener('click', (e) => {
        if (!e.target.closest('.toolbar-overflow-wrap')) closeToolbarMenu();
    });
});

// ==========================================
// --- File Search Palette               ---
// ==========================================

let filePaletteSelectedIndex = 0;
let filePaletteResults = [];

function getAllFiles() {
    const files = [];
    function traverse(path) {
        const entry = fileStructure[path];
        if (!entry) return;
        if (entry.type === 'file' && !entry.isUntitled) {
            const name = path.split('/').pop();
            const displayPath = path.replace(/^root\//, '');
            files.push({ path, name, displayPath });
        } else if (entry.type === 'folder') {
            (entry.children || []).forEach(child => traverse(path + '/' + child));
        }
    }
    traverse('root');
    return files;
}

function scoreFileMatch(file, query) {
    const q = query.toLowerCase();
    const name = file.name.toLowerCase();
    const displayPath = file.displayPath.toLowerCase();
    if (name === q) return 100;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 60;
    if (displayPath.includes(q)) return 40;
    return 0;
}

function highlightMatch(text, query) {
    if (!query) return escapeHtml(text);
    const idx = text.toLowerCase().indexOf(query.toLowerCase());
    if (idx === -1) return escapeHtml(text);
    return escapeHtml(text.slice(0, idx))
        + '<span class="file-palette-match">' + escapeHtml(text.slice(idx, idx + query.length)) + '</span>'
        + escapeHtml(text.slice(idx + query.length));
}

function renderFilePalette(query) {
    const ul = document.getElementById('fileList');
    const allFiles = getAllFiles();
    const q = query.trim();

    if (!q) {
        // Show all files when empty, sorted by recent
        filePaletteResults = allFiles.sort((a, b) => {
            const aRecent = recentFiles.findIndex(r => r.path === a.path);
            const bRecent = recentFiles.findIndex(r => r.path === b.path);
            if (aRecent !== -1 && bRecent !== -1) return aRecent - bRecent;
            if (aRecent !== -1) return -1;
            if (bRecent !== -1) return 1;
            return a.name.localeCompare(b.name);
        });
    } else {
        filePaletteResults = allFiles
            .map(f => ({ ...f, score: scoreFileMatch(f, q) }))
            .filter(f => f.score > 0)
            .sort((a, b) => b.score - a.score);
    }

    filePaletteSelectedIndex = 0;
    ul.innerHTML = '';

    if (filePaletteResults.length === 0) {
        const li = document.createElement('li');
        li.className = 'file-palette-empty';
        li.textContent = 'No files found.';
        ul.appendChild(li);
        return;
    }

    filePaletteResults.forEach((file, idx) => {
        const li = document.createElement('li');
        li.className = 'file-palette-item' + (idx === 0 ? ' selected' : '');
        li.style.animationDelay = `${Math.min(idx * 18, 120)}ms`;
        li.innerHTML = `
            <span class="file-palette-name">${highlightMatch(file.name, q)}</span>
            <span class="file-palette-path">${escapeHtml(file.displayPath)}</span>
        `;
        li.addEventListener('click', () => openFilePaletteResult(file.path));
        ul.appendChild(li);
    });
}

function updateFilePaletteSelection() {
    const items = document.querySelectorAll('#fileList .file-palette-item');
    items.forEach((li, i) => {
        li.classList.toggle('selected', i === filePaletteSelectedIndex);
    });
    const selected = items[filePaletteSelectedIndex];
    if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function openFilePaletteResult(path) {
    hideFilePalette();
    openFile(path);
}

function showFilePalette() {
    const palette = document.getElementById('filePalette');
    palette.style.display = 'flex';
    const input = document.getElementById('filePaletteInput');
    input.value = '';
    renderFilePalette('');
    setTimeout(() => input.focus(), 10);
}

function hideFilePalette() {
    const palette = document.getElementById('filePalette');
    if (palette.style.display === 'none') return;
    palette.style.display = 'none';
    if (codeEditor) setTimeout(() => codeEditor.focus(), 0);
}

function handleFilePaletteOverlayClick(e) {
    if (e.target === document.getElementById('filePalette')) hideFilePalette();
}

function initFilePalette() {
    const input = document.getElementById('filePaletteInput');
    const debouncedRender = debounce((val) => renderFilePalette(val), 80);
    input.addEventListener('input', () => debouncedRender(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            filePaletteSelectedIndex = Math.min(filePaletteSelectedIndex + 1, filePaletteResults.length - 1);
            updateFilePaletteSelection();
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            filePaletteSelectedIndex = Math.max(filePaletteSelectedIndex - 1, 0);
            updateFilePaletteSelection();
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (filePaletteResults[filePaletteSelectedIndex]) {
                openFilePaletteResult(filePaletteResults[filePaletteSelectedIndex].path);
            }
        }
    });
}

const commands = [
    { id: 'new-file', label: 'New File', action: () => createNewFile(currentWorkingDirectory || 'root'), shortcut: 'Ctrl+Shift+N' },
    { id: 'new-folder', label: 'New Folder', action: () => createNewFolder(currentWorkingDirectory || 'root'), shortcut: 'Ctrl+Shift+D' },
    { id: 'new-tab', label: 'New Untitled Tab', action: newTab, shortcut: 'Ctrl+N' },
    { id: 'format-code', label: 'Format Code', action: formatCode, shortcut: 'Ctrl+Shift+F' },
    { id: 'save-file', label: 'Save File', action: saveCurrentFile, shortcut: 'Ctrl+S' },
    { id: 'save-all', label: 'Save All Files', action: saveAllFiles, shortcut: 'Ctrl+Shift+S' },
    { id: 'download-file', label: 'Download Current File', action: downloadCurrentFile },
    { id: 'download-project', label: 'Download Project (ZIP)', action: downloadProject },
    { id: 'close-all', label: 'Close All Tabs', action: closeAllTabs },
    { id: 'toggle-preview', label: 'Toggle Preview', action: togglePreview },
    { id: 'toggle-diff', label: 'Toggle Diff (Unsaved Changes)', action: toggleDiff },
    { id: 'toggle-sidebar', label: 'Toggle Sidebar', action: toggleSidebar },
    { id: 'collapse-all', label: 'Collapse All Folders', action: collapseAll },
    { id: 'expand-all', label: 'Expand All Folders', action: expandAll },
    { id: 'sort-by-ext', label: 'Sort Root by Extension', action: () => sortFolderByExtension('root') },
    { id: 'goto-line', label: 'Go to Line / Column', action: openGoToLine, shortcut: 'Ctrl+G' },
    { id: 'global-search', label: 'Focus Global Search', action: () => { document.getElementById('searchInput').focus(); document.getElementById('searchInput').select(); }, shortcut: 'Ctrl+Shift+G' },
    { id: 'find-replace', label: 'Find/Replace in File', action: () => openLocalSearch(true), shortcut: 'Ctrl+H' },
    { id: 'find-toggle-regex', label: 'Find: Toggle Regular Expression', action: () => { openLocalSearch(false); toggleLocalSearchRegex(); }, shortcut: 'Alt+R' },
    { id: 'find-toggle-case', label: 'Find: Toggle Case Sensitive', action: () => { openLocalSearch(false); toggleLocalSearchCase(); }, shortcut: 'Alt+C' },
    { id: 'toggle-recent', label: 'Toggle Recent Files Panel', action: toggleRecentFiles },
    { id: 'file-search', label: 'Search Files', action: showFilePalette, shortcut: 'Ctrl+P' },
    { id: 'symbol-outline', label: 'Go to Symbol in File', action: showSymbolPalette, shortcut: 'Ctrl+Shift+O' },
    { id: 'settings', label: 'Open Settings', action: toggleSettings }
];

let selectedCommandIndex = 0;
let filteredCommands = [];

function initCommandPalette() {
    const input = document.getElementById('paletteInput');
    input.addEventListener('input', () => renderCommandPalette(input.value));
    input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); selectedCommandIndex = Math.min(selectedCommandIndex + 1, filteredCommands.length - 1); renderCommandList(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); selectedCommandIndex = Math.max(selectedCommandIndex - 1, 0); renderCommandList(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (filteredCommands[selectedCommandIndex]) executeCommand(filteredCommands[selectedCommandIndex]); }
    });
}

function showCommandPalette() {
    const palette = document.getElementById('commandPalette');
    palette.style.display = 'flex';
    document.getElementById('paletteInput').value = '';
    renderCommandPalette('');
    setTimeout(() => document.getElementById('paletteInput').focus(), 10);
}

function hideCommandPalette() {
    const palette = document.getElementById('commandPalette');
    if (palette.style.display === 'none') return;
    palette.style.display = 'none';
    if (codeEditor) setTimeout(() => codeEditor.focus(), 0);
}

function renderCommandPalette(query) {
    const q = query.toLowerCase();
    filteredCommands = commands.filter(c => c.label.toLowerCase().includes(q));
    selectedCommandIndex = 0;
    renderCommandList();
}

function renderCommandList() {
    const ul = document.getElementById('paletteList');
    ul.innerHTML = '';
    filteredCommands.forEach((cmd, idx) => {
        const li = document.createElement('li');
        li.innerHTML = `<span>${cmd.label}</span> <span class="shortcut">${cmd.shortcut || ''}</span>`;
        if (idx === selectedCommandIndex) li.classList.add('selected');
        li.addEventListener('click', () => executeCommand(cmd));
        li.addEventListener('mouseover', () => {
            ul.querySelectorAll('li').forEach((el, i) => el.classList.toggle('selected', i === idx));
            selectedCommandIndex = idx;
        });
        ul.appendChild(li);
    });
}

function executeCommand(cmd) {
    hideCommandPalette();
    setTimeout(cmd.action, 10);
}
