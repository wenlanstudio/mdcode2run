/**
 * python-session.js 验收——对**真实解释器**跑常驻会话。
 * `node python-session.test.js`。解释器取环境变量 MDX_PYTHON（默认 anaconda 路径）；
 * 没有解释器时跳过。matplotlib 缺失时图相关用例自动降级跳过。
 */
const assert = require("assert")
const fs = require("fs")
const { createPythonSession } = require("../runners/python-session")

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

const PYTHON = process.env.MDX_PYTHON || "D:/ProgramData/anaconda3/python.exe"
if (!fs.existsSync(PYTHON)) {
  console.log(`跳过：解释器不存在 ${PYTHON}（可用 MDX_PYTHON 覆盖）`)
  process.exit(0)
}

const TIMEOUT = 90000

;(async () => {
  console.log(`python: ${PYTHON}`)
  const session = createPythonSession({ pythonPath: PYTHON })

  await evaluate("状态跨块存活 + 流式 stdout + 中文", async () => {
    const chunks = []
    await session.eval("import sys", { timeout: TIMEOUT })
    const r = await session.eval('x = 40 + 2\nprint("答案是", x)', { timeout: TIMEOUT, onChunk: c => chunks.push(c) })
    assert.equal(r.ok, true, r.error)
    const r2 = await session.eval("print(x * 2, '中文OK')", { timeout: TIMEOUT, onChunk: c => chunks.push(c) })
    assert.equal(r2.ok, true, r2.error)
    assert.ok(r2.stdout.includes("84") && r2.stdout.includes("中文OK"), r2.stdout)
    assert.ok(chunks.some(c => c.text.includes("答案")), "onChunk 未收到流")
  })

  await evaluate("尾表达式回显（Jupyter 规则）：纯表达式块回显值", async () => {
    const r = await session.eval("6 * 7", { timeout: TIMEOUT })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.kind, "text")
    assert.ok(r.text.includes("42"), r.text)
  })

  await evaluate("多语句块：尾表达式规则让位于整段执行", async () => {
    const r = await session.eval("a = 1\nb = 2\na + b", { timeout: TIMEOUT })
    assert.equal(r.ok, true, r.error)
  })

  await evaluate("图捕获：两张图各成 dataURL，随后清空（不泄漏到下一块）", async () => {
    const r = await session.eval(
      "import matplotlib.pyplot as plt\n" +
      "for i in range(2):\n" +
      "    f = plt.figure()\n" +
      "    plt.plot([0, 1], [0, i + 1])\n" +
      "    f.tight_layout()\n",
      { timeout: TIMEOUT })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.kind, "figure", r.kind)
    assert.equal(r.images.length, 2, `images=${r.images.length}`)
    assert.ok(r.images.every(u => u.startsWith("data:image/png;base64,")))
    assert.equal(r.nfigs, 2)
    const r2 = await session.eval("1 + 1", { timeout: TIMEOUT })
    assert.equal(r2.images.length, 0, "图应已清空")
  })

  await evaluate("pandas 表格：DataFrame 尾表达式渲染成表格图", async () => {
    const probe = await session.eval("import pandas", { timeout: TIMEOUT })
    if (!probe.ok) { console.log("    （无 pandas，跳过）"); return }
    const r = await session.eval("import pandas as pd\npd.DataFrame({'词': ['a', 'b'], '次数': [3, 2]})", { timeout: TIMEOUT })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.kind, "table", r.kind)
    assert.equal(r.images.length, 1)
    assert.equal(r.ncols, 3)   // 两列 + 行标签
  })

  await evaluate("运行时错误：traceback 干净（无 harness 帧/临时目录绝对路径），会话仍可用", async () => {
    const r = await session.eval("1 / 0", { timeout: TIMEOUT })
    assert.equal(r.ok, false)
    assert.ok(r.error.includes("ZeroDivisionError"), r.error)
    assert.ok(r.error.includes("req-"), "traceback 应带真实源码文件行")
    assert.ok(!r.error.includes("PySession"), "traceback 不应暴露 harness 帧")
    assert.ok(!r.error.includes(require("os").tmpdir()), "traceback 不应暴露临时目录绝对路径")
    const r2 = await session.eval("print('still-alive')", { timeout: TIMEOUT })
    assert.equal(r2.ok, true, r2.error)
  })

  await evaluate("reset 清空命名空间并重新播种 plt/np", async () => {
    const r1 = await session.reset({ timeout: TIMEOUT })
    assert.equal(r1.ok, true, r1.error)
    const r2 = await session.eval("x", { timeout: TIMEOUT })
    assert.equal(r2.ok, false)
    assert.ok(r2.error.includes("NameError"), r2.error)
    const r3 = await session.eval("plt is not None and np is not None", { timeout: TIMEOUT })
    assert.equal(r3.ok, true, r3.error)
    assert.ok(r3.text.includes("True"), r3.text)
  })

  session.destroy("test-done")
  assert.ok(!session.alive)

  console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
