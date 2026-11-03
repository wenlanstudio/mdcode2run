"use strict"
/**
 * 执行日志（DESIGN §7）——runtime 录制的 ▶ 序列，不声明、不进 md。
 *
 * 作用域是章（workdirKey = 文档路径#章行号）：同一章里 python/java/shell 的 ▶
 * 混排成一条时间线，因为跨语言的状态流（文件总线）本来就是章级的，trace 重放
 * 要忠实复现的正是这条混排序列。
 *
 * 重跑同一块 = 新条目新序号（append，不覆盖）——「再次运行 print(a)」看到的变化
 * 靠序号对齐：#2 print(a) → 1、#4 print(a) → 2。宿主拿 journal.of(key) 渲染轨迹，
 * 拿 result.session.seq 显示「▶ ran #N」。
 *
 * 这是引擎内存里的易失状态（随引擎实例存亡）；§7 的 trace sidecar（.md.trace，
 * 随讲义分发）是后续里程碑，落盘格式届时从这里导出。
 */

/** @returns {{ record: Function, of: Function, drop: Function }} */
const createJournal = () => {
  const chapters = new Map()   // workdirKey → entries[]

  return {
    /** 记一条 ▶，返回序号 n（章内自 1 递增）。entry: {family,line,hash,ok,ts}。 */
    record(key, entry) {
      if (!chapters.has(key)) chapters.set(key, [])
      const list = chapters.get(key)
      const n = list.length + 1
      list.push({ n, ...entry })
      return n
    },

    /** 某章的日志快照（深拷贝副本，改快照不伤内部）；无记录返回 []。 */
    of(key) {
      return (chapters.get(key) ?? []).map(e => ({ ...e }))
    },

    drop(key) {
      chapters.delete(key)
    },
  }
}

module.exports = { createJournal }
