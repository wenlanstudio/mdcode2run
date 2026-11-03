#!/usr/bin/env node
"use strict"
/**
 * mrjob CLI——「一文档一作业」讲义的命令行入口。
 *
 *   node cli.js wordcount.md parse            盘点：骨架 + 块清单 + problems
 *   node cli.js wordcount.md weave            织入：打印全部生成文件（--write 落盘 .mdjob/src）
 *   node cli.js wordcount.md check            物化 + 织入 + javac（不出 jar，不上集群）
 *   node cli.js wordcount.md run              全管线：→ jar → hadoop 提交
 *   通用旗标：--json（结果走契约）/ --timeout 秒
 */
const fs = require("fs")
const path = require("path")
const { parseDoc } = require("./parse")
const { weave } = require("./weave")
const { runJob } = require("./run")

const USAGE = `用法：node cli.js <讲义.md> <parse|weave|check|run> [--json] [--timeout 秒]`

const main = async () => {
  const argv = process.argv.slice(2)
  const doc = argv[0]
  const cmd = argv[1]
  const json = argv.includes("--json")
  const write = argv.includes("--write")
  const ti = argv.indexOf("--timeout")
  const timeoutMs = ti > -1 ? Number(argv[ti + 1]) * 1000 : undefined
  if (!doc || !cmd || !["parse", "weave", "check", "run"].includes(cmd)) {
    console.error(USAGE)
    process.exit(2)
  }
  if (!fs.existsSync(doc)) {
    console.error(`找不到文档：${doc}`)
    process.exit(2)
  }

  const fail = result => {
    if (json) { console.log(JSON.stringify(result, null, 2)); process.exit(1) }
    for (const p of result.problems ?? []) console.error(`  ✗ ${p}`)
    console.error(`✗ ${result.step} 阶段未通过（详见上方问题清单）`)
    process.exit(1)
  }

  if (cmd === "parse") {
    const { fm, blocks, problems } = parseDoc(fs.readFileSync(doc, "utf8"))
    if (json) { console.log(JSON.stringify({ fm, blocks, problems }, null, 2)); return }
    console.log("mr-job 骨架：", JSON.stringify(fm, null, 2))
    for (const b of blocks) {
      const tag = b.role === "stage" ? `片段 ${b.stage}` : b.role
      const extra = b.file ? ` → ${b.file}` : ""
      const bad = b.problems.length ? `  ✗ ${b.problems.join("；")}` : ""
      console.log(`  L${String(b.line + 1).padStart(4)}  ${b.lang.padEnd(8)} ${tag}${extra}${bad}`)
    }
    for (const p of problems) console.error(`  ✗ ${p}`)
    return
  }

  if (cmd === "weave") {
    const { fm, blocks } = parseDoc(fs.readFileSync(doc, "utf8"))
    const w = weave(fm, blocks)
    if (!w.ok) fail({ ok: false, step: "weave", problems: w.problems })
    if (json) { console.log(JSON.stringify({ ok: true, files: Object.fromEntries(Object.entries(w.files).map(([n, f]) => [n, f.code])) }, null, 2)); return }
    console.log(`✓ 织入 ${Object.keys(w.files).length} 个文件（主类 ${w.mainClass}，产物 ${w.jar}）`)
    for (const [name, f] of Object.entries(w.files)) {
      console.log(`\n── ${name} ──`)
      console.log(f.code)
      if (write) {
        const target = path.join(path.dirname(path.resolve(doc)), ".mdjob", "src", name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, f.code + "\n", "utf8")
      }
    }
    if (write) console.log(`\n✓ 已落盘 ${path.join(path.dirname(path.resolve(doc)), ".mdjob", "src")}`)
    return
  }

  const result = await runJob(doc, {
    compileOnly: cmd === "check",
    timeoutMs,
    onChunk: json ? null : c => (c.stream === "stdout" ? process.stdout : process.stderr).write(c.text),
    onStage: json ? null : (name, info) => {
      if (name === "weave") console.log(`✓ 织入 ${info.files.join("、")}`)
      if (name === "clean") console.log(`✓ 已清除上次输出：${info.path}`)
    },
  })
  if (json) { console.log(JSON.stringify({ ...result, stdout: result.stdout?.slice(-4000), stderr: result.stderr?.slice(-4000) }, null, 2)); process.exit(result.ok ? 0 : 1) }
  if (!result.ok) fail(result)
  if (cmd === "check") console.log(`✓ 编译通过：${result.files.join("、")} → ${result.jar}`)
  else console.log(`\n✓ 作业完成，输出在 ${result.output}`)
}

main().catch(e => { console.error(e); process.exit(1) })
