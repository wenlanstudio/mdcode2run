/**
 * java-session.js 验收脚本——对**真实 JDK** 跑常驻 JShell 会话。
 *
 * `node java-session.test.js [标本路径]`。JDK 取环境变量 MDX_JDK_HOME（默认
 * D:/Program Files/Java/jdk-17.0.20.1）；没有 JDK 11+ 时跳过并正常退出。
 *
 * 覆盖：状态跨块存活、流式 stdout、编译诊断、运行时异常、reset 清状态、hadopp classpath
 * 下标本 setup→步骤二→步骤三 全链路（wordcount 实训篇复活的定义性证明）。
 */
const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { inspectJavaHome, expandClassPath } = require("../lib/runners/java")
const { createJShellSession } = require("../lib/runners/java-session")
const { parseFences } = require("../lib/fences")

let passed = 0
const failures = []
const t = (name, fn) => {
  try { fn(); passed += 1 } catch (e) { failures.push(`${name}\n    ${e.message}`) }   // 同步断言用
}

const JAVA_HOME = process.env.MDX_JDK_HOME || "D:/Program Files/Java/jdk-17.0.20.1"
const HADOOP_COMMON = "D:/bigdata/hadoop/hadoop-3.1.3/share/hadoop/common"
const SPECIMEN = process.argv[2] || "D:/studybigdata/markdown/hadoop/4-1-1-Hadoop_MapReduce.specimen.md"
const TIMEOUT = 120000

const { javaExe, jshellExe } = inspectJavaHome(JAVA_HOME)
if (!javaExe || !jshellExe) {
  console.log(`跳过：${JAVA_HOME} 下没有可用的 JDK 11+（java/jshell）`)
  process.exit(0)
}

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

;(async () => {
  console.log(`JDK: ${javaExe}`)
  const session = createJShellSession({
    javaExe,
    classPath: expandClassPath(`${HADOOP_COMMON}/*;${HADOOP_COMMON}/lib/*`),
  })

  // ---------- 协议与状态 ----------
  await evaluate("eval 带值：声明变量并回显 ==> 值", async () => {
    const r = await session.eval("int answer = 40 + 2;", { timeout: TIMEOUT })
    assert.equal(r.ok, true, r.error)
    assert.equal(r.kind, "text")
    assert.ok(r.text.includes("answer ==> 42"), r.text)
  })

  await evaluate("状态跨块存活 + 流式 stdout 收到", async () => {
    const chunks = []
    const r = await session.eval('System.out.println("你好 MDX"); answer * 2;', {
      timeout: TIMEOUT,
      onChunk: c => chunks.push(c),
    })
    assert.equal(r.ok, true, r.error)
    assert.ok(r.stdout.includes("你好 MDX"), r.stdout)
    assert.ok(r.text.includes("==> 84"), r.text)
    assert.ok(chunks.some(c => c.stream === "stdout" && c.text.includes("你好")), "onChunk 未收到 stdout 流")
  })

  await evaluate("编译诊断：语法错 → ok=false + 带出诊断", async () => {
    const r = await session.eval("int broken = ;", { timeout: TIMEOUT })
    assert.equal(r.ok, false)
    assert.ok(r.error.includes("broken"), r.error)
  })

  await evaluate("运行时异常：报异常类与消息", async () => {
    const r = await session.eval('throw new RuntimeException("boom-mdx");', { timeout: TIMEOUT })
    assert.equal(r.ok, false)
    assert.ok(r.error.includes("boom-mdx"), r.error)
  })

  await evaluate("多 snippet 块：声明+表达式同块喂入", async () => {
    const r = await session.eval('String s = "abc"; s.length();', { timeout: TIMEOUT })
    assert.equal(r.ok, true, r.error)
    assert.ok(r.text.includes("==> 3"), r.text)
  })

  await evaluate("reset 清状态：变量消失，会话仍可用", async () => {
    const r1 = await session.reset({ timeout: TIMEOUT })
    assert.equal(r1.ok, true, r1.error)
    const r2 = await session.eval("answer;", { timeout: TIMEOUT })
    assert.equal(r2.ok, false)
    assert.ok(r2.error.includes("answer"), r2.error)
    const r3 = await session.eval('System.out.println("alive-after-reset");', { timeout: TIMEOUT })
    assert.equal(r3.ok, true, r3.error)
    assert.ok(r3.stdout.includes("alive-after-reset"), r3.stdout)
  })

  // ---------- 标本全链路：实训篇复活 ----------
  if (fs.existsSync(SPECIMEN) && fs.existsSync(HADOOP_COMMON)) {
    console.log(`标本: ${SPECIMEN}`)
    const md = fs.readFileSync(SPECIMEN, "utf8")
    const fences = parseFences(md)
    const setup = fences.find(f => f.meta.role === "setup")
    const step2 = fences.find(f => f.meta.role === "code" && f.code.includes("wordArray"))
    const step3 = fences.find(f => f.meta.role === "code" && f.code.includes("int count = 0"))
    t("标本三件套齐备（setup / 步骤二 / 步骤三）", () => {
      assert.ok(setup, "setup 块未找到")
      assert.ok(step2, "步骤二块未找到")
      assert.ok(step3, "步骤三块未找到")
    })

    if (setup && step2 && step3) {
      await evaluate("标本 setup：hadoop 类型入 classpath，MockContext 与入参变量就位", async () => {
        const r = await session.eval(setup.code, { timeout: TIMEOUT })
        assert.equal(r.ok, true, r.error)
      })
      await evaluate("标本 步骤二：mapper 片段跑通，context.out 收到 5 条 <word,1>", async () => {
        const r = await session.eval(step2.code, { timeout: TIMEOUT })
        assert.equal(r.ok, true, r.error)
        const echo = await session.eval("context.out;", { timeout: TIMEOUT })
        assert.equal(echo.ok, true, echo.error)
        for (const pair of ["a\t1", "b\t1", "c\t1"]) {
          assert.ok(echo.text.includes(pair), `context.out 缺 ${JSON.stringify(pair)}: ${echo.text}`)
        }
      })
      await evaluate("标本 步骤三：reducer 片段跑通（同会话消费 values），a 累加为 3", async () => {
        const r = await session.eval(step3.code, { timeout: TIMEOUT })
        assert.equal(r.ok, true, r.error)
        const echo = await session.eval("context.out;", { timeout: TIMEOUT })
        assert.ok(echo.text.includes("a\t3"), `reduce 后缺 a\\t3: ${echo.text}`)
      })
    }
  } else {
    console.log(`跳过标本全链路：标本或 ${HADOOP_COMMON} 不存在`)
  }

  session.destroy("test-done")
  assert.ok(!session.alive)

  console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})().catch(err => {
  console.error("验收脚本自身失败:", err)
  process.exit(1)
})
