// ==========================================
// --- Console Panel (v0.4.x, gates 3 + 5) ---
// ==========================================
// Runs the active .js file in an isolated sandbox and shows its console output.
// .py files run through Pyodide in their own warm sandboxed worker (see console-python.js).
//
// Sandbox: a hidden <iframe sandbox="allow-scripts"> (opaque origin, so user code can never
// read or write the editor's storage, DOM, or session) that spawns a Web Worker from a Blob.
// User code runs on the worker thread, so an infinite loop never freezes the editor and Stop
// simply tears the iframe (and its worker) down. Everything is built from srcdoc/Blob URLs:
// no network requests, works offline and from file://.
// Console output never renders into #previewFrame.

const CONSOLE_RUNNABLE_EXTENSIONS = new Set(['js', 'py']); // .py → Pyodide (console-python.js)
const CONSOLE_MIN_HEIGHT_PX = 120;
const CONSOLE_MAX_HEIGHT_FRAC = 0.6;

let consoleOpen = false;
let consoleFilter = 'all';           // all | log | warn | error
let consoleRows = [];                // { kind, level, text, stack, loc, count, time }
let consoleRunning = false;
let consoleRunKind = null;           // 'js' | 'py' for the current/last run
let consoleRunFrame = null;
let consoleRunToken = 0;
let consoleRunFileName = '';
let consoleRunFilePath = null;
let consoleTopLevelDone = false;   // worker finished the script's top level
let consolePendingTimers = 0;      // timers still scheduled in the sandbox
const CONSOLE_MAX_ROWS = 2000;

// ---------- Sandbox bootstrap (runs inside the opaque-origin iframe) ----------
function _consoleBuildSandboxDoc() {
    // Worker-side: hook console + errors, serialize args safely, run code via importScripts
    // so stack traces point at "<file>:line:col" through //# sourceURL.
    const workerSrc = `
        const fmt = (v, depth, seen) => {
            depth = depth || 0; seen = seen || new WeakSet();
            const t = typeof v;
            if (v === null) return 'null';
            if (t === 'undefined') return 'undefined';
            if (t === 'string') return depth === 0 ? v : JSON.stringify(v);
            if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v) + (t === 'bigint' ? 'n' : '');
            if (t === 'symbol') return v.toString();
            if (t === 'function') return '[Function' + (v.name ? ': ' + v.name : ' (anonymous)') + ']';
            if (v instanceof Error) return (v.stack && v.stack.indexOf(v.message) !== -1) ? v.stack : (v.name + ': ' + v.message);
            if (seen.has(v)) return '[Circular]';
            if (depth > 3) return Array.isArray(v) ? '[Array]' : '[Object]';
            seen.add(v);
            try {
                if (Array.isArray(v)) {
                    const items = v.slice(0, 100).map(x => fmt(x, depth + 1, seen));
                    if (v.length > 100) items.push('… ' + (v.length - 100) + ' more');
                    return '[' + items.join(', ') + ']';
                }
                if (v instanceof Map) return 'Map(' + v.size + ') {' + Array.from(v).slice(0, 50).map(([k, x]) => fmt(k, depth + 1, seen) + ' => ' + fmt(x, depth + 1, seen)).join(', ') + '}';
                if (v instanceof Set) return 'Set(' + v.size + ') {' + Array.from(v).slice(0, 50).map(x => fmt(x, depth + 1, seen)).join(', ') + '}';
                if (v instanceof Date) return v.toISOString();
                if (v instanceof RegExp) return String(v);
                if (typeof Promise !== 'undefined' && v instanceof Promise) return 'Promise {…}';
                const keys = Object.keys(v);
                const name = v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? v.constructor.name + ' ' : '';
                const body = keys.slice(0, 100).map(k => (/^[A-Za-z_$][\\w$]*$/.test(k) ? k : JSON.stringify(k)) + ': ' + fmt(v[k], depth + 1, seen));
                if (keys.length > 100) body.push('… ' + (keys.length - 100) + ' more');
                return name + '{' + (body.length ? ' ' + body.join(', ') + ' ' : '') + '}';
            } catch (e) { return '[Unserializable]'; }
        };
        // Output is batched: one postMessage per FLUSH_MS or FLUSH_LINES, so a loop that logs
        // as fast as it can never floods the editor's main thread. After MAX_LINES console lines
        // per run, further console output is dropped and a single "truncated" marker is sent.
        const MAX_LINES = 5000, FLUSH_LINES = 200, FLUSH_MS = 50;
        const _setTimeout = self.setTimeout.bind(self), _clearTimeout = self.clearTimeout.bind(self);
        const _setInterval = self.setInterval.bind(self), _clearInterval = self.clearInterval.bind(self);
        let buf = [], sentLines = 0, truncated = false, lastFlush = Date.now(), flushTimer = null;
        const flush = () => {
            if (flushTimer) { _clearTimeout(flushTimer); flushTimer = null; }
            if (buf.length) { postMessage({ type: 'batch', items: buf }); buf = []; }
            lastFlush = Date.now();
        };
        const queue = (msg, bypassCap) => {
            if (!bypassCap) {
                if (truncated) return;
                if (sentLines >= MAX_LINES) { truncated = true; buf.push({ type: 'truncated', limit: MAX_LINES }); flush(); return; }
                sentLines++;
            }
            buf.push(msg);
            if (buf.length >= FLUSH_LINES || Date.now() - lastFlush >= FLUSH_MS) flush();
            else if (!flushTimer) flushTimer = _setTimeout(flush, FLUSH_MS);
        };
        const send = (level, args) => {
            let text;
            try { text = Array.prototype.map.call(args, a => fmt(a)).join(' '); } catch (e) { text = '[Unserializable]'; }
            queue({ type: 'console', level: level, text: text });
        };
        // Track pending timers so the editor can keep showing Stop while a setTimeout/setInterval
        // is still scheduled (promises/fetch aren't tracked; Stop always works regardless).
        const pending = new Set();
        let lastReported = -1;
        const reportActivity = () => {
            const busy = pending.size > 0 ? 1 : 0;
            if (busy !== lastReported) { lastReported = busy; flush(); postMessage({ type: 'activity', pending: pending.size }); }
        };
        self.setTimeout = function (fn, ms) {
            const args = Array.prototype.slice.call(arguments, 2);
            const id = _setTimeout(function () {
                pending.delete(id);
                try { if (typeof fn === 'function') fn.apply(self, args); } finally { reportActivity(); }
            }, ms);
            pending.add(id); reportActivity();
            return id;
        };
        self.clearTimeout = function (id) { _clearTimeout(id); pending.delete(id); reportActivity(); };
        self.setInterval = function (fn, ms) {
            const args = Array.prototype.slice.call(arguments, 2);
            const id = _setInterval(function () { if (typeof fn === 'function') fn.apply(self, args); }, ms);
            pending.add(id); reportActivity();
            return id;
        };
        self.clearInterval = function (id) { _clearInterval(id); pending.delete(id); reportActivity(); };
        const map = { log: 'log', info: 'log', debug: 'log', trace: 'log', warn: 'warn', error: 'error' };
        Object.keys(map).forEach(m => { console[m] = function () { send(map[m], arguments); }; });
        console.assert = function (cond) { if (!cond) send('error', ['Assertion failed:'].concat(Array.prototype.slice.call(arguments, 1))); };
        console.clear = function () {};
        const reportError = (err, fallbackMsg) => {
            const isErr = err && typeof err === 'object' && 'message' in err;
            queue({ type: 'uncaught',
                text: isErr ? ((err.name || 'Error') + ': ' + String(err.message).replace(/^Failed to execute 'importScripts' on 'WorkerGlobalScope': /, '')) : ('Uncaught ' + (fallbackMsg || fmt(err))),
                stack: isErr && err.stack ? String(err.stack) : '' }, true);
        };
        self.addEventListener('error', e => { e.preventDefault(); reportError(e.error, e.message); });
        self.addEventListener('unhandledrejection', e => { e.preventDefault(); reportError(e.reason, 'Unhandled promise rejection: ' + fmt(e.reason)); });
        self.onmessage = e => {
            try { importScripts(e.data); } catch (err) { reportError(err); }
            flush();
            postMessage({ type: 'done' });
            lastReported = -1; reportActivity();
        };
    `;
    // Iframe-side: create the worker, relay messages to the parent, nothing else.
    const iframeScript = `
        (function () {
            var w;
            try {
                w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(workerSrc)}], { type: 'text/javascript' })));
            } catch (err) {
                parent.postMessage({ __codeEditConsole: true, type: 'fatal', text: 'Could not start the sandbox worker: ' + err }, '*');
                return;
            }
            w.onmessage = function (e) { var d = e.data; d.__codeEditConsole = true; parent.postMessage(d, '*'); };
            w.onerror = function (e) { e.preventDefault(); parent.postMessage({ __codeEditConsole: true, type: 'uncaught', text: e.message || 'Script error', stack: '' }, '*'); };
            window.addEventListener('message', function (e) {
                if (e.source !== parent || !e.data || e.data.type !== 'run') return;
                var url = URL.createObjectURL(new Blob([e.data.code], { type: 'text/javascript' }));
                w.postMessage(url);
            });
            parent.postMessage({ __codeEditConsole: true, type: 'ready' }, '*');
        })();
    `;
    return '<!doctype html><html><head><meta charset="utf-8"></head><body><script>' +
        iframeScript.replace(/<\/script/gi, '<\\/script') + '<\/script></body></html>';
}

// ---------- Run / Stop ----------
function _consoleActiveRunnable() {
    if (!currentFilePath || currentFilePath.startsWith('untitled://')) return null;
    const ext = currentFilePath.toLowerCase().split('.').pop();
    return CONSOLE_RUNNABLE_EXTENSIONS.has(ext) ? currentFilePath : null;
}

function _consoleTeardownSandbox() {
    if (consoleRunFrame) { consoleRunFrame.remove(); consoleRunFrame = null; }
}

function runActiveFileInConsole() {
    if (!consoleOpen) openConsolePanel();
    if (consoleRunning) { stopConsoleRun(); }
    const path = _consoleActiveRunnable();
    if (!path) { renderConsole(); showNotification('Console runs .js and .py files.', true); return; }

    _consoleTeardownSandbox();
    const token = ++consoleRunToken;
    consoleRunFilePath = path;
    consoleRunFileName = path.split('/').pop();
    const now = new Date();
    const hhmmss = now.toTimeString().slice(0, 8);
    consoleRows.push({ kind: 'separator', text: `— Run ${consoleRunFileName} · ${hhmmss} —` });

    if (path.toLowerCase().endsWith('.py')) {
        // Python: warm Pyodide worker (loaded lazily on the first .py run). Live buffer, unsaved edits included.
        consoleRunKind = 'py';
        _consoleSetRunning(true);
        pyRunInConsole(codeEditor.getValue(), consoleRunFileName.replace(/[\r\n"]/g, '_'));
        renderConsole();
        return;
    }
    consoleRunKind = 'js';

    // Use the live buffer (includes unsaved edits). sourceURL names the file in stack traces.
    const safeName = consoleRunFileName.replace(/[\r\n\s]/g, '_');
    const code = codeEditor.getValue() + `\n//# sourceURL=${safeName}`;

    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.className = 'console-sandbox-frame';
    frame.dataset.runToken = String(token);
    frame.srcdoc = _consoleBuildSandboxDoc();
    frame._pendingCode = code;
    consoleTopLevelDone = false;
    consolePendingTimers = 0;
    document.body.appendChild(frame);
    consoleRunFrame = frame;
    _consoleSetRunning(true);
    renderConsole();
}

function stopConsoleRun() {
    if (consoleRunKind === 'py') {
        if (!consoleRunning) return;
        _consoleSetRunning(false);
        pyStopAndRestart();   // terminates the Python worker and boots a fresh one ("Restarting Python…")
        renderConsole();
        return;
    }
    if (!consoleRunning && !consoleRunFrame) return;
    _consoleTeardownSandbox();
    consoleRunToken++;
    if (consoleRunning) consoleRows.push({ kind: 'row', level: 'warn', text: 'Run stopped.', count: 1 });
    _consoleSetRunning(false);
    renderConsole();
}

function _consoleSetRunning(running) {
    consoleRunning = running;
    const btn = document.getElementById('consoleRunBtn');
    if (btn) {
        btn.textContent = running ? '■ Stop' : '▶ Run';
        btn.title = running ? 'Stop the running script' : 'Run active file (Ctrl+Enter)';
        btn.classList.toggle('running', running);
    }
}

window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__codeEditConsole || !consoleRunFrame || e.source !== consoleRunFrame.contentWindow) return;
    if (d.type === 'ready') {
        consoleRunFrame.contentWindow.postMessage({ type: 'run', code: consoleRunFrame._pendingCode }, '*');
        consoleRunFrame._pendingCode = null;
        return;
    }
    // Stop stays visible while the top level is executing OR timers are still scheduled.
    if (d.type === 'done') { consoleTopLevelDone = true; _consoleSetRunning(consolePendingTimers > 0); return; }
    if (d.type === 'activity') { consolePendingTimers = d.pending || 0; _consoleSetRunning(!consoleTopLevelDone || consolePendingTimers > 0); return; }
    if (d.type === 'batch' && Array.isArray(d.items)) { d.items.forEach(_consoleHandleItem); _consoleScheduleRender(); return; }
    if (d.type === 'fatal') { _consoleAddRow('error', d.text, '', true); _consoleSetRunning(false); _consoleScheduleRender(); }
});

function _consoleHandleItem(item) {
    if (!item) return;
    if (item.type === 'console') _consoleAddRow(item.level, item.text, '');
    else if (item.type === 'uncaught') _consoleAddRow('error', item.text, item.stack || '', true, item.loc || null);
    else if (item.type === 'truncated') {
        consoleRows.push({ kind: 'row', level: 'warn', text: `…output truncated (${item.limit}-line limit per run). Press ■ Stop to end the script.`, stack: '', count: 1 });
    }
}

// ---------- Rows ----------
function _consoleParseLoc(stack) {
    if (!stack || !consoleRunFileName) return null;
    const esc = consoleRunFileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s/g, '_');
    const m = stack.match(new RegExp(esc + ':(\\d+):(\\d+)'));
    return m ? { line: parseInt(m[1], 10), col: parseInt(m[2], 10) } : null;
}

function _consoleAddRow(level, text, stack, uncaught, knownLoc) {
    // Strip the internal worker frames (blob:/importScripts) so stacks only show user code.
    const cleanStack = (stack || '').split('\n').filter(l => !/blob:|importScripts|self\.onmessage/.test(l)).join('\n');
    // Python tracebacks arrive with their `File "x.py", line N` already parsed into knownLoc.
    const loc = knownLoc || ((level === 'error') ? _consoleParseLoc(stack || text) : null);
    const last = consoleRows[consoleRows.length - 1];
    if (last && last.kind === 'row' && last.level === level && last.text === text && last.stack === cleanStack) {
        last.count++;
    } else {
        consoleRows.push({ kind: 'row', level, text, stack: cleanStack, loc, count: 1, uncaught: !!uncaught });
    }
    if (consoleRows.length > CONSOLE_MAX_ROWS) consoleRows.splice(0, consoleRows.length - CONSOLE_MAX_ROWS);
}

let _consoleRenderQueued = false;
function _consoleScheduleRender() {
    if (_consoleRenderQueued) return;
    _consoleRenderQueued = true;
    requestAnimationFrame(() => { _consoleRenderQueued = false; renderConsole(); });
}

function clearConsole() {
    consoleRows = [];
    renderConsole();
}

function setConsoleFilter(f) {
    consoleFilter = f;
    document.querySelectorAll('#consolePanel .console-filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === f));
    renderConsole();
}

function _consoleCounts() {
    let errors = 0, warns = 0, total = 0;
    for (const r of consoleRows) {
        if (r.kind !== 'row') continue;
        total += r.count;
        if (r.level === 'error') errors += r.count; else if (r.level === 'warn') warns += r.count;
    }
    return { errors, warns, total };
}

function renderConsole() {
    const list = document.getElementById('consoleOutput');
    if (list) {
        const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
        list.innerHTML = '';
        const visible = consoleRows.filter(r => r.kind === 'separator' || r.kind === 'note' || consoleFilter === 'all' || r.level === consoleFilter);
        const hasRows = visible.some(r => r.kind === 'row');
        if (!hasRows && !consoleRunning) {
            const empty = document.createElement('div');
            empty.className = 'console-empty';
            empty.textContent = (!_consoleActiveRunnable() && consoleRows.length === 0)
                ? 'Console runs .js and .py files.'
                : 'Run a JS or Python file to see output here.';
            list.appendChild(empty);
        }
        for (const r of visible) list.appendChild(_consoleRowEl(r));
        if (atBottom) list.scrollTop = list.scrollHeight;
    }
    _consoleUpdateBadge();
}

function _consoleRowEl(r) {
    const el = document.createElement('div');
    if (r.kind === 'separator') { el.className = 'console-separator'; el.textContent = r.text; return el; }
    if (r.kind === 'note') { el.className = 'console-note'; el.textContent = r.text; return el; }  // dim status line (Python loading/restarting)
    el.className = `console-row console-${r.level}`;
    const icon = document.createElement('span');
    icon.className = 'console-icon';
    icon.textContent = r.level === 'error' ? '✕' : r.level === 'warn' ? '⚠' : '';
    el.appendChild(icon);

    const body = document.createElement('div');
    body.className = 'console-body';
    const line = document.createElement('div');
    line.className = 'console-line';
    if (r.stack) {
        const tw = document.createElement('span');
        tw.className = 'console-twisty';
        tw.textContent = '▸';
        tw.title = 'Show stack';
        tw.onclick = () => { el.classList.toggle('expanded'); tw.textContent = el.classList.contains('expanded') ? '▾' : '▸'; };
        line.appendChild(tw);
    }
    const text = document.createElement('span');
    text.className = 'console-text';
    text.textContent = r.text;
    line.appendChild(text);
    if (r.loc) {
        const a = document.createElement('a');
        a.className = 'console-loc';
        a.href = '#';
        a.textContent = `${consoleRunFileName}:${r.loc.line}`;
        a.title = 'Jump to this line';
        a.onclick = (ev) => { ev.preventDefault(); _consoleJumpTo(r.loc); };
        line.appendChild(a);
    }
    if (r.count > 1) {
        const c = document.createElement('span');
        c.className = 'console-count';
        c.textContent = `×${r.count}`;
        line.appendChild(c);
    }
    body.appendChild(line);
    if (r.stack) {
        const st = document.createElement('pre');
        st.className = 'console-stack';
        st.textContent = r.stack;
        body.appendChild(st);
    }
    el.appendChild(body);
    return el;
}

async function _consoleJumpTo(loc) {
    if (consoleRunFilePath && currentFilePath !== consoleRunFilePath && fileStructure[consoleRunFilePath]) {
        await openFile(consoleRunFilePath);
    }
    const pos = { line: Math.max(0, loc.line - 1), ch: Math.max(0, (loc.col || 1) - 1) };
    codeEditor.focus();
    codeEditor.setCursor(pos);
    codeEditor.scrollIntoView(pos, 80);
}

// ---------- Badge ----------
function _consoleUpdateBadge() {
    const badge = document.getElementById('consoleBadge');
    if (!badge) return;
    const { errors, warns, total } = _consoleCounts();
    if (consoleOpen || total === 0) { badge.style.display = 'none'; return; }
    const parts = [];
    if (errors) parts.push(`${errors} error${errors === 1 ? '' : 's'}`);
    if (warns) parts.push(`${warns} warn`);
    if (!parts.length) parts.push(`${total} log${total === 1 ? '' : 's'}`);
    badge.textContent = `● ${parts.join(' · ')}`;
    badge.className = 'console-badge' + (errors ? ' has-errors' : warns ? ' has-warns' : '');
    badge.style.display = '';
}

// ---------- Open / close / resize ----------
function _consoleApplyHeight() {
    const panel = document.getElementById('consolePanel');
    const container = document.getElementById('editorContainer');
    if (!panel || !container) return;
    const pct = Number(settings.consoleHeightPct) || 30;
    const containerH = container.clientHeight || window.innerHeight;
    const px = Math.round(Math.min(containerH * CONSOLE_MAX_HEIGHT_FRAC, Math.max(CONSOLE_MIN_HEIGHT_PX, containerH * pct / 100)));
    panel.style.height = `${px}px`;
}

function openConsolePanel() {
    const panel = document.getElementById('consolePanel');
    if (!panel) return;
    consoleOpen = true;
    panel.style.display = 'flex';
    _consoleApplyHeight();
    document.getElementById('consoleToggleBtn')?.classList.add('active');
    renderConsole();
    if (codeEditor) codeEditor.refresh();
}

function closeConsolePanel() {
    const panel = document.getElementById('consolePanel');
    if (!panel) return;
    consoleOpen = false;
    panel.style.display = 'none';
    document.getElementById('consoleToggleBtn')?.classList.remove('active');
    _consoleUpdateBadge();
    if (codeEditor) { codeEditor.refresh(); codeEditor.focus(); }
}

function toggleConsolePanel() { consoleOpen ? closeConsolePanel() : openConsolePanel(); }

function initConsolePanel() {
    const panel = document.getElementById('consolePanel');
    const handle = document.getElementById('consoleResizeHandle');
    const container = document.getElementById('editorContainer');
    if (!panel || !handle || !container) return;

    let dragging = false;
    handle.addEventListener('mousedown', (e) => { dragging = true; document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; e.preventDefault(); });
    document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const rect = container.getBoundingClientRect();
        const statusH = document.getElementById('statusBar')?.offsetHeight || 0;
        let h = rect.bottom - statusH - e.clientY;
        h = Math.min(rect.height * CONSOLE_MAX_HEIGHT_FRAC, Math.max(CONSOLE_MIN_HEIGHT_PX, h));
        panel.style.height = `${h}px`;
        if (codeEditor) codeEditor.refresh();
    });
    document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = '';
        settings.consoleHeightPct = Math.round((panel.offsetHeight / container.clientHeight) * 1000) / 10;
        saveSettings();
    });
    window.addEventListener('resize', () => { if (consoleOpen) _consoleApplyHeight(); });

    // Ctrl+L clears while focus is inside the panel
    panel.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); e.stopPropagation(); clearConsole(); }
    });

    // Global shortcuts: Ctrl+` toggles, Ctrl+Enter runs
    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        if (e.code === 'Backquote' || e.key === '`') { e.preventDefault(); toggleConsolePanel(); }
        else if (e.key === 'Enter' && !e.shiftKey) {
            // Only claim Ctrl+Enter when it means "run": focus is in the console, or focus is in
            // the editor and the active file is runnable. Palette inputs, other fields and
            // non-runnable files keep their normal Ctrl+Enter behaviour.
            const ae = document.activeElement;
            const inConsole = !!(ae && ae.closest && ae.closest('#consolePanel'));
            const inEditor = !!(ae && ae.closest && ae.closest('#codeEditor'));
            if (inConsole || (inEditor && _consoleActiveRunnable())) { e.preventDefault(); e.stopPropagation(); runActiveFileInConsole(); }
        }
    }, true);

    renderConsole();
}
