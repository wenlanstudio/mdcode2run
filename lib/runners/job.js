/**
 * job 原型（DESIGN.md §5）：异步长任务——启动即返回，日志持续外发，可终止。
 *
 * 与 exec（跑到完）的本质区别：作业的常态是"不退出"（flume agent、kafka consumer、
 * Spark streaming）或"退出得很慢"（模型训练）。所以这里没有超时、不积累输出
 * （日志只转发给 onChunk，渲染层自己限流——跑了八小时的作业不该占八小时的内存），
 * 退出信息经 done 交给调用方。
 *
 * v1 只做本机（`bash -c`，复用 shell runner 的 findLocalShell）；远端作业属于
 * tunnel 原型与 job 的合流（杀进程=杀 ssh 连接是假终止，不做）。
 * Windows 终止：child.kill() 只杀 bash 包装进程，sleep 之类的子孙进程会继续持有
 * stdio 管道，close 迟迟不来（"假终止"）——所以走 `taskkill /T /F` 按 PID 杀整棵树。
 */
const { spawn } = require("child_process")
const { findLocalShell } = require("./shell")

let nextId = 1

/**
 * 启动一个作业。
 * @param {{ script: string, config?: object, cwd?: string, onLog?: (c:{stream:"stdout"|"stderr", text:string}) => void }} args
 * @returns {{ ok: true, kind: "job", text: string, job: { id, stop, done }}}
 *   done: Promise<{ code, signal, killed, durationMs }> —— 进程退出时兑现；
 *   stop(): 终止作业（done 以 killed:true 兑现）。
 * @throws 本机找不到 bash 时
 */
const startJob = ({ script, config = {}, cwd, onLog }) => {
  const shell = findLocalShell(config)
  if (!shell) throw new Error("未找到 bash：请安装 Git Bash，或在 shell.LOCAL_SHELL 指向 bash.exe")
  const startedAt = Date.now()
  const id = nextId++
  const child = spawn(shell, ["-c", script], { cwd: cwd || process.cwd(), windowsHide: true })
  child.stdout.setEncoding("utf8")
  child.stderr.setEncoding("utf8")
  child.stdout.on("data", chunk => onLog?.({ stream: "stdout", text: chunk }))
  child.stderr.on("data", chunk => onLog?.({ stream: "stderr", text: chunk }))
  let killed = false
  let settled = false
  let doneResolve
  const done = new Promise(resolve => { doneResolve = resolve })
  child.on("error", err => {
    if (settled) return
    settled = true
    doneResolve({ code: -1, signal: null, killed, durationMs: Date.now() - startedAt, error: String(err?.message ?? err) })
  })
  child.on("close", (code, signal) => {
    if (settled) return
    settled = true
    doneResolve({ code: code ?? (signal ? -1 : 0), signal, killed, durationMs: Date.now() - startedAt })
  })
  return {
    ok: true,
    kind: "job",
    text: `作业 #${id} 已启动（本机）`,
    job: {
      id,
      pid: child.pid,
      /** 终止作业；done 以 killed:true 兑现。重复调用无害。 */
      stop() {
        killed = true
        if (process.platform === "win32" && child.pid) {
          // 杀整棵树（见头注释）；作业已退出时 taskkill 报错无害
          try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }) } catch { /* gone */ }
        } else {
          try { child.kill() } catch { /* gone */ }
        }
      },
      done,
    },
  }
}

module.exports = { startJob }
