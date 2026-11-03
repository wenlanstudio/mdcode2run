/**
 * 常驻 Python 会话——「可执行讲义」eval 原型的 Python 实现（DESIGN.md §5）。
 *
 * 与 runner_python.js（一次性）的本质区别：解释器与命名空间跨块存活——同一章里
 * 先加载数据、后续块反复调模型，正是 ML 课的讲法。结果语义与一次性版对齐：
 * Jupyter 式尾表达式、pandas/ndarray 表格渲染成图、 collects 开着的图、traceback 清洗。
 *
 * 流分发的关键差异（相对 java-session）：jshell 的用户代码跑在**远端 JVM**，输出天然
 * 分流；python 的 exec() 就在本进程——用 dup2 把真实 fd1/fd2 重定向到**附加管道**
 * （stdio[3]/stdio[4]），协议独占 dup 出来的原 stdout。dup2 在 OS 层生效，能抓住
 * C 扩展的输出，不怕库提前抓住 sys.stdout 的引用。
 *
 * 图捕获（DESIGN §5 的轻办法）：每次 eval 后检查 plt.get_fignums()，落盘、清空——
 * 不上 IPython。窗口期归属与 java-session 相同：请求串行，哨兵之间的输出属于该请求。
 *
 * 协议（无需握手）：stdin 每行一个请求 {"op":"eval"|"reset","id","token","file"}；
 * 结果写 .md-exec/python/res-<id>.json，哨兵行 `MDXDONE <id> <token>` 走协议流。
 * HARNESS 用 String.raw——里面就是 Python 源码本来的样子（ASCII，GBK 陷阱同前）。
 */

const fs = require("fs")
const path = require("path")
const os = require("os")
const crypto = require("crypto")
const { spawn } = require("child_process")

const MAX_TEXT = 20000

const HARNESS = String.raw`"""Persistent Python session: serve eval/reset requests forever.

fd layout on arrival: 0 = requests (stdin), 1 = protocol (dup'd to PROTO before the
redirect), 3 = user stdout pipe, 4 = user stderr pipe. After dup2, everything the user
code (or its C extensions) writes to fd 1/2 lands on the extra pipes; only the harness
writes to PROTO. Results travel as one JSON file per request, like the one-shot runner.
ASCII only: this file is read with the platform default encoding by some launchers.
"""
import ast
import json
import os
import sys
import traceback
import warnings

AUX = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
DPI = int(sys.argv[2]) if len(sys.argv) > 2 else 150
MAX_ROWS = int(sys.argv[3]) if len(sys.argv) > 3 else 40
MAX_FIGS = int(sys.argv[4]) if len(sys.argv) > 4 else 8
MAX_TEXT = 20000

PROTO = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
os.dup2(3, 1)
os.dup2(4, 2)
os.close(3)
os.close(4)
try:
    sys.stdin.reconfigure(encoding="utf-8")
except Exception:
    pass

try:
    import numpy as np
except Exception:
    np = None
try:
    import matplotlib
    matplotlib.use("Agg", force=True)
    import matplotlib.pyplot as plt
    plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "Microsoft JhengHei", "STSong", "sans-serif"]
    plt.rcParams["axes.unicode_minus"] = False
except Exception:
    plt = None
warnings.filterwarnings("ignore")

SELF = os.path.abspath(__file__)
BLOCK = "<mdx-block>"


def build_namespace():
    ns = {"__name__": "__main__", "__doc__": None}
    for name in ("os", "sys", "json", "np", "plt"):
        if name in globals():
            ns[name] = globals()[name]
    return ns


NS = build_namespace()


def cell(value):
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
    if np is None or not isinstance(obj, np.ndarray) or obj.ndim != 2:
        return None
    view = obj[:MAX_ROWS]
    return {
        "labels": [str(i) for i in range(view.shape[1])],
        "index": [str(i) for i in range(view.shape[0])],
        "rows": [[cell(value) for value in row] for row in view.tolist()],
        "note": "... 省略 %d 行" % (obj.shape[0] - MAX_ROWS) if obj.shape[0] > MAX_ROWS else "",
    }


def series_spec(obj):
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


def render_table(spec, req_id):
    if plt is None:
        return None
    labels = spec["labels"] or [""]
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
    name = "table-%d.png" % req_id
    fig.savefig(os.path.join(AUX, name), dpi=DPI, bbox_inches="tight")
    plt.close(fig)
    return {"ncols": ncols, "nrows": len(rows), "note": spec["note"], "figures": [name]}


def collect_figures(req_id):
    """Save every figure the block left open, then close them - the next block starts clean."""
    if plt is None:
        return [], 0, 0, False
    nums = plt.get_fignums()
    paths = []
    naxes = 0
    for i, num in enumerate(nums[:MAX_FIGS]):
        fig = plt.figure(num)
        name = "fig-%d-%d.png" % (req_id, i)
        fig.savefig(os.path.join(AUX, name), dpi=DPI, bbox_inches="tight")
        paths.append(name)
        naxes += len(fig.axes)
    plt.close("all")
    return paths, len(nums), naxes, len(nums) > MAX_FIGS


def format_error():
    """The user's traceback, minus the harness's own frames. A frame is skipped together
    with its source line only when that next line is actually indented code - frames whose
    source is unavailable print no code line, and skipping blindly would eat the exception."""
    lines = traceback.format_exc().splitlines()
    out = []
    i = 0
    while i < len(lines):
        if lines[i].lstrip().startswith("File ") and SELF in lines[i]:
            i += 1
            if i < len(lines) and lines[i].startswith("    "):
                i += 1
            continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def describe(value, req_id):
    if value is None:
        return {"kind": "none", "text": "", "figures": []}
    spec = table_spec(value)
    if spec is not None:
        rendered = render_table(spec, req_id)
        if rendered is not None:
            return {"kind": "table", "text": "", **rendered}
    text = repr(value)
    return {"kind": "text", "text": text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + "\n...（已截断）", "figures": []}


def do_eval(req_id, source, src_path):
    """Execute one block in the shared namespace. Jupyter's rule for the trailing expression.
    Blocks compile under their real (on-disk) path so tracebacks carry real source lines;
    linecache is cleared per request because ids repeat across session lifetimes."""
    import linecache
    value = None
    try:
        linecache.clearcache()
        tree = ast.parse(source, filename=src_path)
        NS["__file__"] = src_path
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            head = ast.Module(body=tree.body[:-1], type_ignores=[])
            exec(compile(head, src_path, "exec"), NS)
            value = eval(compile(ast.Expression(tree.body[-1].value), src_path, "eval"), NS)
        elif tree.body:
            exec(compile(tree, src_path, "exec"), NS)
        figures, nfigs, naxes, dropped = collect_figures(req_id)
        result = {"ok": True, "error": "", "nfigs": nfigs, "naxes": naxes}
        if figures:
            result.update(kind="figure", figures=figures, text="只保留前 %d 张图" % MAX_FIGS if dropped else "")
        else:
            result.update(describe(value, req_id))
        return result
    except BaseException:
        return {"ok": False, "kind": "none", "text": "", "figures": [], "nfigs": 0, "naxes": 0,
                "error": format_error()}


def field(line, name):
    import re
    m = re.search("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"", line)
    return m.group(1) if m else ""


def write_result(req_id, payload):
    with open(os.path.join(AUX, "res-%d.json" % req_id), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = int(field(line, "id") or "0")
        token = field(line, "token")
        op = field(line, "op")
        payload = {"ok": True, "kind": "none", "text": "", "figures": [], "error": ""}
        if op == "reset":
            NS.clear()
            NS.update(build_namespace())
        elif op == "eval":
            src_path = os.path.join(AUX, "req-%d.py" % req_id)
            with open(src_path, encoding="utf-8") as handle:
                source = handle.read()
            payload = do_eval(req_id, source, src_path)
        write_result(req_id, payload)
        PROTO.write("MDXDONE %s %s\n" % (field(line, "id"), token))
        PROTO.flush()


main()
`

/**
 * 一个常驻 Python 会话。eval/reset 排队串行（命名空间只有一个）；请求级超时；进程死即
 * 会话作废、下次 acquire 重建。协议文件与图落在 <workdir>/.md-exec/python/。
 */
class PythonSession {
  /**
   * @param {{ pythonPath: string, workdir: string, dpi?: number, maxRows?: number, ownsWorkdir?: boolean }} opts
   *   workdir 即章工作目录（用户相对路径的基准、物化材料的家），与 java 会话共享。
   */
  constructor({ pythonPath, workdir, dpi = 150, maxRows = 40, ownsWorkdir = false }) {
    this._pythonPath = pythonPath
    this._workdir = workdir
    this._dpi = dpi
    this._maxRows = maxRows
    this._ownsWorkdir = !!ownsWorkdir
    this._child = null
    this._dead = false
    this._lineBuf = ""
    this._pending = null
    this._nextId = 1
    this._queue = Promise.resolve()
  }

  get alive() {
    return !this._dead && this._child !== null && this._child.exitCode === null
  }

  /**
   * 跑一块代码。契约与一次性版一致（kind: figure|table|text|none、images 为 PNG dataURL、
   * nfigs/naxes 供放映版式决策），外加 stdout/stderr 按请求窗口回收。
   */
  eval(source, opts = {}) {
    return this._enqueue((resolve, reject) => this._request("eval", source, opts, resolve, reject))
  }

  /** 清空命名空间并重新播种 plt/np（比杀进程便宜得多，环境变量与已装包不丢）。 */
  reset(opts = {}) {
    return this._enqueue((resolve, reject) => this._request("reset", "", opts, resolve, reject))
  }

  destroy(reason = "destroy") {
    this._dead = true
    const child = this._child
    this._child = null
    this._failPending(`Python 会话已终止（${reason}）`)
    if (child) {
      if (process.platform === "win32" && child.pid) {
        // 与 job runner 同理：按进程树杀，免得子孙持管道造成假终止
        try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }) } catch { /* gone */ }
      } else {
        try { child.kill() } catch { /* gone */ }
      }
    }
    try {
      if (this._ownsWorkdir) fs.rmSync(this._workdir, { recursive: true, force: true })
      else fs.rmSync(this._auxDir(), { recursive: true, force: true })
    } catch { /* best effort */ }
  }

  // ==================== 内部 ====================

  _auxDir = () => path.join(this._workdir, ".md-exec", "python")

  _enqueue(body) {
    if (this._dead) return Promise.reject(new Error("Python 会话已终止"))
    const run = () => new Promise(body)
    const next = this._queue.then(run, run)
    this._queue = next.then(() => undefined, () => undefined)
    return next
  }

  _ensureChild() {
    if (this._child) return this._child
    const aux = this._auxDir()
    fs.mkdirSync(aux, { recursive: true })
    const harness = path.join(aux, "PySession.py")
    fs.writeFileSync(harness, HARNESS, "utf8")
    // 附加管道：stdio[3]=用户 stdout、stdio[4]=用户 stderr（见头注释的 fd 布局）
    const child = spawn(this._pythonPath, ["-u", harness, aux, String(this._dpi), String(this._maxRows)], {
      cwd: this._workdir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", MPLBACKEND: "Agg" },
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdio[3]?.setEncoding("utf8")
    child.stdio[4]?.setEncoding("utf8")
    child.stdout.on("data", chunk => this._onProto(chunk))
    child.stdio[3]?.on("data", chunk => this._onUser(chunk, "stdout"))
    child.stdio[4]?.on("data", chunk => this._onUser(chunk, "stderr"))
    child.stderr.on("data", chunk => this._onHarnessErr(chunk))
    child.on("error", err => {
      this._child = null
      this._dead = true
      this._failPending(`无法启动 Python（会话）: ${err.message}`)
    })
    child.on("close", () => {
      if (this._child === child) this._child = null
      if (!this._dead) {
        this._dead = true
        this._failPending("Python 会话已终止（解释器退出）")
      }
    })
    this._child = child
    return child
  }

  _request(op, source, opts, resolve, reject) {
    if (this._dead) {
      reject(new Error("Python 会话已终止"))
      return
    }
    const child = this._ensureChild()
    const id = this._nextId++
    const token = crypto.randomBytes(8).toString("hex")
    const file = `req-${id}.py`
    fs.writeFileSync(path.join(this._auxDir(), file), source, "utf8")
    const pending = { id, token, resolve, reject, stdout: "", stderr: "", onChunk: opts.onChunk, timer: null }
    pending.timer = setTimeout(() => {
      if (this._pending === pending) this._pending = null
      this.destroy("timeout")
      reject(new Error("Python 执行超时（会话已终止，下次运行将重建会话）"))
    }, Number(opts.timeout ?? 60000))
    this._pending = pending
    try {
      // id 发字符串：harness 的字段正则只认带引号的值（同 java-session 的教训）
      child.stdin.write(`${JSON.stringify({ op, id: String(id), token, file })}\n`)
    } catch (err) {
      clearTimeout(pending.timer)
      if (this._pending === pending) this._pending = null
      reject(new Error(`会话管道已断开: ${err.message}`))
    }
  }

  /** 协议流按行扫描：哨兵行收请求，其余（不应有）丢弃。 */
  _onProto(chunk) {
    this._lineBuf += chunk
    let idx
    while ((idx = this._lineBuf.indexOf("\n")) >= 0) {
      const line = this._lineBuf.slice(0, idx).replace(/\r$/, "")
      this._lineBuf = this._lineBuf.slice(idx + 1)
      const pending = this._pending
      const m = /^MDXDONE (\d+) ([0-9a-f]{16})$/.exec(line)
      if (m && pending && Number(m[1]) === pending.id && m[2] === pending.token) {
        this._finish(pending)
      }
    }
  }

  /** 用户输出（fd3/4）：立即转发（流式）并记入当前请求的窗口。 */
  _onUser(chunk, stream) {
    const pending = this._pending
    if (pending) {
      const acc = stream === "stdout" ? "stdout" : "stderr"
      if (pending[acc].length < MAX_TEXT) pending[acc] += chunk
      pending.onChunk?.({ stream, text: chunk })
    }
  }

  /** 解释器自己的错误（启动失败、语法级崩溃）：只转发 stderr，不混入用户输出。 */
  _onHarnessErr(chunk) {
    this._pending?.onChunk?.({ stream: "stderr", text: chunk })
  }

  _finish(pending) {
    clearTimeout(pending.timer)
    if (this._pending === pending) this._pending = null
    let parts
    try {
      parts = JSON.parse(fs.readFileSync(path.join(this._auxDir(), `res-${pending.id}.json`), "utf8"))
    } catch (err) {
      pending.reject(new Error(`会话结果读取失败: ${err.message}`))
      return
    }
    const clean = text => String(text ?? "").split(this._workdir + path.sep).join("").split(this._workdir).join("")
    const stdout = cap(clean(pending.stdout))
    const images = (parts.figures ?? []).map(name => {
      const file = path.join(this._auxDir(), path.basename(name))
      const dataUrl = "data:image/png;base64," + fs.readFileSync(file).toString("base64")
      try { fs.unlinkSync(file) } catch { /* keep on failure */ }
      return dataUrl
    })
    let error = cap(clean(parts.error ?? ""))
    const stderr = cap(clean(pending.stderr))
    if (parts.ok && stderr.trim()) error = error ? `${error}\n${stderr}` : stderr   // 成功时 stderr 只作附带信息
    if (!parts.ok && !error && stderr.trim()) error = stderr
    pending.resolve({
      ok: !!parts.ok,
      kind: parts.kind ?? "none",
      images,
      nfigs: parts.nfigs ?? 0,
      naxes: parts.naxes ?? 0,
      ncols: parts.ncols ?? 0,
      nrows: parts.nrows ?? 0,
      stdout,
      text: cap(clean(parts.text ?? "")),
      error,
    })
  }

  _failPending(message) {
    const pending = this._pending
    if (!pending) return
    clearTimeout(pending.timer)
    this._pending = null
    pending.reject(new Error(message))
  }
}

const cap = text => (text.length <= MAX_TEXT ? text : text.slice(0, MAX_TEXT) + "\n...（已截断）")

/**
 * 造一个会话。带 workdir（章工作目录，session-run.js 传入）＝共享目录，销毁只清
 * `.md-exec/python/`；不带＝自建临时目录、销毁时整个删掉（测试与无章概念的场合）。
 */
const createPythonSession = ({ pythonPath, workdir = "", dpi = 150, maxRows = 40, workdirPrefix = "md-exec-python-" }) => {
  if (!pythonPath) throw new Error("没有可用的 Python 解释器")
  if (workdir) return new PythonSession({ pythonPath, workdir, dpi, maxRows, ownsWorkdir: false })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), workdirPrefix))
  return new PythonSession({ pythonPath, workdir: dir, dpi, maxRows, ownsWorkdir: true })
}

module.exports = { PythonSession, createPythonSession, MAX_TEXT }
