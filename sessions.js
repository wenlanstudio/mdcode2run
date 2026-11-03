/**
 * 会话注册表（DESIGN.md §4）——与语言、宿主、执行原型都无关，只认识三件事：
 *
 *   key       会话身份（= 文档路径 + 章行号 + 语言族）
 *   factory   该怎么建一个会话（每个语言模块自己给：java 建常驻 JShell，python 建常驻解释器…）
 *   session   会话对象，须有 alive（是否还活着）与 destroy(reason)（关掉并清理）
 *
 * 职责边界：这里只管「谁存在、何时建、何时死」；块怎么喂进会话、结果长什么样，
 * 是各 runner 的事。懒建立：acquire 时没有活的才调 factory；空闲回收：超时没被
 * acquire 的会话被 destroy——常驻 JVM/解释器不该陪着一篇没人看的文档终老。
 */
const DEFAULT_IDLE_MS = 10 * 60 * 1000
const DEFAULT_REAP_MS = 60 * 1000

class SessionManager {
  constructor({ idleMs = DEFAULT_IDLE_MS, reapMs = DEFAULT_REAP_MS } = {}) {
    this._idleMs = idleMs
    this._entries = new Map()      // key → { session, creating: Promise|null, lastUsed: number }
    this._reapTimer = setInterval(() => this._reap(), reapMs)
    // Electron renderer 里定时器不 unref 也不碍事，但能免则免
    this._reapTimer.unref?.()
  }

  /**
   * 取一个活会话；没有（或已死）就用 factory 现建。同一 key 的并发 acquire 共享
   * 同一次创建（不会建出两个 JVM）；同一会话上的并发调用由会话自身排队（runner 层的事）。
   * @returns {Promise<object>} factory 造出的会话对象
   */
  acquire(key, factory) {
    let entry = this._entries.get(key)
    if (!entry || !entry.session.alive) {
      if (entry) this._drop(key, "dead")       // 死会话的残留（目录等）先清掉
      entry = { session: null, creating: null, lastUsed: 0 }
      this._entries.set(key, entry)
      entry.creating = (async () => {
        const session = await factory()
        entry.session = session
        entry.lastUsed = Date.now()
        return session
      })()
      entry.creating.catch(() => this._drop(key, "failed"))
    }
    entry.lastUsed = Date.now()
    return entry.creating ?? Promise.resolve(entry.session)
  }

  destroy(key, reason = "destroy") {
    const entry = this._entries.get(key)
    if (entry) this._drop(key, reason)
  }

  destroyAll(reason = "destroyAll") {
    for (const key of [...this._entries.keys()]) this._drop(key, reason)
  }

  stats() {
    return [...this._entries.entries()].map(([key, e]) => ({
      key,
      alive: !!(e.session && e.session.alive),
      idleMs: e.lastUsed ? Date.now() - e.lastUsed : 0,
    }))
  }

  _drop(key, reason) {
    const entry = this._entries.get(key)
    if (!entry) return
    this._entries.delete(key)
    try {
      entry.session?.destroy?.(reason)
    } catch { /* 清理失败不碍退场 */ }
  }

  _reap() {
    for (const [key, entry] of this._entries) {
      if (entry.creating) continue                       // 建立中的不看表
      if (entry.session && !entry.session.alive) { this._drop(key, "dead"); continue }
      if (Date.now() - entry.lastUsed > this._idleMs) this._drop(key, "idle")
    }
  }
}

module.exports = { SessionManager, DEFAULT_IDLE_MS, DEFAULT_REAP_MS }
