"use strict"
/**
 * mdcode2run —— Markdown 代码执行引擎。
 *
 * 无头核心：四层架构原样保留——
 *   ① Runner（runners/，纯 Node）→ ② 语言模块（languages/，能力/配置/路由）
 *   → ③ 编排（fences/sessions/chapter/session-run）→ 门面（本文件）。
 * 原来的 ④ 宿主适配与全部 UI（结果卡片 / 放映浮层 / ▶ 按钮）不进引擎——
 * 呈现归宿主（md2slides 放映器或任意自定义宿主渲染结果契约）。
 *
 * 铁律：引擎不知道 DOM 的存在。结果只经结果契约 + events 事件流交付：
 *   run(ctx) → { ok, kind, stdout, text, error, rows?, images?, session?, job? }
 *   events: started {family,line,surface} / chunk {…,stream,text} / done {…,ok,duration,error?}
 *
 * 配置六层（DESIGN §4）：tech < course < doc(front-matter preset+override) < chapter < block < engine；
 * engine 层持有全部秘密（config.secrets 供 ${NAME} 占位符取真值，config.<family> 直配兜底）。
 * v1 实现 tech/course/doc/engine 四层；chapter/block override 留位。
 */

const path = require("path")
const { parseFences, parseChapters, locateFence } = require("./fences")
const { frontMatterOf } = require("./front-matter")
const { createRunEvents } = require("./events")
const { BUILTIN_TECHS, BUILTIN_COURSES, resolveFamily, presetNameOf } = require("./preset")

const LANGUAGES = {
  python: require("./languages/python"),
  java: require("./languages/java"),
  shell: require("./languages/shell"),
  mysql: require("./languages/mysql"),
  hive: require("./languages/hive"),
}

/** 契约失败结果的标准形状（与 runners 的失败返回同构）。 */
const contractFail = error => ({ ok: false, kind: "none", stdout: "", text: "", error })

/**
 * 可执行角色的块：code 与 setup（setup 是引导块，▶ 可跑、重放也跑）；
 * demo / file / invalid（标注冲突）不参与执行。
 */
const RUNNABLE_ROLES = new Set(["code", "setup"])

/**
 * @param {object} [opts]
 * @param {object} [opts.config] engine 层：{ <family>: {KEY,…} } 直配（无 preset 时的
 *   唯一来源，可放秘密）+ { secrets: {NAME: 真值} } 供 preset 的 ${NAME} 占位符取值。
 * @param {object} [opts.techs] 技术 schema 追加/覆盖（键合入内置五族）
 * @param {object} [opts.courses] 课程装订追加/覆盖（键合入内置六门课）
 * @param {string} [opts.documentPath] 当前文档路径（会话身份的锚）；空串 = 未存盘（会话
 *   key 不含路径）。
 * @param {string} [opts.documentDir] 文档所在目录（相对 class-path / 本机执行的基准）。
 */
const createEngine = ({ config = {}, techs = {}, courses = {}, documentPath = "", documentDir = "" } = {}) => {
  const techTable = { ...BUILTIN_TECHS, ...techs }
  const courseTable = { ...BUILTIN_COURSES, ...courses }
  const secrets = (config && typeof config.secrets === "object" && config.secrets) || {}
  const events = createRunEvents()
  const baseMods = new Map()   // family → 语言模块（langs 探测 + 无 preset 时的执行实现）
  const docMods = new Map()    // `${documentPath}#${family}` → preset 解析后的执行模块

  const baseMod = family => {
    if (!baseMods.has(family)) {
      const factory = LANGUAGES[family]
      if (!factory) return null
      baseMods.set(family, factory.create({ config: config[family] ?? {} }))
    }
    return baseMods.get(family)
  }

  /** 语言标记 → 语言族。LANGS 在引擎配置层（config.<family>.LANGS），不在前言层。 */
  const familyOf = lang => {
    const key = String(lang ?? "").toLowerCase()
    if (!key) return null
    for (const name of Object.keys(LANGUAGES)) {
      if (baseMod(name).langs.includes(key)) return name
    }
    return null
  }

  /**
   * 执行模块：文档 front-matter 带 `preset: <课程名>` 时按六层解析
   * （tech 默认 < course 装订 < doc 覆盖，${NAME} 去 engine 层取真值），
   * 解析失败返回报错壳模块（运行时给出明确人话）；不带 preset 走现状直配。
   * 按文档缓存——同一引擎开多篇文档互不串配置。
   */
  const execMod = (family, fm) => {
    const key = `${documentPath || "anon"}#${family}`
    if (docMods.has(key)) return docMods.get(key)
    const base = baseMod(family)
    if (!base) return null
    let m = base
    const presetName = presetNameOf(fm)
    if (presetName) {
      const { config: resolved, problems } = resolveFamily({
        family, courseName: presetName, techs: techTable, courses: courseTable, secrets,
        docOverride: fm?.codeExec?.[family] ?? {},
      })
      if (problems.length) {
        const message = `环境档案解析失败（preset: ${presetName}）：${problems.join("；")}`
        m = {
          family, langs: base.langs,
          checkRuntime: () => ({ ok: false, message }),
          runOpts: () => ({}),
          run: async () => contractFail(message),
          resetSession: () => {}, dispose: () => {},
        }
      } else {
        m = LANGUAGES[family].create({ config: resolved })
      }
    }
    docMods.set(key, m)
    return m
  }

  /** 由 fence 构造运行上下文。chapter 定位失败时 session.key = null（退回一次性执行）。 */
  const ctxOf = (md, fence, family, precomputed = {}) => {
    const m = baseMod(family)
    const fences = precomputed.fences ?? parseFences(md)
    const chapters = precomputed.chapters ?? parseChapters(md, fences)
    const fm = precomputed.fm ?? frontMatterOf(md)
    const chapter = chapters.find(c => c.fences.includes(fence)) ?? null
    const docDir = documentDir || (documentPath ? path.dirname(documentPath) : "")
    return {
      family,
      lang: fence.lang,
      langs: m.langs,
      source: fence.code,
      meta: fence.meta,
      line: fence.line,
      doc: { md, path: documentPath, dir: docDir, fm },
      // 会话身份（DESIGN §4）：文档路径 + 章行号 + 语言族；章工作目录的 key 不含语言族
      //（同章跨语言共享目录）。sessionRun 消费 session 视图：{key, workdirKey, chapter, fences, position, langs}
      session: chapter ? {
        key: `${documentPath}#${chapter.line}#${family}`,
        workdirKey: `${documentPath}#${chapter.line}`,
        chapter: chapter.title,
        fences: chapter.fences,
        position: chapter.fences.indexOf(fence),
        langs: m.langs,
      } : null,
    }
  }

  /**
   * 解析一篇 md 的全部可执行面：块清单（带语言族与角色）、章、front-matter 视图。
   * 消费者拿它建 UI（哪些块出 ▶）、CLI 拿它做 list。
   */
  const parse = md => {
    const fences = parseFences(md)
    const chapters = parseChapters(md, fences)
    const fm = frontMatterOf(md)
    const blocks = fences.map((f, index) => {
      const family = familyOf(f.lang)
      return {
        index, lang: f.lang, family, supported: !!family,
        runnable: !!family && RUNNABLE_ROLES.has(f.meta.role) && f.meta.problems.length === 0,
        line: f.line, end: f.end,
        role: f.meta.role, job: !!f.meta.job,
        file: f.meta.file,
        problems: f.meta.problems,
      }
    })
    return { blocks, chapters, fm, fences }
  }

  /**
   * 定位一个可执行块，返回运行上下文。
   * @param {string} md 源码
   * @param {object} target 三选一：{ line }（0 基行号，落在块体内即可）/
   *   { code, lang? }（内容定位，编辑器态用法）/ { index }（parse().blocks 的下标）
   * @param {object} [opts] { anyRole?: boolean }——true 时不做角色过滤（消费方自查）
   * @returns ctx | null（无块 / 语言不支持 / 块不可执行）
   */
  const locate = (md, target = {}, { anyRole = false } = {}) => {
    const fences = parseFences(md)
    let fence = null
    if (target.index != null) fence = fences[target.index] ?? null
    else if (target.line != null) fence = fences.find(f => target.line >= f.line && target.line < f.end) ?? null
    else if (target.code != null) {
      const idx = locateFence(fences, target.lang ?? "", target.code)
      fence = idx >= 0 ? fences[idx] : null
    }
    if (!fence) return null
    if (!anyRole && (!RUNNABLE_ROLES.has(fence.meta.role) || fence.meta.problems.length)) return null
    const family = familyOf(fence.lang)
    if (!family) return null
    return ctxOf(md, fence, family, { fences })
  }

  /**
   * 跑一块代码（或重放到它）。
   * @param {object} ctx locate() 的返回
   * @param {object} [opts] { onChunk?: ({stream,text}) => void, replay?: boolean, timeout?: number }
   * @returns 契约结果；作业模式 result.kind === "job" 时 result.job = { id, stop, done }，
   *   done 兑现 { code, signal, killed, durationMs, error? }。引擎不抛执行错误——失败走契约。
   */
  const run = async (ctx, { onChunk, replay = false, timeout } = {}) => {
    const m = execMod(ctx.family, ctx.doc.fm)
    const detail = { family: ctx.family, line: ctx.line, surface: "api" }
    const check = m.checkRuntime(ctx)
    if (!check.ok) return contractFail(check.message)

    const forwardChunk = info => {
      events.emit("chunk", { ...detail, stream: info.stream, text: info.text })
      onChunk?.(info)
    }
    const opts = { ...m.runOpts(ctx), onChunk: forwardChunk, session: ctx.session?.key ? ctx.session : null, replay: !!replay, meta: ctx.meta, doc: ctx.doc }
    if (timeout != null) opts.timeout = timeout

    const started = Date.now()
    events.emit("started", detail)
    try {
      const result = await m.run(ctx.source, opts)
      // 作业模式：启动即返回——本次"运行"在事件契约里已经 done（作业退出是另一个生命周期，
      // 消费者 await result.job.done）
      events.emit("done", { ...detail, ok: result.kind === "job" ? true : !!result.ok, duration: (Date.now() - started) / 1000, error: result.error || undefined })
      return result
    } catch (error) {
      const msg = error?.message ?? String(error)
      events.emit("done", { ...detail, ok: false, duration: (Date.now() - started) / 1000, error: msg })
      return contractFail(msg)
    }
  }

  /** ⏩ 重放到某块：从本章第一个可跑块按文档序连跑到 ctx（作业块跳过并注明）。 */
  const replay = (ctx, opts = {}) => run(ctx, { ...opts, replay: true })

  /** ⟳ 销毁会话。参数：locate() 的 ctx，或 {family, key}，或裸 key（广播到全部语言族）。 */
  const resetSession = target => {
    const all = [...baseMods.values(), ...docMods.values()]
    if (typeof target === "string") {
      for (const m of all) m.resetSession({ key: target })
      return
    }
    const family = target.family ?? target.session?.family
    if (family) for (const m of all) if (m.family === family) m.resetSession(target.session ?? target)
  }

  /** 退出前回收：销毁全部常驻会话（宿主关文档时调用）。 */
  const dispose = () => { for (const m of [...baseMods.values(), ...docMods.values()]) m.dispose?.() }

  return { events, parse, locate, run, replay, resetSession, dispose, config }
}

module.exports = { createEngine, contractFail }
