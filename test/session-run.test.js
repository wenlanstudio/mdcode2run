/**
 * session-run.js / chapter.js 验收脚本——零依赖，`node session-run.test.js [标本路径]`。
 * 假会话记录 eval 序列，把编排逻辑（物化/引导/过期链/重放）逐条过；物化用真实临时目录。
 */
const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { fnv1a, buildChapterPlan, materializeFiles } = require("../chapter")
const { sessionRun, chapterWorkdir } = require("../session-run")
const { parseFences, parseChapters } = require("../fences")

let passed = 0
const failures = []
const pending = []
/**
 * 同步用例当场计数；async 用例的 promise 进 pending——**汇总前必须 await 全部**，
 * 否则断言跑在 process.exit 之后，测试"绿"得毫无意义（本文件曾犯过此错）。
 */
const t = (name, fn) => {
  try {
    const r = fn()
    if (r && typeof r.then === "function") {
      pending.push(r.then(
        () => { passed += 1 },
        e => failures.push(`${name}\n    ${e.message}`),
      ))
      return
    }
    passed += 1
  } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}

/** 假会话：记录 eval 的源码序列；脚本可控每块的 ok。 */
const fakeSession = () => {
  const s = {
    evals: [],
    alive: true,
    destroyed: "",
    failAt: -1,                 // 第 N 次 eval 返回失败（-1 从不）
    destroy(reason = "") { this.destroyed = reason },
    eval(source) {
      this.evals.push(source)
      const n = this.evals.length
      return Promise.resolve({ ok: this.failAt !== n, kind: "none", stdout: "", text: "", error: this.failAt === n ? `boom@${n}` : "" })
    },
  }
  return s
}

/** 用标本的实训篇做 ctx。position 取 java 的 code 块（会话按语言族过滤，shell 块不在 java 计划里）。 */
const specimenCtx = (specimen, chapterTitle, which, { last = false } = {}) => {
  const md = fs.readFileSync(specimen, "utf8")
  const fences = parseFences(md)
  const chapters = parseChapters(md, fences)
  const chapter = chapters.find(c => c.title === chapterTitle)
  const wanted = chapter.fences.filter(f => f.meta.role === which && f.lang === "java")
  const fence = last ? wanted[wanted.length - 1] : wanted[0]
  const position = chapter.fences.indexOf(fence)
  assert.ok(position >= 0, `章里没有 java 的 ${which} 块`)
  return {
    key: "test-doc#10#exec_java",
    workdirKey: "test-doc#10",
    chapter: chapter.title,
    index: chapters.indexOf(chapter),
    fences: chapter.fences,
    position,
    langs: ["java"],   // 与 base._sessionCtx 一致：章计划按语言族过滤，重放不越语言
  }
}
;(async () => {
  const SPECIMEN = process.argv[2]
    || path.join(__dirname, "fixtures", "4-1-1-Hadoop_MapReduce.specimen.md")
  const specimenReady = fs.existsSync(SPECIMEN)
  const specimenTest = (name, fn) => {
    if (specimenReady) t(name, fn)
    else console.log(`  - 跳过：${name}（标本不存在：${SPECIMEN}）`)
  }
  if (!specimenReady) console.log("  - 未找到标本，跳过标本走查段（可用第一个参数指定）")

  // ---------- chapter.js ----------
  t("fnv1a：稳定且区分内容", () => {
    assert.equal(fnv1a("abc"), fnv1a("abc"))
    assert.notEqual(fnv1a("abc"), fnv1a("abd"))
  })
  t("buildChapterPlan：setups/files/blocks 三张清单，demo 与问题块不进计划", () => {
    const md = [
      "```java setup", "SETUP", "```",
      "```text file=data/a.txt", "hello", "```",
      "```java", "CODE1", "```",
      "```java demo", "DEMO", "```",
      "```java", "CODE2", "```",
    ].join("\n")
    const plan = buildChapterPlan(parseFences(md))
    assert.equal(plan.setups.length, 1)
    assert.equal(plan.files.length, 1)
    assert.deepEqual(plan.blocks.map(b => b.code.trim().split("\n")[0]), ["CODE1", "CODE2"])
    assert.equal(plan.hashes.length, 2)
  })

  // ---------- session-run：标本实训篇走查 ----------
  const chapterTitle = "实训篇：实现词频统计"
  const workdir = chapterWorkdir("test-doc#10")

  specimenTest("物化：file= 块按相对路径落进章工作目录（数据/pom/源码树），结尾带换行", async () => {
    const ctx = specimenCtx(SPECIMEN, chapterTitle, "code")
    const manager = { _m: new Map(), acquire: async (k, f) => { if (!manager._m.has(k)) manager._m.set(k, await f()); return manager._m.get(k) } }
    const created = []
    await sessionRun({ manager, ctx, create: wd => { created.push(wd); return fakeSession() }, source: "x", opts: {} })
    assert.equal(created[0], workdir, "会话 cwd 应是共享章工作目录")
    const bigdata = fs.readFileSync(path.join(workdir, "bigdata.txt"), "utf8")
    assert.ok(bigdata.startsWith("a\na b\na b c\n"), JSON.stringify(bigdata))
    assert.ok(fs.existsSync(path.join(workdir, "pom.xml")))
    assert.ok(fs.existsSync(path.join(workdir, path.join("src/main/java/com/studybigdata/hadoop/mapred/awordcount", "WordCountMain.java").replaceAll("/", path.sep))))
  })

  specimenTest("引导块自动先跑；setup 签名不变不重跑", async () => {
    const ctx = specimenCtx(SPECIMEN, chapterTitle, "code")
    let session = null
    const manager = { acquire: async (k, f) => session ??= await f() }
    const r1 = await sessionRun({ manager, ctx, create: () => fakeSession(), source: ctx.fences[ctx.position].code, opts: {} })
    assert.equal(session.evals.length, 2, "setup + 当前块")
    assert.ok(session.evals[0].includes("MockContext"), "第一个 eval 应是 setup")
    assert.equal(r1.session.ran, 1)
    assert.equal(r1.session.total, 2)
    await sessionRun({ manager, ctx: { ...ctx, position: ctx.fences.length - 1 }, create: () => fakeSession(), source: "step3", opts: {} })
    assert.equal(session.evals.length, 3, "setup 不重跑")
    assert.equal(r1.session.stale, 0)
  })

  specimenTest("过期链：上游块内容改动后，结果标 stale", async () => {
    const ctx = specimenCtx(SPECIMEN, chapterTitle, "code")
    let session = null
    const manager = { acquire: async (k, f) => session ??= await f() }
    await sessionRun({ manager, ctx, create: () => fakeSession(), source: "s2", opts: {} })
    // 构造"上游改动"：换个 fences 数组，让上游 step2 的内容变掉
    const mutated = ctx.fences.map(f => f.meta.role === "code" && f.code.includes("wordArray")
      ? { ...f, code: f.code + "\n// edited" }
      : f)
    const r = await sessionRun({ manager, ctx: { ...ctx, fences: mutated, position: ctx.fences.length - 1 }, create: () => fakeSession(), source: "s3", opts: {} })
    assert.ok(r.session.stale >= 1, `应检出过期块: ${JSON.stringify(r.session)}`)
  })

  specimenTest("重放：从第一个可跑块连跑到当前块，setup 必跑，只有最后一块进 onChunk", async () => {
    const ctx = specimenCtx(SPECIMEN, chapterTitle, "code", { last: true })   // 重放到最后一个 java 块（步骤三）
    let session = null
    const manager = { acquire: async (k, f) => session ??= await f() }
    const chunks = []
    await sessionRun({ manager, ctx, create: () => fakeSession(), source: "x", opts: {} })
    const before = session.evals.length
    const r = await sessionRun({
      manager, ctx, create: () => fakeSession(), source: "x",
      opts: { replay: true, onChunk: c => chunks.push(c) },
    })
    assert.equal(r.session.replayed, true)
    assert.equal(r.session.ran, r.session.total)
    const delta = session.evals.slice(before)
    assert.equal(delta.length, 3, "setup + 步骤二 + 步骤三（重放全章）")
    assert.ok(delta[0].includes("MockContext"), "重放时 setup 必跑")
  })

  specimenTest("重放中途失败：报第几块；setup 失败：报引导块并中止", async () => {
    const ctx = specimenCtx(SPECIMEN, chapterTitle, "code")
    let session = null
    const manager = { acquire: async (k, f) => session ??= await f() }
    await sessionRun({ manager, ctx, create: () => fakeSession(), source: "x", opts: {} })
    session.failAt = session.evals.length + 2        // 重放的第 2 次 eval（setup 之后第 1 块）失败
    const r = await sessionRun({ manager, ctx, create: () => fakeSession(), source: "x", opts: { replay: true } })
    assert.equal(r.ok, false)
    assert.ok(r.error.includes("重放在第 1 块失败"), r.error)

    const bad = fakeSession()
    bad.failAt = 1                                   // setup 就失败
    const r2 = await sessionRun({ manager: { acquire: async (k, f) => bad }, ctx, create: () => bad, source: "x", opts: {} })
    assert.equal(r2.ok, false)
    assert.ok(r2.error.includes("引导块（setup）执行失败"), r2.error)
  })

  specimenTest("章工作目录：同名 key 稳定复用", () => {
    assert.equal(chapterWorkdir("k1"), chapterWorkdir("k1"))
    assert.notEqual(chapterWorkdir("k1"), chapterWorkdir("k2"))
  })

  specimenTest("章计划按语言族过滤：java 会话不吞同章的 shell/xml 块（会话身份 = 章×语言）", () => {
    const md = ["```java", "J1", "```", "```shell", "S1", "```", "```xml", "X1", "```", "```java", "J2", "```"].join("\n")
    const fences = parseFences(md)
    const plan = buildChapterPlan(fences, { langs: ["java"] })
    assert.deepEqual(plan.blocks.map(b => b.code), ["J1", "J2"])
    const all = buildChapterPlan(fences)
    assert.equal(all.blocks.length, 4, "不给 langs 保持全量（files 永远全量）")
  })

  specimenTest("重放不越语言：ctx.langs=java 时同章 shell/xml 块不进重放序列", async () => {
    const md = ["```java", "J1", "```", "```shell", "S1", "```", "```xml", "X1", "```", "```java", "J2", "```"].join("\n")
    const fences = parseFences(md)
    const ctx = { key: "k", workdirKey: "wk", chapter: "c", fences, position: 3, langs: ["java"] }
    let session = null
    const manager = { acquire: async (k, f) => session ??= await f() }
    const r = await sessionRun({ manager, ctx, create: () => fakeSession(), source: "J2", opts: { replay: true } })
    assert.deepEqual(session.evals, ["J1", "J2"], `重放序列混入了别的语言: ${JSON.stringify(session.evals)}`)
    assert.equal(r.session.total, 2)
  })

  specimenTest("重放跳过作业块：job 块不被代启，结果里注明；正常 ▶ 不受影响", async () => {
    const md = ["```java", "A", "```", "```java job", "JOB", "```", "```java", "C", "```"].join("\n")
    const fences = parseFences(md)
    const ctx = { key: "k", workdirKey: "wk", chapter: "c", fences, position: 2, langs: ["java"] }
    let session = null
    const manager = { acquire: async (k, f) => session ??= await f() }
    const r = await sessionRun({ manager, ctx, create: () => fakeSession(), source: "C", opts: { replay: true } })
    assert.deepEqual(session.evals, ["A", "C"], "作业块不应被重放代启")
    assert.ok((r.text ?? "").includes("跳过 1 个作业块"), r.text)
    assert.equal(r.session.total, 3)
    assert.equal(r.session.ran, 2)
    // 普通 ▶ 跑作业块：sessionRun 不管执行模式，照常 eval（启动交给 shell 模块的 job 路由）
    const r2 = await sessionRun({ manager, ctx: { ...ctx, position: 1 }, create: () => fakeSession(), source: "JOB", opts: {} })
    assert.equal(session.evals.length, 3)
    assert.equal(r2.session.ran, 3)
  })

  await Promise.all(pending)   // 异步用例的断言全部落定后才许汇总（见 t 的注释）
  console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
