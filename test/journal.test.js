/**
 * 执行日志（DESIGN §7）+ stale 文件依赖边（DESIGN §8）验收——零依赖、不碰真机。
 * journal 用假条目；session-run 用假会话（eval 原样回显），ctx 用真 fences 解析。
 */
const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { createJournal } = require("../lib/journal")
const { sessionRun, chapterWorkdir } = require("../lib/session-run")
const { parseFences, parseChapters } = require("../lib/fences")

let passed = 0
const failures = []
const pending = []
/** 同步当场计数；async 进 pending，汇总前必须 await 全部（测试壳铁律）。 */
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

;(async () => {
  // ── journal 基本盘 ──

t("record 章内自增、跨章独立计数；of 返回快照副本；drop 清章", () => {
  const j = createJournal()
  assert.equal(j.record("a", { family: "python" }), 1)
  assert.equal(j.record("a", { family: "python" }), 2)
  assert.equal(j.record("b", { family: "shell" }), 1)
  assert.equal(j.of("a").length, 2)
  assert.equal(j.of("b")[0].n, 1)
  assert.equal(j.of("nope").length, 0)
  j.of("a")[0].n = 99                       // 副本：改快照不伤内部
  assert.equal(j.of("a")[0].n, 1)
  j.drop("a")
  assert.equal(j.of("a").length, 0)
})

// ── session-run：文件依赖边（跨语言 stale）──

/** 章 md：file= 物化 CSV + 两个 python 块（块1 读文件、块2 与文件无关）。 */
const MD = t => `# 章

\`\`\`text file=scores.csv
name,score
甲,90
\`\`\`

\`\`\`python
print(open("scores.csv").read())
\`\`\`

\`\`\`python
print("${t} 与文件无关")
\`\`\`
`

const fakeManager = () => {
  let s = null
  return { acquire: async (key, factory) => (s ??= factory("")) }
}
const fakeSession = () => ({
  eval: async code => ({ ok: true, kind: "text", stdout: "", text: code, error: "" }),
})

/** 清掉某章工作目录（tmpdir 持久——上次测试运行留下的文件会污染文件边用例）。 */
const freshWorkdir = key => fs.rmSync(chapterWorkdir(key), { recursive: true, force: true })

/** 解析 md 并构造第 target 个围栏（0 基，按 chapter.fences 下标）的 ctx。 */
const ctxOf = (md, target, workdirKey) => {
  const fences = parseFences(md)
  const chapter = parseChapters(md, fences)[0]
  return {
    key: `${workdirKey}#python`,
    workdirKey,
    chapter: chapter.title,
    fences: chapter.fences,
    position: chapter.fences.indexOf(fences[target === 1 ? 1 : 2]),
    langs: ["python", "py"],
  }
}

t("文件边：块跑后文件被改 → 该块 stale；没提文件的块不受牵连", async () => {
  const workdirKey = "journal-t2#0"
  const md = `# 章

\`\`\`text file=scores.csv
name,score
\`\`\`

\`\`\`python
print(open("out.csv").read())
\`\`\`

\`\`\`python
print("与文件无关")
\`\`\`
`
  const manager = fakeManager()   // 同一会话跨 ▶ 复用（ranFacts 才能留存）
  freshWorkdir(workdirKey)
  const run = async target => sessionRun({
    manager, create: fakeSession,
    ctx: ctxOf(md, target, workdirKey),
    source: parseFences(md)[target === 1 ? 1 : 2].code,
  })
  // out.csv 不是 file= 管的（file= 文件每次 ▶ 都重物化回文档内容，改它没意义）——
  // 先放一份，模拟上游已产出；块1 跑时读它
  fs.writeFileSync(path.join(chapterWorkdir(workdirKey), "out.csv"), "v1\n", "utf8")
  const r1 = await run(1)
  assert.equal(r1.session.stale, 0, "刚跑完不该 stale")
  assert.equal(r1.session.ran, 1)

  // 外部改写（模拟另一语言块重跑产出）
  fs.writeFileSync(path.join(chapterWorkdir(workdirKey), "out.csv"), "v2 已变\n", "utf8")

  const r2 = await run(2)
  assert.equal(r2.session.stale, 1, "块1（提到 out.csv）应 stale，块2 不受牵连")
  assert.equal(r2.session.ran, 2)
})

t("文件边：跑时不存在、后来才出现的文件也触发 stale", async () => {
  const workdirKey = "journal-t3#0"
  const md = `# 章

\`\`\`text file=scores.csv
name,score
\`\`\`

\`\`\`python
print(open("out.csv").read())
\`\`\`

\`\`\`python
print("无关")
\`\`\`
`
  const manager = fakeManager()
  freshWorkdir(workdirKey)
  const run = async target => sessionRun({
    manager, create: fakeSession,
    ctx: ctxOf(md, target, workdirKey),
    source: parseFences(md)[target === 1 ? 1 : 2].code,
  })
  const r1 = await run(1)   // out.csv 还不存在
  assert.equal(r1.session.stale, 0)
  fs.writeFileSync(path.join(chapterWorkdir(workdirKey), "out.csv"), "x\n", "utf8")
  const r2 = await run(2)
  assert.equal(r2.session.stale, 1, "消费的文件出现了 → 上次跑的结果过时")
})

t("顺序边回归：块源码改了 → stale（不依赖文件）", async () => {
  const workdirKey = "journal-t4#0"
  const mdA = MD("t4")
  const manager = fakeManager()
  const runA = async target => sessionRun({
    manager, create: fakeSession,
    ctx: ctxOf(mdA, target, workdirKey),
    source: parseFences(mdA)[target === 1 ? 1 : 2].code,
  })
  await runA(1)
  // 同一工作目录，换一份块1 源码不同的 md（模拟老师在编辑器里改了块1）
  const mdB = MD("t4").replace('print(open("scores.csv").read())', 'print(open("scores.csv").read().strip())')
  const ctxB = ctxOf(mdB, 2, workdirKey)
  const r2 = await sessionRun({
    manager, create: fakeSession, ctx: ctxB,
    source: parseFences(mdB)[2].code,
  })
  assert.equal(r2.session.stale, 1, "块1 内容指纹变了 → stale")
})

t("重放：ranFacts 清空重建，stale 归零", async () => {
  const workdirKey = "journal-t5#0"
  const md = MD("t5")
  const manager = fakeManager()
  freshWorkdir(workdirKey)
  const run = (target, replay) => sessionRun({
    manager, create: fakeSession,
    ctx: ctxOf(md, target, workdirKey),
    source: parseFences(md)[target === 1 ? 1 : 2].code,
    opts: { replay: !!replay },
  })
  await run(1)
  fs.writeFileSync(path.join(chapterWorkdir(workdirKey), "scores.csv"), "name,score\n乙,1\n", "utf8")
  const r = await run(2, true)   // 重放到块2：从块1 连跑（文件边已被重放消化）
  assert.equal(r.session.replayed, true)
  assert.equal(r.session.stale, 0, "重放恢复状态后不该再报 stale")
  assert.equal(r.session.ran, 2)
})

await Promise.all(pending)   // 异步用例的断言全部落定后才许汇总（测试壳铁律）
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(failures.length ? 1 : 0)
})().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
