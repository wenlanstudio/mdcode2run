/**
 * 章执行计划——把一章的围栏序列变成"怎么跑"的三张清单（DESIGN.md §3/§4）。
 *
 * 名义：块角色词汇表在这里兑现成执行语义——
 *   setup 块 → 会话建立/重置时自动先跑（幂等）
 *   file= 块 → 物化为章工作目录里的文件（数据 / pom / 源码树……）
 *   无标注块 → 按文档序逐块跑（过期链的刻度）
 * demo / invalid / problems 非空的块一律不进计划（problems 门禁规则的执行点）。
 * 纯函数 + 一处显式 fs 写入（materializeFiles），不依赖宿主。
 */
const fs = require("fs")
const path = require("path")

/** FNV-1a 32 位：内容指纹（过期链）与路径代号（章工作目录）共用；够用、无依赖。 */
const fnv1a = text => {
  const s = String(text ?? "")
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

const runnable = f => !f.meta.problems.length

/**
 * @param {object[]} chapterFences 一章的围栏（parseChapters 给的文档序）
 * @param {{ langs?: string[] }} [opts] 会话的语言族（小写）。给了就只收这些语言的
 *   setup/blocks——会话身份是 (章, 语言)，java 的重放不得吞掉同章的 shell/xml 块；
 *   files 不过滤：物化是章级的（跨语言共享章工作目录）。
 * @returns {{ setups: object[], files: object[], blocks: object[], hashes: string[] }}
 *   blocks/hashes 平行：hashes[i] 是 blocks[i] 的内容指纹。
 */
const buildChapterPlan = (chapterFences, { langs } = {}) => {
  const fences = chapterFences ?? []
  const inFamily = f => !langs || langs.includes(f.lang)
  const setups = fences.filter(f => f.meta.role === "setup" && runnable(f) && inFamily(f))
  const files = fences.filter(f => f.meta.role === "file" && runnable(f))
  const blocks = fences.filter(f => f.meta.role === "code" && runnable(f) && inFamily(f))
  return { setups, files, blocks, hashes: blocks.map(f => fnv1a(f.code)) }
}

/**
 * 把 file= 块物化进章工作目录。相对路径已在解析期校验（无 .. 逃逸、非绝对）；
 * 结尾补一个换行（fence 正文经 parseFences 不带收尾换行，文件按惯例收在一行上）。
 * 幂等：重置/重放时反复调用无害。
 */
const materializeFiles = (plan, workdir) => {
  for (const f of plan.files) {
    const target = path.join(workdir, f.meta.file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    const body = f.code
    fs.writeFileSync(target, body.endsWith("\n") ? body : body + "\n", "utf8")
  }
}

module.exports = { fnv1a, buildChapterPlan, materializeFiles }
