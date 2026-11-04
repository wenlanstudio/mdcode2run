"use strict"
/**
 * trace sidecar（DESIGN §7）——执行日志（journal）的持久化镜像。
 *
 * 职责三条，全部纯函数、零 I/O：
 *   serializeTrace  journal 视图 → JSONL 文本（首行头，之后每行一条）
 *   parseTrace      JSONL → 条目数组（校验版本与文档归属，坏行计数不致命）
 *   planTrace       条目 × 当前文档 parse() 结果 → 重演计划（照跑 / stale）
 *
 * 文件读写归宿主/引擎门面——trace.js 不知道文件系统的存在。JSONL 理由：
 * 追加即写一行（每次 ▶ 只 append 不重写）、git diff 友好、坏了只坏一行。
 */

const { fnv1a } = require("./chapter")

/**
 * journal 视图 → JSONL 文本。
 * @param {Array<{ch: number, entries: Array<object>}>} chapters [{ch, entries}]，
 *   条目形如 {n, family, line, hash, ok, ts, src}
 * @param {string} docPath 源文档路径（写进头行，加载时校验归属）
 * @param {?number} chapterLine 只序列化该章；null = 全部章
 */
const serializeTrace = (chapters, docPath, chapterLine = null) => {
  const lines = [JSON.stringify({ v: 1, doc: docPath })]
  const sorted = [...chapters].sort((a, b) => a.ch - b.ch)
  for (const { ch, entries } of sorted) {
    if (chapterLine != null && ch !== chapterLine) continue
    for (const e of entries) {
      lines.push(JSON.stringify({
        ch, n: e.n, family: e.family, line: e.line, hash: e.hash,
        ok: !!e.ok, ts: e.ts ?? 0, src: e.src ?? "run",
      }))
    }
  }
  return lines.join("\n") + "\n"
}

/**
 * JSONL → 条目数组。归属校验失败（doc 不符 / 版本不符）返回 ok:false；
 * 单行损坏只计数（bad）不致命——append-only 文件尾巴被截断是常态，能读多少读多少。
 */
const parseTrace = (jsonl, docPath = "") => {
  const rows = String(jsonl).split("\n").filter(l => l.trim())
  if (!rows.length) return { ok: false, error: "trace 为空", entries: [], bad: 0 }
  let head
  try { head = JSON.parse(rows[0]) } catch {
    return { ok: false, error: "trace 首行不是合法 JSON（应为头）", entries: [], bad: 0 }
  }
  if (head?.v !== 1) return { ok: false, error: `trace 版本不受支持：v${head?.v}`, entries: [], bad: 0 }
  if (docPath && head.doc && head.doc !== docPath) {
    return { ok: false, error: `trace 属于文档「${head.doc}」，与当前文档「${docPath}」不符`, entries: [], bad: 0 }
  }
  const entries = []
  let bad = 0
  for (const l of rows.slice(1)) {
    try {
      const e = JSON.parse(l)
      if (typeof e.n !== "number" || typeof e.line !== "number") throw new Error("shape")
      entries.push({
        ch: e.ch, n: e.n, family: String(e.family ?? ""), line: e.line,
        hash: String(e.hash ?? ""), ok: !!e.ok, ts: e.ts ?? 0,
        src: e.src === "replay" || e.src === "trace" ? e.src : "run",
      })
    } catch { bad += 1 }
  }
  return { ok: true, entries, bad }
}

/**
 * 重演计划：条目 × 当前文档 → 逐条「run / stale」。
 * 判据：按 line 定位块；块存在、可执行、且 fnv1a(当前源码) === 录制 hash 才 run，
 * 否则 stale（讲义在录制后被改过）。纯函数——真跑由门面按计划执行，
 * 宿主可以先拿计划渲染核对清单再放行。
 */
const planTrace = (entries, parsed) => entries.map(e => {
  const idx = parsed.blocks.findIndex(b => b.line === e.line)
  const block = parsed.blocks[idx]
  const fresh = !!block && block.runnable && fnv1a(parsed.fences[idx].code) === e.hash
  return { entry: e, blockIndex: idx, action: fresh ? "run" : "stale" }
})

module.exports = { serializeTrace, parseTrace, planTrace }
