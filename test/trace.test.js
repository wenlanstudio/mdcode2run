"use strict"
/**
 * trace sidecar 测试（DESIGN §7）——纯函数三件套（serialize/parse/plan）+ journal 合并。
 * 全部离线零 I/O；引擎文件落盘/重演循环由真机冒烟覆盖（见 README 手册）。
 *
 * 测试壳铁律：异步用例必须 await（照 sessions.test.js / session-run.test.js 的壳）。
 */
const assert = require("assert")
const { serializeTrace, parseTrace, planTrace } = require("../lib/trace")
const { createJournal } = require("../lib/journal")
const { fnv1a } = require("../lib/chapter")

let passed = 0
const failures = []
const pending = []
const t = (name, fn) => {
  const p = (async () => { await fn(); passed += 1 })().catch(e => failures.push(`${name}\n    ${e.message}`))
  pending.push(p)
}

const fakeEntry = over => ({ n: 1, family: "python", line: 20, hash: fnv1a("x"), ok: true, ts: 1000, src: "run", ...over })

t("serialize：首行头 + 逐章逐条 + 章过滤", () => {
  const chapters = [
    { ch: 12, entries: [fakeEntry({ n: 1 }), fakeEntry({ n: 2, line: 30, src: "replay" })] },
    { ch: 40, entries: [fakeEntry({ n: 1, family: "java", line: 55 })] },
  ]
  const all = serializeTrace(chapters, "D:/t/lec3.md")
  const lines = all.split("\n").filter(Boolean)
  assert.equal(lines.length, 4)
  assert.deepEqual(JSON.parse(lines[0]), { v: 1, doc: "D:/t/lec3.md" })
  assert.equal(JSON.parse(lines[1]).ch, 12)
  assert.equal(JSON.parse(lines[2]).src, "replay")
  // 只序列化一章
  const one = serializeTrace(chapters, "D:/t/lec3.md", 40)
  assert.equal(one.split("\n").filter(Boolean).length, 2)
})

t("parse：正常 + 版本不符 + 文档归属不符 + 坏行计数", () => {
  const good = ['{"v":1,"doc":"a.md"}', '{"ch":0,"n":1,"family":"python","line":5,"hash":"h","ok":true,"ts":1}', '{"ch":0,"n":2,"family":"java","line":9,"hash":"h2"}'].join("\n")
  const r = parseTrace(good, "a.md")
  assert.equal(r.ok, true)
  assert.equal(r.entries.length, 2)
  assert.equal(r.entries[1].src, "run", "缺 src 补默认 run")
  // 版本
  assert.equal(parseTrace('{"v":2,"doc":"a.md"}').ok, false)
  // 归属
  const mis = parseTrace('{"v":1,"doc":"b.md"}\n{"ch":0,"n":1,"line":5}', "a.md")
  assert.equal(mis.ok, false)
  assert.match(mis.error, /b\.md/)
  // 坏行只计数
  const bad = parseTrace('{"v":1,"doc":"a.md"}\n不是json\n{"ch":0,"n":1}\n{"ch":0,"n":2,"line":7}', "a.md")
  assert.equal(bad.ok, true)
  assert.equal(bad.bad, 2, "不是json + 缺 line 的行都算坏行")
  assert.equal(bad.entries.length, 1)
})

t("round-trip：serialize → parse 还原等价", () => {
  const chapters = [
    { ch: 7, entries: [fakeEntry({ n: 1 }), fakeEntry({ n: 2, ok: false, src: "trace", ts: 2000 })] },
    { ch: 8, entries: [fakeEntry({ n: 1, family: "shell", line: 99 })] },
  ]
  const { ok, entries } = parseTrace(serializeTrace(chapters, "d.md"), "d.md")
  assert.equal(ok, true)
  assert.equal(entries.length, 3)
  assert.deepEqual(entries.map(e => [e.ch, e.n]), [[7, 1], [7, 2], [8, 1]])
  assert.equal(entries[1].ok, false)
  assert.equal(entries[1].src, "trace")
})

t("planTrace：hash 一致 run；源码变了/块没了/不可执行 → stale", () => {
  const codeA = "print(1)"
  const codeB = "print(2)"
  const parsed = {
    blocks: [
      { line: 10, index: 0, runnable: true },
      { line: 20, index: 1, runnable: false },   // demo 块（录制后改成了 demo）
      // line 30 的块被删了
    ],
    fences: [{ code: codeA }, { code: codeB }],
  }
  const entries = [
    fakeEntry({ line: 10, hash: fnv1a(codeA) }),   // 一致 → run
    fakeEntry({ line: 10, hash: fnv1a("已改") }),   // 源码变了 → stale
    fakeEntry({ line: 20, hash: fnv1a(codeB) }),   // 不可执行 → stale
    fakeEntry({ line: 30, hash: fnv1a(codeB) }),   // 块没了 → stale
  ]
  const plan = planTrace(entries, parsed)
  assert.deepEqual(plan.map(s => s.action), ["run", "stale", "stale", "stale"])
})

t("journal.merge：同 n 判重跳过；乱序合入按 n 排序", () => {
  const j = createJournal()
  assert.equal(j.record("k", { family: "python", line: 1, hash: "a", ok: true, ts: 1 }), 1)
  assert.equal(j.record("k", { family: "python", line: 2, hash: "b", ok: true, ts: 2 }), 2)
  assert.equal(j.merge("k", fakeEntry({ n: 2 })), false, "同 n 判重")
  assert.equal(j.merge("k", fakeEntry({ n: 3, line: 3 })), true)
  assert.equal(j.of("k").length, 3)
  assert.deepEqual(j.of("k").map(e => e.n), [1, 2, 3])
  // 不同章互不干扰
  assert.equal(j.merge("k2", fakeEntry({ n: 9 })), true)
})

t("journal.all：trace 序列化的全视图", () => {
  const j = createJournal()
  j.record("D:/t/a.md#12", { family: "python", line: 20, hash: "h", ok: true, ts: 1 })
  j.record("D:/t/a.md#40", { family: "java", line: 55, hash: "h", ok: true, ts: 2 })
  const all = j.all()
  assert.equal(all.length, 2)
  assert.equal(all[0].key, "D:/t/a.md#12")
  assert.equal(all[0].entries[0].line, 20)
})

;(async () => {
  await Promise.all(pending)   // 异步用例的断言全部落定后才许汇总（测试壳铁律）
  console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})()
