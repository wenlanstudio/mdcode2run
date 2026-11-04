/**
 * job 原型验收——`node job.test.js`。对**真实 bash** 跑异步长任务：
 * 自然退出、日志流、终止。没有本机 bash 时跳过（同 java-session 的门控策略）。
 */
const assert = require("assert")
const { findLocalShell } = require("../lib/runners/shell")
const { startJob } = require("../lib/runners/job")

let passed = 0
const failures = []
const evaluate = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(`${name}\n    ${e.message}`)
    console.log(`  ✗ ${name}\n    ${e.message}`)
  }
}

const shell = findLocalShell({})
if (!shell) {
  console.log("跳过：本机没有可用的 bash")
  process.exit(0)
}

;(async () => {
  console.log(`bash: ${shell}`)

  await evaluate("自然退出：退出码、耗时、日志流", async () => {
    const logs = []
    const started = Date.now()
    const r = startJob({ script: 'echo job-started; sleep 1; echo job-done;', onLog: c => logs.push(c) })
    assert.equal(r.kind, "job")
    assert.ok(r.job.id >= 1)
    const d = await r.job.done
    assert.equal(d.code, 0, `code=${d.code}`)
    assert.equal(d.killed, false)
    assert.ok(d.durationMs >= 900, `耗时 ${d.durationMs}ms 应 >= 900ms`)
    const text = logs.map(c => c.text).join("")
    assert.ok(text.includes("job-started") && text.includes("job-done"), `日志: ${JSON.stringify(text)}`)
    assert.ok(Date.now() - started >= 900)
  })

  await evaluate("终止：sleep 30 被 stop 掐掉，done 以 killed 兑现", async () => {
    const r = startJob({ script: "echo running; sleep 30;" })
    await new Promise(resolve => setTimeout(resolve, 800))   // 等它真起来
    r.job.stop()
    const d = await r.job.done
    assert.equal(d.killed, true)
    assert.ok(d.durationMs < 10000, `终止耗时 ${d.durationMs}ms 应远小于 30s`)
  })

  await evaluate("非零退出：code 透传", async () => {
    const r = startJob({ script: "echo bad >&2; exit 7;" })
    const d = await r.job.done
    assert.equal(d.killed, false)
    assert.equal(d.code, 7, `code=${d.code}`)
  })

  await evaluate("重复 stop 无害", async () => {
    const r = startJob({ script: "sleep 30;" })
    await new Promise(resolve => setTimeout(resolve, 300))
    r.job.stop()
    r.job.stop()
    const d = await r.job.done
    assert.equal(d.killed, true)
  })

  console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
