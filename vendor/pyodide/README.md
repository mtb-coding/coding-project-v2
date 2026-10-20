# Vendored Pyodide core (fallback)

Pyodide **314.0.7** (Python 3.14), unmodified files from the `pyodide@314.0.7` npm package, byte-identical to
`https://cdn.jsdelivr.net/pyodide/v314.0.7/full/`. License: MPL-2.0 (https://github.com/pyodide/pyodide).

CodeEdit loads Pyodide from the jsDelivr CDN first and only falls back to this copy when the CDN is unreachable
(see `PYODIDE_SOURCES` in `js/console-python.js`). Only the core files `loadPyodide()` needs are vendored:

- `pyodide.mjs` – loader
- `pyodide.asm.mjs` – Emscripten glue
- `pyodide.asm.wasm` – CPython runtime
- `python_stdlib.zip` – standard library
- `pyodide-lock.json` – package index (the packages themselves are *not* vendored, so `import numpy` etc. only works via the CDN)

To upgrade: change `PYODIDE_VERSION` in `js/console-python.js` and replace all five files with the same version.
