"use strict"
/**
 * Shell 语言模块——```bash / ```sh / ```shell 块的执行策略。
 *
 * **一次性（非交互）**：没有 pty、没有面板输入行、没有持久会话。本地 `bash -c` 或
 * 远端 `ssh2 exec`，跑完即断。讲义里跨块的依赖应当是"数据状态"（如 HDFS 上的文件），
 * 而不是 shell 会话状态。会话上下文在此只贡献一件事：章工作目录（file= 物化的材料
 * 在那里，作业也跑在那里）。
 */

const { runShell, prepareScript, resolveTarget, parseFrontMatter, findLocalShell } = require("../runners/shell")
const { startJob } = require("../runners/job")
const { chapterWorkdir } = require("../session-run")

const create = ({ config = {} } = {}) => ({
  family: "shell",
  langs: (config.LANGS ?? ["bash", "sh", "shell"]).map(x => String(x).toLowerCase()),

  checkRuntime() {
    const mode = String(config.MODE ?? "auto").toLowerCase()
    const host = String(config.HOST ?? "").trim()
    if (mode === "remote") return { ok: true }   // 连不上的具体原因留给执行时报错
    if (findLocalShell(config)) return { ok: true }
    if (mode === "local" || !host) {
      return { ok: false, message: "未找到 bash：请安装 Git Bash，或在引擎配置 shell.LOCAL_SHELL 指向 bash.exe" }
    }
    return { ok: true }   // auto + 配了 HOST：可以走远端
  },

  runOpts: () => ({}),

  run: async (source, opts = {}) => {
    const doc = opts.doc ?? {}
    const script = prepareScript(source, { stripPrompts: config.STRIP_PROMPTS ?? true })
    if (!script) {
      return { ok: false, kind: "none", stdout: "", text: "", error: "代码块为空（剥掉提示符后没有可执行的命令）" }
    }
    const frontMatter = parseFrontMatter(doc.md ?? "")
    const target = resolveTarget({ raw: source, config, frontMatter })
    // job 模式（```bash job）：异步启动本机长任务，立即返回句柄——日志持续外发，
    // 终止按钮是消费者的 UI 事。作业跑在章工作目录（file= 物化的材料就在那里）；
    // 远端作业是 tunnel×job 的合流，杀 ssh 连接是假终止，v1 不做、如实报错。
    if (opts.meta?.job) {
      if (target.mode === "remote") {
        return { ok: false, kind: "none", stdout: "", text: "", error: "作业模式暂只支持本机执行——远端作业请去掉 job 标注按一次性执行（终止远端进程是假终止）" }
      }
      const workdir = opts.session?.workdirKey ? chapterWorkdir(opts.session.workdirKey) : doc.dir
      return startJob({ script, config, cwd: workdir, onLog: opts.onChunk })
    }
    const result = await runShell(script, {
      target,
      config,
      cwd: doc.dir || undefined,
      onChunk: opts.onChunk,
    })
    const where = target.mode === "remote" ? `远端 ${target.user}@${target.host}` : "本机"
    return {
      ok: result.ok,
      kind: result.stdout ? "text" : "none",
      stdout: result.stdout,
      text: [where, `退出码 ${result.code}`, result.note].filter(Boolean).join(" · "),
      error: result.ok ? "" : (result.stderr || result.note || `退出码 ${result.code}`),
    }
  },

  // shell 无常驻会话，⟳ 无事可做；接口留空保持四模块同构
  resetSession: () => {},
  dispose: () => {},
})

module.exports = { create }
