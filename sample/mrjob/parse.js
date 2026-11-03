"use strict"
/**
 * mr-job 文档解析——md 源码 → { fm, blocks, problems }（纯函数，可单测）。
 *
 * 「一文档一作业」原型的词汇表分两层：
 *   front-matter `mr-job:` 段——作业骨架：name / types / combine / input / output /
 *     jar / imports / classpath（封闭词汇，未知键记 problems）
 *   fence info-string——`java map` / `java reduce` / `java combine` / `java partition`
 *     / `java driver` 片段块（方法体，材料不执行）、`file=<相对路径>` 数据块、
 *     `bash job` 提交块、demo 示意块、setup 引导块
 * 无歧义原则：未知标注、角色冲突一律记 problems，不静默忽略——拼错的标注不该
 * 被当成普通代码块跑掉。
 */

const STAGES = ["map", "combine", "partition", "reduce", "driver"]
const KNOWN_FM = new Set(["name", "types", "combine", "input", "output", "jar", "imports", "classpath"])
const KNOWN_TYPES = new Set(["in", "map-out", "out"])

const unquote = s => String(s ?? "").trim().replace(/^"([^"]*)"$/, "$1").replace(/^'([^']*)'$/, "$1")

// file= 必须是作业工作目录内的相对路径：禁空、禁绝对、禁 .. 逃逸
const badRelPath = p => !p || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..")

/**
 * 扫描全部围栏代码块。与主引擎 parseFences 的差异只有一点：保留完整 info 串——
 * 片段阶段（`java map`）写在 info 的第二个词里，通用版不保留它。
 * @returns {{info: string, code: string, line: number, end: number}[]}
 */
const parseFences = md => {
  const lines = String(md ?? "").split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const open = /^(\s{0,3})(`{3,}|~{3,})[ \t]*(.*)/.exec(lines[i])
    if (!open) { i += 1; continue }
    const openLine = i
    const indent = open[1]
    const fence = open[2]
    const closeRe = new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}[ \\t]*$`)
    const body = []
    i += 1
    for (; i < lines.length; i++) {
      if (closeRe.test(lines[i])) { i += 1; break }
      body.push(indent && lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i])
    }
    out.push({ info: open[3].trim(), code: body.join("\n"), line: openLine, end: i })
  }
  return out
}

/**
 * front-matter 里的 `mr-job:` 段：缩进映射子集，支持一层子映射（types:）与
 * 一层 `- 列表`（imports:）。其余 front-matter（title / theme / tags…）一概不看。
 * @returns {{fm: object, problems: string[]}}
 */
const parseMrJob = md => {
  const lines = String(md ?? "").split(/\r?\n/)
  const empty = { fm: {}, problems: [] }
  if ((lines[0] ?? "").trim() !== "---") return empty
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) { end = i; break }
  }
  if (end < 0) return empty
  let start = -1
  for (let i = 1; i < end; i++) {
    if (/^mr-job:[ \t]*$/.test(lines[i])) { start = i; break }
  }
  if (start < 0) return empty
  const fm = {}
  const problems = []
  const stack = [{ indent: -1, obj: fm }]
  let pending = null                                   // 空值键：可能是子映射，也可能是列表头
  for (let i = start + 1; i < end; i++) {
    const text = lines[i]
    if (!text.trim()) continue
    const kv = /^([ \t]*)([A-Za-z][\w-]*):(?:[ \t]*(.*))?$/.exec(text)
    if (kv) {
      const indent = kv[1].replace(/\t/g, "  ").length
      if (indent === 0) break                          // 离开了 mr-job 段
      const key = kv[2]
      const raw = (kv[3] ?? "").trim()
      while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
      const parent = stack[stack.length - 1].obj
      if (stack.length === 1 && !KNOWN_FM.has(key)) problems.push(`未知 mr-job 键 “${key}”（可用：${[...KNOWN_FM].join(" / ")}）`)
      if (pending && pending.obj === parent && indent > pending.indent) {
        if (Object.keys(pending.obj).length) problems.push(`mr-job 键 “${pending.key}” 同时有子键和列表，只支持其一`)
      }
      if (raw === "") {
        parent[key] = {}
        stack.push({ indent, obj: parent[key] })
        pending = { parent, key, indent, obj: parent[key] }
      } else {
        parent[key] = unquote(raw)
        pending = null
      }
      continue
    }
    const item = /^([ \t]*)-[ \t]*(.*)$/.exec(text)
    if (item) {
      if (!pending) { problems.push(`mr-job 第 ${i + 1} 行：列表缺少归属键：${text.trim()}`); continue }
      if (!Array.isArray(pending.parent[pending.key])) pending.parent[pending.key] = []
      pending.parent[pending.key].push(unquote(item[2]))
      continue
    }
    problems.push(`mr-job 第 ${i + 1} 行无法解析：${text.trim()}`)
  }
  for (const key of Object.keys(fm.types ?? {})) {
    if (!KNOWN_TYPES.has(key)) problems.push(`未知 mr-job.types 键 “${key}”（可用：${[...KNOWN_TYPES].join(" / ")}）`)
  }
  return { fm, problems }
}

/**
 * 整篇解析：front-matter 骨架 + 块清单。
 * @returns {{fm: object, blocks: object[], problems: string[]}}
 *   blocks[i]: { lang, role, stage?, file?, code, line, end, problems }
 *   role ∈ stage | file | job | demo | setup | code
 */
const parseDoc = md => {
  const { fm, problems } = parseMrJob(md)
  const blocks = []
  for (const f of parseFences(md)) {
    const tokens = f.info.split(/[ \t]+/).filter(Boolean)
    // 首个 token 含 = （如 file=data/x.txt）是标注不是语言——file= 块没有语言标注
    let lang = ""
    if (tokens.length && !/^[A-Za-z][\w-]*=/.test(tokens[0])) lang = tokens.shift().toLowerCase()
    const b = { lang, role: "code", code: f.code, line: f.line, end: f.end, problems: [] }
    const conflict = what => b.problems.push(`角色冲突：${b.role} + ${what}`)
    for (const t of tokens) {
      const eq = /^([A-Za-z][\w-]*)=(.*)$/.exec(t)
      if (eq) {
        const key = eq[1].toLowerCase()
        if (key === "file") {
          if (b.role !== "code") conflict("file=")
          else {
            b.role = "file"
            b.file = eq[2]
            if (badRelPath(eq[2])) b.problems.push(`file= 须为作业工作目录内的相对路径：${eq[2] || "(空)"}`)
          }
        } else b.problems.push(`未知标注 ${key}=`)
        continue
      }
      const word = t.toLowerCase()
      if (STAGES.includes(word)) {
        if (b.role !== "code") conflict(word)
        else { b.role = "stage"; b.stage = word }
      } else if (["job", "demo", "setup"].includes(word)) {
        if (b.role !== "code") conflict(word)
        else b.role = word
      } else b.problems.push(`未知标注 “${t}”（片段阶段：${STAGES.join(" / ")}）`)
    }
    blocks.push(b)
  }
  return { fm, blocks, problems }
}

module.exports = { STAGES, parseDoc, parseMrJob, parseFences, badRelPath }
