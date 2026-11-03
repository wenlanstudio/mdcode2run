#!/usr/bin/env node
"use strict"
/**
 * mdcode2run CLI——引擎的无头门面，也是"引擎确实不需要编辑器"的日常证明。
 *
 * 用法（行号从 1 开始，与编辑器习惯一致）：
 *   mdcode2run list   <file.md> [--json]
 *   mdcode2run run    <file.md> --at <行号> [--replay] [--timeout <ms>] [--json] [--config <file.json>]
 *   mdcode2run replay <file.md> --at <行号> [--json] [--config <file.json>]
 *
 * --config：JSON 文件，{ python:{…}, java:{…}, … } 直配 + { secrets:{NAME:真值} }
 * 供 preset 的 ${NAME} 占位符取值 + 可选 { techs:{…}, courses:{…} } 外置环境档案
 * （合入内置 schema 与六门课）。不传则全靠默认值 + 环境变量。
 *
 * 流式输出一律走 stderr（保持 stdout 干净，可安全重定向）；--json 模式只在结束时
 * 向 stdout 输出一份契约 JSON（图结果只报数量，不内联 data URL）。
 */

const fs = require("fs")
const path = require("path")
const { createEngine } = require("..")

const USAGE = `用法:
  mdcode2run list   <file.md> [--json]
  mdcode2run run    <file.md> --at <行号> [--replay] [--timeout <ms>] [--json] [--config <file.json>]
  mdcode2run replay <file.md> --at <行号> [--json] [--config <file.json>]

行号从 1 开始；执行流式输出走 stderr，最终报告走 stdout。`

const die = (message, code = 2) => { console.error(`mdcode2run: ${message}`); process.exit(code) }

const parseArgs = argv => {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") args.json = true
    else if (a === "--replay") args.replay = true
    else if (a === "--at") args.at = Number(argv[++i])
    else if (a === "--timeout") args.timeout = Number(argv[++i])
    else if (a === "--config") args.configFile = argv[++i]
    else if (a === "-h" || a === "--help") args.help = true
    else args._.push(a)
  }
  return args
}

const loadConfig = file => {
  if (!file) return {}
  const raw = fs.readFileSync(file, "utf8")
  const parsed = JSON.parse(raw)
  if (typeof parsed !== "object" || parsed === null) die(`--config 须为 JSON 对象：${file}`)
  return parsed
}

/** 1 基行号 → 定位失败时的人话（为什么这个块不能跑）。 */
const explainUnlocatable = (parsed, line0) => {
  const block = parsed.blocks.find(b => line0 >= b.line && line0 < b.end)
  if (!block) return `第 ${line0 + 1} 行不在任何代码块内`
  if (!block.supported) return `语言 \`${block.lang}\` 不在任何语言模块的 LANGS 里（块角色：${block.role}）`
  if (block.problems.length) return `块标注有问题：${block.problems.join("；")}`
  return `块不可执行（角色：${block.role}${block.file ? ` · file=${block.file}` : ""}）`
}

/** rows → 文本表格（前 N 行 + 共 N 行脚注，与 UI 的渲染策略一致）。 */
const renderRows = (rows, maxRows = 20) => {
  const shown = rows.cells.slice(0, maxRows)
  const lines = [rows.columns.join(" | "), rows.columns.map(() => "---").join(" | ")]
  for (const row of shown) lines.push(rows.columns.map((_, i) => (row[i] == null ? "NULL" : String(row[i]))).join(" | "))
  if (rows.cells.length > shown.length) lines.push(`… 共 ${rows.cells.length} 行（已显示前 ${shown.length}）`)
  return lines.join("\n")
}

const sessionLine = s => !s ? "" :
  `〔${s.chapter || "本章"} · ${s.replayed ? "重放" : "会话"} ${s.ran}/${s.total}${s.stale > 0 ? ` · 过期${s.stale}` : ""}〕`

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args._.length) { console.log(USAGE); process.exit(0) }
  const cmd = args._[0]
  const file = args._[1]
  if (!file) die("缺少文件参数\n" + USAGE)
  if (!["list", "run", "replay"].includes(cmd)) die(`未知命令 ${cmd}\n` + USAGE)
  const md = fs.readFileSync(file, "utf8")
  const abs = path.resolve(file)
  const profile = loadConfig(args.configFile)
  const engine = createEngine({
    config: profile,
    techs: profile.techs,
    courses: profile.courses,
    documentPath: abs,
    documentDir: path.dirname(abs),
  })
  // CLI 是一次性进程：干完活必须显式销毁常驻会话——JVM 的 stdio 管道会撑住事件循环，
  // 指望 process.on("exit") 里的兜底 dispose 永远等不到那一天（循环不排空 exit 不触发）。
  // 长驻宿主可以靠空闲回收器收尾，那是宿主形态给的福利，CLI 没有。
  const finish = () => engine.dispose()
  process.on("exit", finish)

  // ── list：块清单（消费者建 UI / 人眼盘点都靠它） ──
  if (cmd === "list") {
    const parsed = engine.parse(md)
    if (args.json) {
      console.log(JSON.stringify({
        blocks: parsed.blocks,
        chapters: parsed.chapters.map(c => ({ title: c.title, line: c.line + 1, blocks: c.fences.length })),
      }, null, 2))
      return
    }
    for (const b of parsed.blocks) {
      const marks = [
        b.supported ? b.family : "×",
        b.role !== "code" ? b.role : "",
        b.job ? "job" : "",
        b.file ? `file=${b.file}` : "",
        ...b.problems,
      ].filter(Boolean).join(" · ")
      console.log(`${String(b.line + 1).padStart(5)}  ${b.lang.padEnd(8)} ${marks}`)
    }
    return
  }

  // ── run / replay ──
  if (args.at == null || !Number.isFinite(args.at)) die("run/replay 需要 --at <行号>（1 基）")
  const line0 = args.at - 1
  const ctx = engine.locate(md, { line: line0 })
  if (!ctx) die(explainUnlocatable(engine.parse(md), line0))

  // 流式输出走 stderr；--json 模式不直播（stdout 只出最终 JSON）
  const onChunk = args.json ? undefined : info => {
    if (info.stream === "stdout") process.stderr.write(info.text)
    else process.stderr.write(`[stderr] ${info.text}`)
  }
  const started = Date.now()
  const result = cmd === "replay" || args.replay
    ? await engine.replay(ctx, { onChunk, timeout: args.timeout })
    : await engine.run(ctx, { onChunk, timeout: args.timeout })

  // 作业模式：启动即返回——日志已流式外发，这里等退出收尾
  if (result.kind === "job" && result.job) {
    console.error(result.text || `作业 #${result.job.id} 已启动`)
    const done = await result.job.done
    const durationMs = Date.now() - started
    if (args.json) {
      console.log(JSON.stringify({ ok: !done.killed && done.code === 0, kind: "job", job: { id: result.job.id, ...done }, durationMs }, null, 2))
    } else {
      console.error(done.killed ? `已终止 · ${(done.durationMs / 1000).toFixed(1)}s`
        : done.code === 0 ? `完成 · ${(done.durationMs / 1000).toFixed(1)}s`
        : `退出码 ${done.code} · ${(done.durationMs / 1000).toFixed(1)}s`)
      if (done.error) console.error(done.error)
    }
    finish()
    process.exitCode = !done.killed && done.code === 0 ? 0 : 1
    return
  }

  if (args.json) {
    finish()
    console.log(JSON.stringify({
      ok: result.ok,
      kind: result.kind,
      stdout: result.stdout,
      text: result.text,
      error: result.error,
      rows: result.rows ?? null,
      imagesCount: (result.images ?? []).length,
      session: result.session ?? null,
      durationMs: Date.now() - started,
    }, null, 2))
  } else {
    const hud = sessionLine(result.session)
    if (hud) console.error(hud)
    if (result.rows?.columns?.length) console.log(renderRows(result.rows))
    const note = [result.stdout && !result.rows ? result.stdout : "", result.text].filter(x => x && x.trim()).map(x => x.trim()).join("\n")
    if (note) console.log(note)
    if (!result.ok) console.error(`失败：${result.error || "执行失败"}`)
    else if (result.session?.stale > 0) {
      console.error(`⚠ 上方有 ${result.session.stale} 个块在上次执行后已改动——结果可能基于过期状态，建议 --replay 连跑到这里`)
    }
  }
  finish()
  process.exitCode = result.ok ? 0 : 1
}

main().catch(error => { console.error(`mdcode2run: ${error?.message ?? error}`); process.exit(1) })
