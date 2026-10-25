/**
 * Run one Python code block under a real interpreter and bring back everything it produced.
 *
 * It lives at the plugin root — not inside `matplotlib/` — because two consumers need it: the
 * matplotlib plugin, which only wants the figure, and exec_python, which wants the whole
 * notebook-style result (figures, tabular values, printed text, tracebacks). Same arrangement
 * as `dot-runner.js`, which graphviz and the marp deck pipeline share.
 *
 * Contract with the interpreter is one JSON file, not scraped text: whatever the block printed,
 * whatever figures it left open, the value of its trailing expression, and its traceback. That
 * keeps the "what shape is the result" question on the Python side, where the objects are, and
 * leaves Node with a documented payload instead of guessing from stdout.
 *
 * The source always travels as a real file: `python` reads stdin lazily and a block that never
 * exhausts it hangs forever on Windows (the reason `dot-runner.js` does the same).
 */

const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawn } = require("child_process")

/** Printed output is capped: a runaway `print` loop must not blow up the payload. */
const MAX_TEXT = 20000

/**
 * Everything the block produced, back from Python:
 *   ok        — false when the block raised; `error` then holds the traceback
 *   stdout    — what the block printed (capped at MAX_TEXT)
 *   kind      — "figure" | "table" | "text" | "none": how the value wants to be shown
 *   nfigs / naxes / ncols / nrows — the size of that value, which is what the deck's
 *              "two columns or a page of its own" decision needs
 *   text      — the value's repr (kind "text"), or a note about a truncated table
 *   figures   — PNG file names, relative to the run directory
 * The runner writes this and exits 0 even on error, so a missing file means the interpreter
 * itself never got far enough to write it — the only case that has to fall back to stderr.
 */
const HARNESS = `"""Execute one Typora code block and report everything it produced as JSON.

Written by runner_python.js beside the block source (block.py); sys.argv carries the two knobs the
caller owns: the DPI figures are saved at, and the row cap of tabular renderings.
"""
import ast
import json
import os
import sys
import traceback
import warnings

import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "Microsoft JhengHei", "STSong", "sans-serif"]
plt.rcParams["axes.unicode_minus"] = False
warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "block.py")
DPI = int(sys.argv[1]) if len(sys.argv) > 1 else 150
MAX_ROWS = int(sys.argv[2]) if len(sys.argv) > 2 else 40
MAX_FIGS = int(sys.argv[3]) if len(sys.argv) > 3 else 8
MAX_TEXT = 20000

RESULT = {"ok": True, "stdout": "", "stderr": "", "error": "",
          "kind": "none", "text": "", "ncols": 0, "nrows": 0, "nfigs": 0, "naxes": 0, "figures": []}


def cell(value):
    """One table cell: printable, short, and never the string form of a missing value."""
    if value is None:
        return ""
    try:
        if isinstance(value, float) and value != value:
            return ""
    except Exception:
        pass
    text = str(value)
    return text if len(text) <= 40 else text[:37] + "..."


def frame_spec(obj):
    """A pandas DataFrame: its columns become the header, its index the row labels."""
    columns = getattr(obj, "columns", None)
    if columns is None:
        return None
    total = len(obj.index)
    view = obj.head(MAX_ROWS) if hasattr(obj, "head") else obj.iloc[:MAX_ROWS]
    return {
        "labels": [cell(name) for name in columns],
        "index": [cell(label) for label in view.index],
        "rows": [[cell(value) for value in view.iloc[i]] for i in range(len(view.index))],
        "note": "... 省略 %d 行" % (total - MAX_ROWS) if total > MAX_ROWS else "",
    }


def array_spec(obj):
    """A 2-D numpy array reads as a table too; 1-D stays a repr (it is a vector, not a table)."""
    if not isinstance(obj, np.ndarray) or obj.ndim != 2:
        return None
    view = obj[:MAX_ROWS]
    return {
        "labels": [str(i) for i in range(view.shape[1])],
        "index": [str(i) for i in range(view.shape[0])],
        "rows": [[cell(value) for value in row] for row in view.tolist()],
        "note": "... 省略 %d 行" % (obj.shape[0] - MAX_ROWS) if obj.shape[0] > MAX_ROWS else "",
    }


def series_spec(obj):
    """A pandas Series is a one-column table whose index sits beside it."""
    if not hasattr(obj, "index") or not hasattr(obj, "tolist"):
        return None
    values = obj.tolist()
    return {
        "labels": [cell(getattr(obj, "name", None)) or "value"],
        "index": [cell(label) for label in list(obj.index)[:MAX_ROWS]],
        "rows": [[cell(value)] for value in values[:MAX_ROWS]],
        "note": "... 省略 %d 行" % (len(values) - MAX_ROWS) if len(values) > MAX_ROWS else "",
    }


def table_spec(value):
    return frame_spec(value) or array_spec(value) or series_spec(value)


def render_table(spec, dpi):
    """Draw a table with matplotlib, so every result reaches the UI as one image channel."""
    labels = spec["labels"] or [""]          # an all-empty header makes ax.table() fail
    rows = spec["rows"] or [[""] * len(labels)]
    index = spec["index"] or [""] * len(rows)
    ncols = len(labels) + 1
    fig, ax = plt.subplots(figsize=(min(1.1 * ncols + 0.8, 22), min(0.34 * (len(rows) + 1) + 0.7, 16)))
    ax.axis("off")
    table = ax.table(cellText=rows, colLabels=labels, rowLabels=index, cellLoc="center", loc="center")
    table.auto_set_font_size(False)
    table.set_fontsize(13 if ncols <= 10 else max(6.5, 13 - (ncols - 10) * 0.4))
    table.scale(1, 1.3)
    fig.tight_layout()
    fig.savefig(os.path.join(HERE, "table.png"), dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    return {"ncols": ncols, "nrows": len(rows), "note": spec["note"], "figures": ["table.png"]}


def collect_figures(dpi):
    """Save every figure the block left open. Multiple figures / subplots are reported, because
    that count is exactly what decides whether a result gets half a slide or a slide of its own."""
    nums = plt.get_fignums()
    paths = []
    naxes = 0
    for i, num in enumerate(nums[:MAX_FIGS]):
        fig = plt.figure(num)
        name = "fig-%d.png" % i
        fig.savefig(os.path.join(HERE, name), dpi=dpi, bbox_inches="tight")
        paths.append(name)
        naxes += len(fig.axes)
    plt.close("all")
    return paths, len(nums), naxes, len(nums) > MAX_FIGS


def format_error():
    """The reader's traceback, minus this harness's own frames: one File/source line pair each."""
    lines = traceback.format_exc().splitlines()
    out = []
    i = 0
    while i < len(lines):
        if lines[i].lstrip().startswith("File ") and os.path.basename(__file__) in lines[i]:
            i += 2
            continue
        out.append(lines[i])
        i += 1
    return "\\n".join(out)


def describe(value):
    """How the block's trailing value wants to be shown."""
    if value is None:
        return {"kind": "none", "text": ""}
    spec = table_spec(value)
    if spec is not None:
        return {"kind": "table", **render_table(spec, DPI)}
    text = repr(value)
    return {"kind": "text", "text": text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + "\\n...（已截断）"}


# 注意：stdout 不再重定向进 buffer——用户 print 的内容直接走真实 stdout，
# 让 Node 侧按 chunk 流式捕获（见 runner_python.js 的 spawn 捕获），从而实现真正流式输出。
# 结构化结果仍走 result.json（figures / text / error），与 stdout 分流互不干扰。
value = None
try:
    with open(SRC, encoding="utf-8") as handle:
        source = handle.read()
    # Jupyter's rule: the value of a trailing expression is the result of the block. Everything
    # before it runs as statements, so a bare name on the last line is what gets shown.
    tree = ast.parse(source, filename=SRC)
    # The block sees the harness's own imports (plt, np) exactly as a script sees its module
    # globals — that is what lets a block call plt.plot without importing anything itself.
    namespace = dict(globals())
    namespace["__name__"] = "__main__"
    namespace["__file__"] = SRC
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        head = ast.Module(body=tree.body[:-1], type_ignores=[])
        exec(compile(head, SRC, "exec"), namespace)
        value = eval(compile(ast.Expression(tree.body[-1].value), SRC, "eval"), namespace)
    elif tree.body:
        exec(compile(tree, SRC, "exec"), namespace)
    figures, nfigs, naxes, dropped = collect_figures(DPI)
    if figures:
        RESULT.update(kind="figure", figures=figures, nfigs=nfigs, naxes=naxes)
        if dropped:
            RESULT["text"] = "只保留前 %d 张图" % MAX_FIGS
    else:
        RESULT.update(describe(value))
except BaseException:
    RESULT["ok"] = False
    RESULT["error"] = format_error()
finally:
    # stdout 由 Node 侧从真实管道捕获（已 scrub 临时目录），这里不再回写
    RESULT["stdout"] = ""

with open(os.path.join(HERE, "result.json"), "w", encoding="utf-8") as handle:
    json.dump(RESULT, handle, ensure_ascii=False)
`

/**
 * @param {string} pythonPath absolute path to the python executable
 * @param {string} source the code block's source
 * @param {{ dpi?: number, timeout?: number, maxRows?: number }} [opts]
 * @returns {Promise<object>} the RESULT payload above, with `figures` turned into `images`
 *          (PNG data URLs) and the temp directory already removed
 */
const runPython = async (pythonPath, source, opts = {}) => {
  const dpi = Number(opts.dpi ?? 150)
  const timeout = Number(opts.timeout ?? 30000)
  const maxRows = Number(opts.maxRows ?? 40)
  const onChunk = opts.onChunk
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typora-py-"))
  const runner = path.join(dir, "runner.py")
  fs.writeFileSync(path.join(dir, "block.py"), source, "utf8")
  fs.writeFileSync(runner, HARNESS, "utf8")

  // The temp directory means nothing to the reader, so it is scrubbed out of every message:
  // a traceback should name `block.py`, not a path in %TEMP%.
  const clean = text => String(text ?? "").split(dir + path.sep).join("").split(dir).join("")

  try {
    // spawn + 管道：stdout 实时按 chunk 回调（onChunk），不再等进程结束一次性回收。
    // 结构化结果仍走 result.json（进程正常结束必写，含出错时的 traceback）。
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      // -u：强制无缓冲 stdout/stderr。否则 Python 在管道（非终端）下块缓冲，
      // 用户不手动 flush 时输出会攒到缓冲满或进程结束才一次性涌出，流式名不副实。
      const child = spawn(pythonPath, ["-u", runner, String(dpi), String(maxRows)], { cwd: dir, windowsHide: true })
      // setEncoding 而非 chunk.toString("utf8")：后者会在 chunk 边界切坏多字节字符
      // （教材里有中文数据时必然出现乱码方块），前者内部用 StringDecoder 跨 chunk 拼接。
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      let stdout = ""
      let stderr = ""
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeout)
      child.stdout.on("data", chunk => {
        if (stdout.length < MAX_TEXT) stdout += chunk   // 最终回传的结果仍限额，防失控 print 撑爆载荷
        onChunk?.({ stream: "stdout", text: chunk })      // 实时 chunk 全量外发，由消费端自行决定显示/截断
      })
      child.stderr.on("data", chunk => {
        if (stderr.length < MAX_TEXT) stderr += chunk
        onChunk?.({ stream: "stderr", text: chunk })
      })
      child.on("error", err => { clearTimeout(timer); reject(err) })
      child.on("close", () => {
        clearTimeout(timer)
        if (timedOut && !fs.existsSync(path.join(dir, "result.json"))) {
          reject(new Error(clean(stderr).trim() || "Python 执行超时"))
        } else {
          resolve({ stdout, stderr })
        }
      })
    })

    const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"))
    result.images = (result.figures ?? []).map(
      name => "data:image/png;base64," + fs.readFileSync(path.join(dir, path.basename(name))).toString("base64")
    )
    result.error = clean(result.error)
    result.stdout = clean(stdout)   // 来自实时管道（harness 已不再缓冲），顺带 scrub 临时目录
    if (!result.ok && !result.error) result.error = clean(stderr).trim() || "Python 执行失败"
    return result
  } catch (error) {
    throw error
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  }
}

/**
 * The matplotlib plugin's one need: the figure a block ended on, as a PNG data URL.
 * `at(-1)` keeps the long-standing behaviour (the figure current when the block ends), so a
 * block that builds several figures does not silently change what it shows today.
 *
 * @returns {Promise<string>} "data:image/png;base64,..."
 */
const renderFigureToPng = async (pythonPath, source, { dpi = 150, timeout = 30000 } = {}) => {
  const result = await runPython(pythonPath, source, { dpi, timeout })
  const image = (result.images ?? []).at(-1)
  if (!image) {
    const error = new Error(result.ok ? "该代码块没有产生图形（没有调用 plt 绘图）" : result.error)
    error.pyStderr = result.stdout
    throw error
  }
  return image
}

module.exports = { runPython, renderFigureToPng }
