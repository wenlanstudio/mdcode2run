"use strict"
/**
 * Python 语言模块——```python 块的执行策略（原 Typora 插件 plugins/python.js 去掉插件壳）。
 *
 * 只回答四件事：认哪些语言标记、环境是否就绪、跑的时候带什么选项、怎么跑一块代码。
 * 有会话上下文走常驻解释器——同章的块共享命名空间（先加载数据、后续块反复调模型，
 * 正是 ML 课的讲法），图捕获、setup 引导、过期链、重放都在 sessionRun 编排；
 * 没有会话上下文（定位不到章）退回一次性执行。
 *
 * 与插件版的差异：原版 PYTHON_PATH 找不到时回落 [matplotlib] 插件的配置——那是
 * Typora 生态的问答，本引擎删掉；需要等效行为就在配置里写同一个路径。
 */

const fs = require("fs")
const path = require("path")
const { runPython } = require("../runners/python")
const { createPythonSession } = require("../runners/python-session")
const { SessionManager } = require("../sessions")
const { sessionRun } = require("../session-run")
const { frontMatterValue } = require("../front-matter")

const create = ({ config = {} } = {}) => {
  // 常驻会话注册表：每引擎一份（key 已含文档路径与章行号，跨文档互不串）。
  const sessions = new SessionManager()

  const pythonPath = fm => {
    const declared = frontMatterValue(fm, "PYTHON_PATH", "python")
    const configured = String(declared ?? config.PYTHON_PATH ?? "").trim()
    if (!configured) return null
    const candidate = path.isAbsolute(configured) ? configured : path.resolve(configured)
    return fs.existsSync(candidate) ? candidate : null
  }

  return {
    family: "python",
    langs: (config.LANGS ?? ["python", "py"]).map(x => String(x).toLowerCase()),

    checkRuntime(ctx) {
      return pythonPath(ctx.doc.fm)
        ? { ok: true }
        : { ok: false, message: "没有可用的 Python：请在引擎配置 python.PYTHON_PATH 指定解释器（或文档 front-matter code-exec.python.PYTHON_PATH 按文档钉死）" }
    },

    runOpts(ctx) {
      return { dpi: config.DPI ?? 150, timeout: config.TIMEOUT ?? 60000 }
    },

    run: async (source, opts = {}) => {
      const fm = opts.doc?.fm ?? {}
      if (opts.session?.key) {
        return sessionRun({
          manager: sessions,
          ctx: opts.session,
          create: workdir => createPythonSession({
            pythonPath: pythonPath(fm),
            dpi: config.DPI ?? 150,
            workdir,
          }),
          source,
          opts,
        })
      }
      return runPython(pythonPath(fm), source, opts)
    },

    /** ⟳ 销毁会话：下次运行重建（物化与引导块重新执行），命名空间归零。 */
    resetSession: ctx => { if (ctx?.key) sessions.destroy(ctx.key, "manual") },
    dispose: () => sessions.destroyAll("dispose"),
  }
}

module.exports = { create }
