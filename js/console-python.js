// ==========================================
// --- Console: Python via Pyodide (gate 5) ---
// ==========================================
// Runs the active .py file with Pyodide (CPython compiled to WebAssembly). Nothing here runs or
// downloads anything until the first .py run, so the editor boots with zero Pyodide requests.
//
// Isolation (same model as the JS console in console.js):
//   editor page --postMessage--> hidden <iframe sandbox="allow-scripts" srcdoc> (opaque origin)
//                                  └─ dedicated module Web Worker (data: URL) that hosts Pyodide
// User Python code therefore never shares the editor's origin: no access to its DOM, localStorage,
// IndexedDB/localforage session or cookies, and `from js import fetch` makes credential-less
// requests from an opaque ("null") origin. The worker is kept warm between runs; ■ Stop removes
// the iframe (which terminates the worker, the only way to interrupt a busy Python loop without
// cross-origin isolation / SharedArrayBuffer) and immediately starts a fresh one.
//
// Loading inside the opaque-origin sandbox:
//   * CDN (jsDelivr): served with `Access-Control-Allow-Origin: *`, so the sandboxed worker can
//     import()/fetch it directly even though its origin is "null".
//   * Vendored copy (./vendor/pyodide/): a plain same-origin static server (python http.server,
//     most dev servers) sends no CORS headers, so a fetch/import from the "null" origin is blocked.
//     Instead the *editor page* fetches the five core files same-origin (allowed), and hands them
//     to the sandbox as Blobs over postMessage. The worker imports the two .mjs files from Blob URLs
//     and answers Pyodide's own fetches (wasm, stdlib zip, lock file) for a virtual `.invalid` base
//     URL from those Blobs. This keeps the opaque-origin isolation for both sources instead of
//     falling back to a same-origin worker. (Neither source works from file://: Chrome blocks
//     fetch() of file URLs, so file:// needs the CDN.)

const PYODIDE_VERSION = '314.0.7'; // latest stable at time of pinning (Python 3.14); vendored copy must match
const PYODIDE_SOURCES = [
    { id: 'cdn', label: 'jsDelivr CDN', indexURL: `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/` },
    { id: 'vendored', label: 'vendored copy', indexURL: './vendor/pyodide/', vendored: true },
];
const PYODIDE_CORE_FILES = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const PYODIDE_VENDORED_VIRTUAL_BASE = 'https://codeedit-vendored-pyodide.invalid/';
const PYODIDE_LOAD_TIMEOUT_MS = 90000; // per source

let pyFrame = null;
let pyState = 'off';          // off | loading | ready | failed
let pyToken = 0;              // bumps on every (re)spawn so stale async work is ignored
let pySourceOrder = [];
let pyAttempt = 0;
let pyFailReasons = [];
let pyLoadTimer = null;
let pyPendingRun = null;      // { code, filename } waiting for the runtime
let pyRunActive = false;
let pyEverReady = false;
let pyPreferredSource = 0;    // index into PYODIDE_SOURCES that last loaded OK
let pyVendoredCache = null;   // { name: Blob }, fetched once per page

// ---------- Sandbox document (iframe + worker source) ----------
function _pyBuildSandboxDoc() {
    const workerSrc = `
        const MAX_LINES = 5000, FLUSH_LINES = 200, FLUSH_MS = 50;
        let buf = [], sentLines = 0, truncated = false, lastFlush = Date.now(), flushTimer = null;
        const flush = () => {
            if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
            if (buf.length) { postMessage({ type: 'batch', items: buf }); buf = []; }
            lastFlush = Date.now();
        };
        // Same batching/cap as the JS console: one postMessage per FLUSH_MS or FLUSH_LINES, and
        // after MAX_LINES output lines per run a single "truncated" marker. Python runs
        // synchronously on this thread, so the time check happens inside every write.
        const queue = (msg, bypassCap) => {
            if (!bypassCap) {
                if (truncated) return;
                if (sentLines >= MAX_LINES) { truncated = true; buf.push({ type: 'truncated', limit: MAX_LINES }); flush(); return; }
                sentLines++;
            }
            buf.push(msg);
            if (buf.length >= FLUSH_LINES || Date.now() - lastFlush >= FLUSH_MS) flush();
            else if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS);
        };

        // Vendored source: serve Pyodide's own fetches for the virtual base from Blobs handed in
        // by the editor page (see the header comment in console-python.js for why).
        let vendored = null;
        const realFetch = self.fetch.bind(self);
        const mimeFor = n => n.endsWith('.wasm') ? 'application/wasm' : n.endsWith('.json') ? 'application/json'
            : /\\.m?js$/.test(n) ? 'text/javascript' : 'application/octet-stream';
        self.fetch = function (input, init) {
            const url = (typeof Request !== 'undefined' && input instanceof Request) ? input.url : String(input);
            if (vendored && url.indexOf(vendored.base) === 0) {
                const name = url.slice(vendored.base.length).split(/[?#]/)[0];
                const blob = vendored.files[name];
                return Promise.resolve(blob ? new Response(blob, { status: 200, headers: { 'Content-Type': mimeFor(name) } })
                                            : new Response('', { status: 404, statusText: 'Not vendored' }));
            }
            return realFetch(input, init);
        };
        const blobUrl = (blob, type) => URL.createObjectURL(new Blob([blob], { type: type }));

        // stdout/stderr → console rows, one row per line. Our own line splitting (instead of Pyodide's
        // "batched" mode) lets a trailing partial line (print(..., end='')) be emitted when the run
        // ends instead of leaking into the next run.
        const makeStream = level => {
            const dec = new TextDecoder();
            let partial = '';
            return {
                write: bytes => {
                    const parts = (partial + dec.decode(bytes, { stream: true })).split('\\n');
                    partial = parts.pop();
                    parts.forEach(line => queue({ type: 'console', level: level, text: line }));
                    return bytes.length;
                },
                end: () => {
                    partial += dec.decode();
                    if (partial) queue({ type: 'console', level: level, text: partial });
                    partial = '';
                },
            };
        };
        const streams = { out: makeStream('log'), err: makeStream('error') };

        let pyodide = null, userFile = 'main.py';
        const SETUP = [
            'import builtins',
            'class InputNotSupportedError(RuntimeError):',
            '    pass',
            'def _codeedit_no_input(prompt=""):',
            '    raise InputNotSupportedError("input() not supported: the console has no stdin")',
            'builtins.input = _codeedit_no_input',
            'builtins.InputNotSupportedError = InputNotSupportedError',
        ].join('\\n');

        async function load(src) {
            let mod, createPyodideModule;
            if (src.files) {
                vendored = { base: src.indexURL, files: src.files };
                mod = await import(blobUrl(src.files['pyodide.mjs'], 'text/javascript'));
                createPyodideModule = (await import(blobUrl(src.files['pyodide.asm.mjs'], 'text/javascript'))).default;
            } else {
                mod = await import(src.indexURL + 'pyodide.mjs');
            }
            // Pyodide reports a failed wasm instantiation / stdlib download only via console.warn/error
            // and then never resolves; turn those into a rejection so the next source is tried.
            const origWarn = console.warn, origError = console.error;
            let failMsgs = null, rejectLoad;
            const failed = new Promise((_, rej) => { rejectLoad = rej; });
            const watch = orig => function () {
                const text = Array.prototype.map.call(arguments, a => (a && a.message) || String(a)).join(' ');
                if (failMsgs) failMsgs.push(text);
                else if (/wasm instantiation failed|installing the standard library/i.test(text)) {
                    failMsgs = [text];
                    setTimeout(() => rejectLoad(new Error(failMsgs.join(': '))), 0);
                }
                return orig.apply(console, arguments);
            };
            console.warn = watch(origWarn); console.error = watch(origError);
            try {
                const opts = { indexURL: src.indexURL };
                if (createPyodideModule) opts.createPyodideModule = createPyodideModule;
                pyodide = await Promise.race([mod.loadPyodide(opts), failed]);
            } finally { console.warn = origWarn; console.error = origError; }
            pyodide.setStdout({ write: streams.out.write });
            pyodide.setStderr({ write: streams.err.write });
            pyodide.setStdin({ error: true });
            pyodide.runPython(SETUP, { filename: '<codeedit>' });
        }

        // Keep only the user's frames: drop Pyodide/stdlib internals ("/lib/...", "<exec>", ...)
        // together with their indented source/caret lines.
        function cleanTraceback(raw) {
            const out = []; let skip = false;
            raw.split('\\n').forEach(line => {
                const m = line.match(/^\\s*File "([^"]*)", line \\d+/);
                if (m) { skip = m[1] !== userFile; if (!skip) out.push(line); return; }
                if (skip && /^\\s{4,}\\S/.test(line)) return;
                if (skip && /^\\s+[~^]+\\s*$/.test(line)) return;
                skip = false; out.push(line);
            });
            return out.join('\\n').replace(/\\n+$/, '');
        }
        function reportError(err) {
            const raw = String((err && err.message) || err);
            const isPy = err && err.name === 'PythonError';
            const stack = isPy ? cleanTraceback(raw) : raw;
            const lines = stack.split('\\n').filter(l => l.trim());
            let text = lines.length ? lines[lines.length - 1] : 'Error';
            if (isPy && err.type === 'InputNotSupportedError') text = 'input() not supported';
            let loc = null, m; const re = /File "([^"]*)", line (\\d+)/g;
            while ((m = re.exec(raw))) if (m[1] === userFile) loc = { line: parseInt(m[2], 10), col: 1 };
            queue({ type: 'uncaught', text: text, stack: lines.length > 1 ? stack : '', loc: loc }, true);
        }
        const flushStreams = () => {
            try { pyodide.runPython('import sys\\nsys.stdout.flush()\\nsys.stderr.flush()'); } catch (e) {}
            streams.out.end(); streams.err.end();
        };

        async function run(code, filename) {
            userFile = filename; sentLines = 0; truncated = false;
            const ns = pyodide.toPy({ __name__: '__main__', __file__: filename });
            try {
                // Packages (numpy, ...) only resolve from the CDN; with the vendored core this is a no-op/fails quietly.
                try { await pyodide.loadPackagesFromImports(code, { messageCallback: () => {}, errorCallback: () => {} }); } catch (e) {}
                await pyodide.runPythonAsync(code, { globals: ns, filename: filename });
                flushStreams();
            } catch (err) {
                flushStreams();
                reportError(err);
                try { pyodide.runPython('0'); } catch (e) { flush(); postMessage({ type: 'py-dead', text: String(e && e.message || e) }); }
            } finally {
                try { ns.destroy(); } catch (e) {}
                flush();
                postMessage({ type: 'done' });
            }
        }

        self.onmessage = async e => {
            const d = e.data || {};
            if (d.type === 'init') {
                try { await load(d.source); postMessage({ type: 'py-ready' }); }
                catch (err) { postMessage({ type: 'py-load-failed', reason: String((err && err.message) || err) }); }
            } else if (d.type === 'run') {
                if (!pyodide) { postMessage({ type: 'py-dead', text: 'runtime not loaded' }); return; }
                await run(d.code, d.filename);
            }
        };
        postMessage({ type: 'worker-up' });
    `;
    // Iframe-side: start the module worker (Pyodide does not support classic workers) and relay.
    const iframeScript = `
        (function () {
            var w;
            function up(d) { d.__codeEditPy = true; parent.postMessage(d, '*'); }
            try {
                // data: URL, not Blob: Chrome refuses a *module* worker from a blob:null URL inside an
                // opaque-origin iframe (fails with a bare error event); a data: module worker works in
                // Chrome and Firefox and gets its own opaque origin.
                w = new Worker('data:text/javascript;charset=utf-8,' + encodeURIComponent(${JSON.stringify(workerSrc)}), { type: 'module' });
            } catch (err) { up({ type: 'py-load-failed', reason: 'Could not start the Python worker: ' + err }); return; }
            w.onmessage = function (e) { up(e.data); };
            w.onerror = function (e) { e.preventDefault(); up({ type: 'py-load-failed', reason: e.message || 'Python worker error' }); };
            window.addEventListener('message', function (e) {
                if (e.source !== parent || !e.data) return;
                w.postMessage(e.data);
            });
        })();
    `;
    return '<!doctype html><html><head><meta charset="utf-8"></head><body><script>' +
        iframeScript.replace(/<\/script/gi, '<\\/script') + '<\/script></body></html>';
}

// ---------- Lifecycle ----------
function _pyTeardown() {
    if (pyLoadTimer) { clearTimeout(pyLoadTimer); pyLoadTimer = null; }
    if (pyFrame) { pyFrame.remove(); pyFrame = null; }
    pyRunActive = false;
}

function _pySpawn() {
    _pyTeardown();
    pyToken++;
    pyState = 'loading';
    pyFailReasons = [];
    pySourceOrder = [pyPreferredSource].concat(PYODIDE_SOURCES.map((_, i) => i).filter(i => i !== pyPreferredSource));
    pyAttempt = 0;
    _pyCreateFrame();
}

function _pyCreateFrame() {
    if (pyFrame) { pyFrame.remove(); pyFrame = null; }
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.className = 'console-sandbox-frame';
    frame.dataset.python = '1';
    frame.srcdoc = _pyBuildSandboxDoc();
    frame._pyToken = pyToken;
    document.body.appendChild(frame);
    pyFrame = frame;
}

async function _pyVendoredFiles() {
    if (pyVendoredCache) return pyVendoredCache;
    const base = PYODIDE_SOURCES.find(s => s.vendored).indexURL;
    const entries = await Promise.all(PYODIDE_CORE_FILES.map(async (name) => {
        const res = await fetch(base + name);
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
        return [name, await res.blob()];
    }));
    pyVendoredCache = Object.fromEntries(entries);
    return pyVendoredCache;
}

async function _pyInitCurrentSource() {
    const token = pyToken, frame = pyFrame;
    const src = PYODIDE_SOURCES[pySourceOrder[pyAttempt]];
    let payload = { indexURL: src.indexURL };
    if (src.vendored) {
        try { payload = { indexURL: PYODIDE_VENDORED_VIRTUAL_BASE, files: await _pyVendoredFiles() }; }
        catch (err) { if (token === pyToken) _pySourceFailed(`could not read ${src.indexURL} (${err.message || err})`); return; }
        if (token !== pyToken || frame !== pyFrame) return;
    }
    pyLoadTimer = setTimeout(() => { if (token === pyToken) _pySourceFailed(`timed out after ${PYODIDE_LOAD_TIMEOUT_MS / 1000}s`); }, PYODIDE_LOAD_TIMEOUT_MS);
    frame.contentWindow.postMessage({ type: 'init', source: payload }, '*');
}

function _pySourceFailed(reason) {
    if (pyLoadTimer) { clearTimeout(pyLoadTimer); pyLoadTimer = null; }
    const src = PYODIDE_SOURCES[pySourceOrder[pyAttempt]];
    pyFailReasons.push(`${src.label}: ${String(reason).split('\n')[0].slice(0, 160)}`);
    pyAttempt++;
    if (pyAttempt < pySourceOrder.length) { _pyCreateFrame(); return; } // fresh sandbox for the next source
    _pyTeardown();
    pyState = 'failed';
    if (pyPendingRun) {
        pyPendingRun = null;
        _consoleAddRow('error', 'Python runtime unavailable', pyFailReasons.join('\n'), true);
        if (consoleRunKind === 'py') _consoleSetRunning(false);
        _consoleScheduleRender();
    }
}

function _pySendRun() {
    if (!pyPendingRun || !pyFrame || pyState !== 'ready') return;
    pyRunActive = true;
    pyFrame.contentWindow.postMessage({ type: 'run', code: pyPendingRun.code, filename: pyPendingRun.filename }, '*');
    pyPendingRun = null;
}

window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || !d.__codeEditPy || !pyFrame || e.source !== pyFrame.contentWindow) return;
    switch (d.type) {
        case 'worker-up': _pyInitCurrentSource(); break;
        case 'py-load-failed': if (pyState === 'loading') _pySourceFailed(d.reason); break;
        case 'py-ready':
            if (pyLoadTimer) { clearTimeout(pyLoadTimer); pyLoadTimer = null; }
            pyState = 'ready'; pyEverReady = true; pyPreferredSource = pySourceOrder[pyAttempt];
            _pySendRun();
            break;
        case 'batch':
            if (Array.isArray(d.items)) { d.items.forEach(_consoleHandleItem); _consoleScheduleRender(); }
            break;
        case 'py-dead': // the runtime crashed (e.g. a fatal wasm error): restart quietly for the next run
            pyState = 'off';
            break;
        case 'done':
            pyRunActive = false;
            if (consoleRunKind === 'py') _consoleSetRunning(false);
            if (pyState === 'off') _pySpawn();
            _consoleScheduleRender();
            break;
    }
});

// ---------- Called from console.js ----------
function pyRunInConsole(code, filename) {
    pyPendingRun = { code, filename };
    if (pyState === 'ready') { _pySendRun(); return; }
    if (pyState !== 'loading') {
        if (!pyEverReady || pyState === 'failed' || pyState === 'off') {
            consoleRows.push({ kind: 'note', text: 'Loading Python runtime (~5 MB, first run only)…' });
        }
        _pySpawn();
    }
}

// ■ Stop: Python can't be interrupted in place, so terminate the worker and boot a fresh one now
// (runtime stays warm for the next run).
function pyStopAndRestart() {
    pyPendingRun = null;
    consoleRows.push({ kind: 'note', text: 'Restarting Python…' });
    _pySpawn();
}

function pyRuntimeState() { return { state: pyState, runActive: pyRunActive, source: pyState === 'ready' ? PYODIDE_SOURCES[pyPreferredSource].id : null }; }
