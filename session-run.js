/**
 * 会话执行编排——eval 原型的块进入会话前后的全部手续（DESIGN.md §4/§8）：
 *
 *   物化        file= 块写进章工作目录（先于一切执行——setup 可能要读它们）
 *   建立        章工作目录（跨语言共享：文件系统是会话间的总线）+ 注册表 acquire
 *   引导        setup 块自动先跑；签名（内容指纹）没变就不重跑，重放必跑（幂等约定）
 *   过期链      记录已跑块的内容指纹；当前块之前有任何块改动 → 结果里报 stale
 *   文件依赖边  跨语言 stale（DESIGN §8）：每块跑时拍章工作目录的文件快照，
 *               源码里提到某文件且该文件内容后来变了（别的语言块改写、file=
 *               重物化）→ 该块 stale。file= 在此兼作产出声明。
 *   重放        连跑到这里：从第一个可跑块按文档序跑到当前块（确定性顺序）
 *
 * 与语言无关：任何提供 eval(source, {onChunk, timeout}) → 契约结果 的会话都能接
 * （java 的常驻 JShell 是第一个实现，python 常驻解释器是下一个）。
 */
const fs = require("fs")
const path = require("path")
const os = require("os")
const { fnv1a, buildChapterPlan, materializeFiles } = require("./chapter")

/**
 * 章工作目录：同一 (文档, 章) 的所有会话共享同一个目录——跨语言协作（shell put 的
 * 文件 java 读得到）就靠它。目录名用 key 的指纹，稳定且合法；建一次，反复复用
 * （不随会话销毁而删除：里面可能有用户关心的时间上昂贵的产物，如编译好的 target/）。
 */
const chapterWorkdir = key => {
  const dir = path.join(os.tmpdir(), "md-exec-chapters", fnv1a(String(key)))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 章工作目录的文件快照：{ 相对路径: 内容指纹 }。空目录/异常 → {}。 */
const snapshotFiles = workdir => {
  const out = {}
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      const rel = prefix ? `${prefix}/${name}` : name
      if (fs.statSync(p).isDirectory()) walk(p, rel)
      else out[rel] = fnv1a(fs.readFileSync(p, "utf8"))
    }
  }
  try { walk(workdir, "") } catch { /* 目录刚被外部清掉等——按空目录处理 */ }
  return out
}

/** 当前块的下标。当前块不是可跑块（demo / 带问题的标注）时，视作它之前最后一个可跑块。 */
const resolveBlockIndex = (plan, ctx) => {
  const at = i => ctx.fences[i]
  let idx = plan.blocks.findIndex(b => at(ctx.position) === b)
  if (idx >= 0) return idx
  for (let i = ctx.position - 1; i >= 0; i--) {
    idx = plan.blocks.indexOf(at(i))
    if (idx >= 0) return idx
  }
  return -1
}

/**
 * 在会话里跑一块代码（或重放到某块）。
 * @param {{ manager: object, ctx: object, create: (workdir: string) => object,
 *           source: string, opts?: { onChunk?: Function, timeout?: number, replay?: boolean }} args
 *   ctx 来自 base._sessionCtx：{ key, workdirKey, chapter, fences, position }
 * @returns 契约结果，附 `session` 字段：
 *   { chapter, ran, total, stale, replayed }  —— 供 HUD 与过期提示展示
 */
const sessionRun = async ({ manager, ctx, create, source, opts = {} }) => {
  const plan = buildChapterPlan(ctx.fences, { langs: ctx.langs })
  const workdir = chapterWorkdir(ctx.workdirKey)
  materializeFiles(plan, workdir)
  const session = await manager.acquire(ctx.key, () => create(workdir))
  const memory = session.memory ??= { setupSignature: "", ranFacts: [] }
  const blockIndex = resolveBlockIndex(plan, ctx)
  const chapterFiles = () => snapshotFiles(workdir)

  // 引导块：重放必跑（幂等约定让重跑无害）；平时只在内容变化后重跑
  const signature = plan.setups.map(f => fnv1a(f.code)).join(",")
  if (opts.replay || memory.setupSignature !== signature) {
    for (const setup of plan.setups) {
      const r = await session.eval(setup.code, { timeout: opts.timeout })
      if (!r.ok) {
        return decorate({ ...r, error: `引导块（setup）执行失败，会话未就绪：\n${r.error}` }, memory, plan, ctx, chapterFiles, opts)
      }
    }
    memory.setupSignature = signature
    memory.ranFacts = []
  }

  // 过期链：当前块之前、已跑过但后来失效了的块（内容改了 / 读的文件变了）
  const stale = countStale(plan, memory, blockIndex, chapterFiles())

  let result = null
  if (opts.replay) {
    if (blockIndex < 0) return decorate({ ok: false, kind: "none", stdout: "", text: "", error: "本章没有可重放的可执行块" }, memory, plan, ctx, chapterFiles, opts)
    memory.ranFacts = []
    let skippedJobs = 0
    for (let i = 0; i <= blockIndex; i++) {
      if (plan.blocks[i].meta?.job) { skippedJobs += 1; continue }   // 作业不由重放代启：重放必须幂等安全
      // 只有最后一块的输出进终端/卡片：重放的意义是"恢复状态"，中间块的流只会淹没观众
      result = await session.eval(plan.blocks[i].code, { timeout: opts.timeout, onChunk: i === blockIndex ? opts.onChunk : undefined })
      memory.ranFacts[i] = { hash: plan.hashes[i], files: chapterFiles() }
      if (!result.ok) {
        return decorate({ ...result, error: `重放在第 ${i + 1} 块失败：\n${result.error}` }, memory, plan, ctx, chapterFiles, opts)
      }
    }
    if (!result) {
      result = { ok: true, kind: "none", stdout: "", text: "（重放区间内只有作业块——作业不由重放代启，需要时手动 ▶）", error: "" }
    } else if (skippedJobs) {
      result.text = [result.text, `（重放跳过 ${skippedJobs} 个作业块——作业不由重放代启，需要时手动 ▶）`].filter(Boolean).join("\n")
    }
  } else {
    const filesBefore = chapterFiles()   // 块跑时所见的文件状态（输入快照）
    result = await session.eval(source, { timeout: opts.timeout, onChunk: opts.onChunk })
    if (blockIndex >= 0) memory.ranFacts[blockIndex] = { hash: plan.hashes[blockIndex], files: filesBefore }
  }
  return decorate(result, memory, plan, ctx, chapterFiles, opts)
}

/**
 * stale 计数（DESIGN §8 两类依赖边）：
 *   顺序边（同语言保守）：块内容指纹和跑过时不一致 → stale。
 *   文件边（跨语言精确）：源码提到某文件，且该文件自跑过之后变了
 *   （别的块改写 / file= 重物化 / 跑时还不存在现在有了）→ stale。
 * 提到 = 源码文本包含相对文件名——字面引用零漏报；没引用文件却撞上同名的
 * 情形是保守多报，宁多勿漏（stale 只提示不自动跑，多报无害）。
 */
const countStale = (plan, memory, upto, currentFiles) => {
  let n = 0
  for (let i = 0; i < upto; i++) {
    const fact = memory.ranFacts?.[i]
    if (!fact) continue
    if (fact.hash !== plan.hashes[i]) { n += 1; continue }
    for (const [name, now] of Object.entries(currentFiles)) {
      if (fact.files[name] !== now && plan.blocks[i].code.includes(name)) { n += 1; break }
    }
  }
  return n
}

const decorate = (result, memory, plan, ctx, chapterFiles, opts) => Object.assign(result, {
  session: {
    chapter: ctx.chapter,
    ran: memory.ranFacts.filter(Boolean).length,
    total: plan.blocks.length,
    stale: countStale(plan, memory, plan.blocks.length, chapterFiles()),
    replayed: !!opts.replay,
  },
})

module.exports = { sessionRun, chapterWorkdir }
