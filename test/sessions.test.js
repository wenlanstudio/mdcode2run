/**
 * sessions.js 验收脚本——零依赖，`node sessions.test.js` 直接跑。注册表的建立/复用/
 * 死亡重建/空闲回收/统一销毁，全部用假会话（不碰任何 JVM）。
 */
const assert = require("assert")
const { SessionManager } = require("../lib/sessions")

let passed = 0
const failures = []
const pending = []
/**
 * 同步用例当场计数；async 用例的 promise 进 pending——**汇总前必须 await 全部**，
 * 否则断言跑在 process.exit 之后，测试"绿"得毫无意义（本文件曾犯过此错，
 * 导致并发 acquire 的 TypeError 与空闲回收失效双双被假绿掩盖）。
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

const fakeSession = () => ({ alive: true, destroyed: "", destroy(reason = "") { this.destroyed = reason } })

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

;(async () => {
  t("acquire 建一次、复用同一会话（factory 只调一次）", async () => {
    const m = new SessionManager({ reapMs: 3600_000 })
    let created = 0
    const factory = () => (created += 1) && fakeSession()
    const a = await m.acquire("k", factory)
    const b = await m.acquire("k", factory)
    assert.strictEqual(a, b)
    assert.equal(created, 1)
    m.destroyAll()
  })

  t("同 key 并发 acquire 共享同一次创建（不建两个 JVM）", async () => {
    const m = new SessionManager({ reapMs: 3600_000 })
    let created = 0
    const factory = () => new Promise(resolve => setTimeout(() => resolve(fakeSession(), (created += 1)), 5))
    const [a, b] = await Promise.all([m.acquire("k", factory), m.acquire("k", factory)])
    assert.strictEqual(a, b)
    assert.equal(created, 1)
    m.destroyAll()
  })

  t("并发 acquire：factory 建立期间第二次 acquire 不抛 TypeError（旧 bug 1）", async () => {
    const m = new SessionManager({ reapMs: 3600_000 })
    let created = 0
    let resolveFirst
    const factory = () => new Promise(resolve => {
      created += 1
      resolveFirst = () => resolve(fakeSession())
    })
    // 第一次 acquire：factory 还没 resolve，entry.session 仍是 null
    const p1 = m.acquire("k", factory)
    // 立即第二次 acquire：此刻 entry.creating 进行中、entry.session=null
    // 旧代码 !entry.session.alive 直接 TypeError；修复后应共享同一次 creating
    const p2 = m.acquire("k", factory)
    resolveFirst()                                   // 放行 factory
    const [a, b] = await Promise.all([p1, p2])
    assert.strictEqual(a, b)
    assert.equal(created, 1, "并发期间二次 acquire 不应触发新 factory")
    m.destroyAll()
  })

  t("死会话在下次 acquire 时重建，旧的先被 destroy 清理", async () => {
    const m = new SessionManager({ reapMs: 3600_000 })
    const first = await m.acquire("k", fakeSession)
    first.alive = false
    const destroyCalls = []
    first.destroy = reason => destroyCalls.push(reason)
    const second = await m.acquire("k", fakeSession)
    assert.notStrictEqual(first, second)
    assert.deepEqual(destroyCalls, ["dead"])
    m.destroyAll()
  })

  t("destroy / destroyAll 落到会话的 destroy；stats 如实", async () => {
    const m = new SessionManager({ reapMs: 3600_000 })
    const a = await m.acquire("a", fakeSession)
    await m.acquire("b", fakeSession)
    assert.equal(m.stats().length, 2)
    m.destroy("a", "manual")
    assert.equal(a.destroyed, "manual")
    assert.equal(m.stats().length, 1)
    m.destroyAll("shutdown")
    assert.equal(m.stats().length, 0)
  })

  t("空闲回收：超过 idleMs 没 acquire 的会话被回收", async () => {
    const m = new SessionManager({ idleMs: 20, reapMs: 5 })
    const a = await m.acquire("k", fakeSession)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(a.destroyed, "idle")
    assert.equal(m.stats().length, 0)
    m.destroyAll()
  })

  t("factory 抛错 → acquire reject，注册表不留死条目", async () => {
    const m = new SessionManager({ reapMs: 3600_000 })
    await assert.rejects(() => m.acquire("k", () => { throw new Error("no jdk") }))
    assert.equal(m.stats().length, 0)
    // 同 key 再来一次：重新尝试（不被上次的失败卡死）
    const ok = await m.acquire("k", fakeSession)
    assert.ok(ok.alive)
    m.destroyAll()
  })

  await Promise.all(pending)   // 异步用例的断言全部落定后才许汇总（见 t 的注释）
  console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
