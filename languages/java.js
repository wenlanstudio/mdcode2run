"use strict"
/**
 * Java 语言模块——```jshell / ```java 块的执行策略（原 plugins/java.js 去掉插件壳）。
 *
 * 跑法像 jshell：写了什么表达式，就看到它的值（执行走 jdk.jshell 的 API 而不是
 * `jshell` 命令行——见 runners/java.js）。有会话上下文走常驻 JShell——同章的块共享
 * 同一个状态世界：file= 物化、setup 自动引导、过期链、重放都在 sessionRun 编排；
 * 没有会话上下文退回一次性执行，行为与从前完全一致。
 */

const { runJava, inspectJavaHome, expandClassPath } = require("../runners/java")
const { createJShellSession } = require("../runners/java-session")
const { SessionManager } = require("../sessions")
const { sessionRun } = require("../session-run")
const { frontMatterValue } = require("../front-matter")

const create = ({ config = {} } = {}) => {
  const sessions = new SessionManager()

  /**
   * JAVA_HOME 的优先级：
   *   1. 当前文档 front-matter `code-exec.java.JAVA_HOME`（文档级默认）
   *   2. 当前文档 front-matter 顶层 JAVA_HOME（旧写法，仍认）
   *   3. 引擎配置 java.JAVA_HOME
   *   4. 系统环境变量 JAVA_HOME
   * 值可以写 JDK 根目录（`.../jdk-17`），也可以直接写 bin 目录（`.../jdk-17/bin`）。
   */
  const javaHome = fm => {
    const declared = frontMatterValue(fm, "JAVA_HOME", "java")
    if (declared) return declared
    const configured = String(config.JAVA_HOME ?? "").trim()
    if (configured) return configured
    return String(process.env.JAVA_HOME ?? "").trim() || null
  }

  /**
   * class-path 的优先级：front-matter `code-exec.java.class-path` → 前言顶层（旧写法）→
   * 引擎配置 java.CLASS_PATH。键名抄 `java --class-path`（工具链的写法），大小写不敏感；
   * 值可以是 `;` 分隔的字符串，也可以是数组；`dir/*` 的展开在 runners/java.js 里做。
   */
  const classPath = fm => {
    const declared = frontMatterValue(fm, "class-path", "java")
    if (declared != null && declared !== "") return declared
    const configured = config.CLASS_PATH
    if (Array.isArray(configured)) return configured.length ? configured : ""
    return String(configured ?? "").trim()
  }

  /** 相对 class-path 的基准目录 = 文档所在目录；没有就保持相对，交给进程 cwd。 */
  const docDir = ctx => ctx?.doc?.dir ?? ""

  return {
    family: "java",
    // LANGS 默认带上 "java"：讲义标本用 java 标注走 jshell 会话（原插件靠 settings.toml 补）
    langs: (config.LANGS ?? ["jshell", "java"]).map(x => String(x).toLowerCase()),

    checkRuntime(ctx) {
      const home = javaHome(ctx?.doc?.fm ?? {})
      if (!home) {
        return {
          ok: false,
          message: "没有可用的 JDK：请在文档 front-matter 写 JAVA_HOME，或设系统环境变量 JAVA_HOME"
            + "（也可在引擎配置 java.JAVA_HOME 指定）",
        }
      }
      const { javaExe, jshellExe } = inspectJavaHome(home)
      if (!javaExe) return { ok: false, message: `JAVA_HOME 下找不到 java：${home}` }
      // jshell 随 JDK 9 引入；harness 还要靠 JDK 11+ 的单文件源码启动，所以门槛定在 11。
      if (!jshellExe) return { ok: false, message: `该 JDK 不带 jshell，jshell 代码块需要 JDK 11 及以上：${home}` }
      return { ok: true }
    },

    runOpts(ctx) {
      return {
        timeout: config.TIMEOUT ?? 60000,
        classPath: expandClassPath(classPath(ctx?.doc?.fm ?? {}), docDir(ctx)),
      }
    },

    run: async (source, opts = {}) => {
      const fm = opts.doc?.fm ?? {}
      if (opts.session?.key) {
        return sessionRun({
          manager: sessions,
          ctx: opts.session,
          create: workdir => createJShellSession({
            javaExe: (() => {
              const home = javaHome(fm)
              return home ? inspectJavaHome(home).javaExe : null
            })(),
            classPath: expandClassPath(classPath(fm), opts.doc?.dir ?? ""),
            workdir,
          }),
          source,
          opts,
        })
      }
      const home = javaHome(fm)
      return runJava(home ? inspectJavaHome(home).javaExe : null, source, opts)
    },

    resetSession: ctx => { if (ctx?.key) sessions.destroy(ctx.key, "manual") },
    dispose: () => sessions.destroyAll("dispose"),
  }
}

module.exports = { create }
