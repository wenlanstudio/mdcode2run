"use strict"
/**
 * 引擎级测试（index.js 门面）：解析/定位/一次性执行/事件流/会话执行/重放/销毁。
 * 真实解释器用例沿用原项目约定门控：MDX_PYTHON（默认 anaconda）、MDX_JDK_HOME
 * （默认 jdk-17 路径）；解释器不存在时跳过对应段，不算失败。
 * `node engine.test.js`
 */
const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { createEngine } = require("..")

const failures = []
const test = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => console.log(`  ✓ ${name}`))
  .catch(e => { failures.push(name); console.error(`  ✗ ${name}\n    ${e?.message ?? e}`) })

const PYTHON = process.env.MDX_PYTHON || "D:/ProgramData/anaconda3/python.exe"
const JDK = process.env.MDX_JDK_HOME || "D:/Program Files/Java/jdk-17.0.20.1"

// 文档身份用真实存在的目录：本机执行的 cwd / 会话 key 都靠它（tmp 下稳定存在）
const DOC_DIR = os.tmpdir()
const DOC_PATH = path.join(DOC_DIR, "mdcode2run-engine-test.md")

// ── 标本：两章、多语言、带角色标注与 front-matter ──
const DOC = `---
title: 引擎测试
code-exec:
  python:
    PYTHON_PATH: ${PYTHON}
---

# 第一章

\`\`\`bash
echo hello-mdcode2run
\`\`\`

\`\`\`python demo
x = 1  # 示意
\`\`\`

\`\`\`python
x = 40
\`\`\`

# 第二章

\`\`\`python
print(x + 2)
\`\`\`

\`\`\`xml
<not-executable/>
\`\`\`
`

const lineOf = needle => {
  const idx = DOC.split("\n").findIndex(l => l.includes(needle))
  assert.ok(idx >= 0, `fixture 找不到行：${needle}`)
  return idx
}

const main = async () => {
  console.log("== 引擎：解析与定位 ==")
  const engine = createEngine({ documentPath: DOC_PATH, documentDir: DOC_DIR })

  await test("parse：块清单带语言族 / 角色 / 可执行性", () => {
    const parsed = engine.parse(DOC)
    const byLang = Object.fromEntries(parsed.blocks.map(b => [b.lang, b]))
    assert.strictEqual(parsed.blocks.length, 5)
    assert.strictEqual(byLang.bash.family, "shell")
    assert.strictEqual(byLang.bash.runnable, true)
    assert.strictEqual(byLang.python.role, "code")     // 两个 python 块同名，取第一个
    assert.strictEqual(byLang.xml.supported, false)
    assert.strictEqual(byLang.xml.runnable, false)
    // demo 角色的 python 块：语言支持但不可执行
    const demo = parsed.blocks.find(b => b.role === "demo")
    assert.ok(demo && !demo.runnable)
  })

  await test("parse：章与 front-matter（无围栏的隐式首章被过滤）", () => {
    const parsed = engine.parse(DOC)
    assert.deepStrictEqual(parsed.chapters.map(c => c.title), ["第一章", "第二章"])
    assert.strictEqual(parsed.fm.codeExec.python.PYTHON_PATH, PYTHON)
  })

  await test("locate（按行）：会话身份 = 文档路径 + 章行号 + 语言族", () => {
    const ctx = engine.locate(DOC, { line: lineOf("print(x + 2)") })
    assert.ok(ctx, "应定位到块")
    assert.strictEqual(ctx.family, "python")
    assert.strictEqual(ctx.meta.role, "code")
    assert.ok(ctx.session.key.startsWith(DOC_PATH + "#"), ctx.session.key)
    assert.strictEqual(ctx.session.key.endsWith("#python"), true)
    assert.strictEqual(ctx.session.chapter, "第二章")
    assert.strictEqual(ctx.session.position, 0)   // 第二章第一个（也是唯一）python 可跑块
    // 章工作目录 key 不含语言族
    assert.ok(!ctx.session.workdirKey.endsWith("#python"))
  })

  await test("locate：demo 块与不支持语言返回 null", () => {
    assert.strictEqual(engine.locate(DOC, { line: lineOf("x = 1  # 示意") }), null)
    assert.strictEqual(engine.locate(DOC, { line: lineOf("<not-executable/>") }), null)
  })

  console.log("== 引擎：一次性执行与事件 ==")

  await test("run：bash 一次性执行，stdout 流式外发 + started/done 事件", async () => {
    const ctx = engine.locate(DOC, { line: lineOf("echo hello-mdcode2run") })
    const chunks = []
    const events = []
    engine.events.on("started", d => events.push(["started", d.family]))
    engine.events.on("chunk", d => events.push(["chunk", d.stream]))
    engine.events.on("done", d => events.push(["done", d.ok]))
    const result = await engine.run(ctx, { onChunk: c => chunks.push(c) })
    assert.strictEqual(result.ok, true, result.error)
    assert.ok(result.stdout.includes("hello-mdcode2run"), result.stdout)
    assert.ok(chunks.some(c => c.stream === "stdout" && c.text.includes("hello")), "onChunk 应收到流")
    assert.deepStrictEqual(events[0], ["started", "shell"])
    assert.strictEqual(events[events.length - 1][0], "done")
    assert.strictEqual(events[events.length - 1][1], true)
  })

  await test("run：checkRuntime 失败走契约（不抛异常）——文档无前言时配置层说了算", async () => {
    const cold = createEngine({
      config: { python: { PYTHON_PATH: "D:/不存在的/python.exe" } },
      documentPath: path.join(DOC_DIR, "mdcode2run-engine-cold.md"),
    })
    const md = "# 章\n```python\nx = 1\n```"
    const ctx = cold.locate(md, { line: 2 })
    const result = await cold.run(ctx)
    assert.strictEqual(result.ok, false)
    assert.ok(result.error.includes("PYTHON_PATH"), result.error)
  })

  // ── 真实解释器：会话执行 / 重放 / 销毁（解释器缺失时整段跳过） ──
  if (!fs.existsSync(PYTHON)) {
    console.log(`== 跳过会话执行段：解释器不存在 ${PYTHON}（可用 MDX_PYTHON 覆盖）==`)
  } else {
    console.log("== 引擎：章会话（真实 python）==")
    // 配置层给解释器（与 DOC 前言同一台 anaconda）——无前言的 md 也能跑
    const pyEngine = createEngine({ config: { python: { PYTHON_PATH: PYTHON } }, documentPath: DOC_PATH })

    await test("run：同章块共享命名空间，跨章不共享", async () => {
      const ctx1 = pyEngine.locate(DOC, { line: lineOf("x = 40") })
      const r1 = await pyEngine.run(ctx1)
      assert.strictEqual(r1.ok, true, r1.error)
      assert.ok(r1.session, "会话结果应带 session 信息")
      assert.strictEqual(r1.session.chapter, "第一章")
      // 第二章直接跑：x 未定义 → 失败（章 = 会话边界，这正是不重放时的真实语义）
      const ctx2 = pyEngine.locate(DOC, { line: lineOf("print(x + 2)") })
      const r2 = await pyEngine.run(ctx2)
      assert.strictEqual(r2.ok, false, "跨章不共享，print(x+2) 应报 NameError")
      assert.ok(r2.session.ran >= 1)
    })

    await test("replay：从本章第一个可跑块连跑到目标块，只有最后一块进 onChunk", async () => {
      const md2 = "# 章\n```python\nx = 40\n```\n```python\nprint(x + 2)\n```\n```python\nprint(x * 2)\n```"
      const lines = md2.split("\n")
      const ctx = pyEngine.locate(md2, { line: lines.findIndex(l => l.includes("print(x * 2)")) })
      const chunks = []
      const r = await pyEngine.replay(ctx, { onChunk: c => chunks.push(c.text) })
      assert.strictEqual(r.ok, true, r.error)
      assert.strictEqual(r.session.replayed, true)
      assert.strictEqual(r.session.total, 3)
      assert.ok(r.stdout.includes("80"), r.stdout)   // 重放语义：只有最后一块的输出进结果（42 是中间块，不进）
      // 中间块的流不进终端（重放的意义是"恢复状态"）：42 不得出现在 chunk 里
      assert.ok(chunks.some(t => t.includes("80")), "最后一块的输出应流式外发")
      assert.ok(!chunks.some(t => t.includes("42")), "中间块的输出不该流式外发")
    })

    await test("resetSession：销毁后状态归零", async () => {
      const md3 = "# 章\n```python\ny = 7\n```\n```python\nprint(y)\n```"
      const lines = md3.split("\n")
      const ctx = pyEngine.locate(md3, { line: lines.findIndex(l => l === "y = 7") })
      assert.strictEqual((await pyEngine.run(ctx)).ok, true)
      const ctx2 = pyEngine.locate(md3, { line: lines.findIndex(l => l === "print(y)") })
      assert.strictEqual((await pyEngine.run(ctx2)).ok, true)
      pyEngine.resetSession(ctx2)
      const r = await pyEngine.run(ctx2)
      assert.strictEqual(r.ok, false, "销毁会话后 y 应不存在")
    })
  }

  // ── 真实 JDK：一次性 eval（缺失时跳过） ──
  const javaExe = ["bin/java", "bin/java.exe"].map(p => `${JDK}/${p}`).find(p => fs.existsSync(p))
  if (!javaExe) {
    console.log(`== 跳过 java 段：JDK 不存在 ${JDK}（可用 MDX_JDK_HOME 覆盖）==`)
  } else {
    console.log("== 引擎：java 一次性 eval（真实 JDK）==")
    await test("run：jshell 表达式回显值", async () => {
      const javaEngine = createEngine({ config: { java: { JAVA_HOME: JDK } }, documentPath: path.join(DOC_DIR, "mdcode2run-engine-j.md") })
      const md = "# 章\n```jshell\n1 + 1;\n```"
      const ctx = javaEngine.locate(md, { line: 2 })
      assert.ok(ctx && ctx.family === "java")
      const r = await javaEngine.run(ctx, { timeout: 120000 })
      assert.strictEqual(r.ok, true, r.error)
      assert.ok((r.stdout + r.text).includes("2"), `${r.stdout} / ${r.text}`)
    })
  }

  engine.dispose()
  console.log(failures.length ? `\n失败 ${failures.length} 项：\n  - ${failures.join("\n  - ")}` : "\n全部通过")
  process.exit(failures.length ? 1 : 0)
}

main().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
