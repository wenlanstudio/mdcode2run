"use strict"
/**
 * 测试跑批器：逐个 spawn test/*.test.js（各自独立进程、各自门控跳过）。
 * `node run-all.js` 全量；`node run-all.js --quick` 跳过要真实 JDK / anaconda 的两套
 * （java-session / python-session），其余（含 engine 的真实解释器段，同样门控）照跑。
 */
const { spawnSync } = require("child_process")
const fs = require("fs")
const path = require("path")

const quick = process.argv.includes("--quick")
const SLOW = new Set(["java-session.test.js", "python-session.test.js"])

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith(".test.js"))
  .filter(f => !(quick && SLOW.has(f)))
  .sort()

const failed = []
for (const f of files) {
  console.log(`\n── ${f} ──`)
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: "inherit" })
  if (r.status !== 0) failed.push(f)
}

console.log(`\n═══ ${files.length - failed.length}/${files.length} 套通过${failed.length ? `，失败：${failed.join(", ")}` : ""} ═══`)
process.exit(failed.length ? 1 : 0)
