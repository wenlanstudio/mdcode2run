"use strict"
/**
 * Hive 远程执行器——本机没有 beeline（Windows / 未装 Hive 发行版）时，经 SSH 免密
 * 把查询送到集群节点的 beeline 上跑，结构化行列原样回到结果契约。
 *
 * 与 runners/hive.js 的关系：共用 buildJdbcUrl / parseBeelineTsv，只换「怎么起进程」。
 * 连接参数（HOST/PORT/DATABASE/USER/JDBC_URL）是**远端视角**——HS2 常监听在节点的
 * localhost:10000，本机根本连不到，所以不要求本机有 JDBC 通道。
 *
 * 为什么不把 SQL 拼进 ssh 命令行：讲义里的 HiveQL 常有中文、单引号、反引号、换行，
 * 要经过 cmd.exe → ssh → 远端 shell 三层解析，任何一层都会把引号吃掉。这里改成
 * SQL 写 ssh 的 stdin，远端 `beeline -f /dev/stdin` 直接读，零转义。
 *
 * `--silent=true` 抑制 beeline 的 Connecting/Connected/Driver/进度点等横幅，
 * 让 tsv2 输出第一行就是表头（parseBeelineTsv 才认得）。
 */

const { spawn } = require("child_process")
const { buildJdbcUrl, parseBeelineTsv } = require("./hive")

const MAX_TEXT = 20000

/** POSIX 单引号转义：' → '\'' 。ssh 的远程命令最终由远端 sh 解析。 */
const shellQuote = s => `'${String(s).replace(/'/g, "'\\''")}'`

/** ssh 客户端把「非后量子密钥交换」告警泄到 stderr，不是查询失败，别混进错误文本。 */
const filterSshNoise = text => String(text ?? "").split(/\r?\n/)
  .filter(line => !/post-quantum|store now, decrypt later|openssh\.com\/pq\.html|^\*\* This session may be vulnerable/i.test(line))
  .join("\n")
  .trim()

/**
 * 远端 beeline 命令（不含可执行名 ssh）。`-f /dev/stdin` 让 SQL 走 stdin。
 * 外层 `timeout` 是远端侧的兜底：本地 kill 只杀 ssh，远端 beeline 会变孤儿继续跑。
 */
const remoteCommand = (o = {}, timeoutMs = 30000) => {
  const client = String(o.clientPath || "beeline").trim()
  const parts = [client, "-u", buildJdbcUrl(o)]
  if (o.user && String(o.user).trim()) parts.push("-n", String(o.user).trim())
  if (o.password) parts.push("-p", String(o.password))
  parts.push("--silent=true", "--outputformat=tsv2", "-f", "/dev/stdin")
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000))
  return `timeout ${secs}s ${parts.map(shellQuote).join(" ")}`
}

/** ssh 参数（不含可执行名）。-T 不分配 tty，BatchMode 免密失败立刻返回不挂起。 */
const sshArgs = (o = {}, timeoutMs = 30000) => {
  const host = String(o.sshHost || "").trim()
  const user = String(o.sshUser || "").trim()
  const target = user ? `${user}@${host}` : host
  const args = [
    "-T",
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${Math.min(15, Math.max(3, Math.ceil(timeoutMs / 1000)))}`,
    "-o", "StrictHostKeyChecking=accept-new",
  ]
  if (o.sshPort) args.push("-p", String(o.sshPort))
  if (Array.isArray(o.sshOptions)) args.push(...o.sshOptions.map(String))
  args.push(target, remoteCommand(o, timeoutMs))
  return args
}

/** `-f` 读的脚本要求语句以分号收尾；讲义里偶有省略，补一个不改动原语义。 */
const asScript = sql => {
  const body = String(sql ?? "").replace(/\s+$/, "")
  return body ? (body.endsWith(";") ? body + "\n" : body + ";\n") : "\n"
}

/** spawn 失败（PATH 上没 ssh / 显式路径写错）→ 人话，别把 ENOENT 丢给观众。 */
const explainSpawn = (exe, err) => {
  const code = err?.code ?? ""
  if (code === "ENOENT") {
    return `找不到 ssh 客户端：${exe}（本机未安装 OpenSSH，或引擎配置 hive.SSH_BIN 路径有误）`
  }
  if (code === "EACCES" || code === "EPERM") {
    return `ssh 客户端不可执行：${exe}（${code}）`
  }
  return `启动 ssh 失败：${err?.message ?? String(err)}`
}

/**
 * 跑一个 Hive 块。契约与 runHive 完全一致：{ ok, kind, rows?, stdout, text, error }。
 * @param {{ sql: string }} args
 * @param {{ sshHost, sshUser?, sshPort?, sshBin?, sshOptions?, clientPath?,
 *           jdbcUrl?, host?, port?, database?, user?, password?, auth?,
 *           timeout?: number, onChunk?: Function }} opts
 */
const runHiveSsh = async (args, opts = {}) => {
  const timeout = Number(opts.timeout ?? 30000)
  const exe = String(opts.sshBin || "ssh").trim()
  const argv = sshArgs(opts, timeout)
  // Windows 上 Git Bash 自带的 ssh.exe 是 MSYS 程序，会把 argv 里形如 '/opt/...' 的
  // 远端路径自动改写成 'D:/.../opt/...'。禁掉它的参数转换，远端路径才是原样。
  const env = { ...process.env }
  if (process.platform === "win32") env.MSYS2_ARG_CONV_EXCL = "*"
  const { stdout, stderr, code, timedOut, spawnError } = await new Promise(resolve => {
    const child = spawn(exe, argv, { windowsHide: true, env })
    // spawn 立即失败（ssh 不在 PATH）时管道可能还没建起来，全程可选链兜住。
    child.stdout?.setEncoding("utf8")
    child.stderr?.setEncoding("utf8")
    let stdout = "", stderr = "", timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout + 5000)
    child.stdout?.on("data", c => {
      if (stdout.length < MAX_TEXT) stdout += c
      opts.onChunk?.({ stream: "stdout", text: c })
    })
    child.stderr?.on("data", c => {
      if (stderr.length < MAX_TEXT) stderr += c
      opts.onChunk?.({ stream: "stderr", text: c })
    })
    child.on("error", err => {
      clearTimeout(timer)
      resolve({ stdout: "", stderr: "", code: -1, timedOut: false, spawnError: explainSpawn(exe, err) })
    })
    child.on("close", c => { clearTimeout(timer); resolve({ stdout, stderr, code: c, timedOut }) })
    // SQL 只走 stdin：引号/换行/中文都不经任何一层 shell 解析。
    child.stdin?.on("error", () => { /* 远端提前退出时 stdin 会 EPIPE，close 里已有 code */ })
    child.stdin?.end(asScript(args.sql))
  })

  if (spawnError) return { ok: false, kind: "none", stdout: "", text: "", error: spawnError }
  if (code !== 0) {
    const detail = filterSshNoise(stderr) || filterSshNoise(stdout)
    return {
      ok: false,
      kind: "none",
      stdout: "",
      text: "",
      error: timedOut
        ? `Hive 执行超时（${timeout}ms）`
        : (code === 124 ? `Hive 执行超时（远端 timeout ${Math.ceil(timeout / 1000)}s）` : (detail || `ssh/beeline 退出码 ${code}`)),
    }
  }

  const { columns, cells, extra } = parseBeelineTsv(stdout)
  const kind = columns.length ? "table" : (stdout.trim() || extra.trim() ? "text" : "none")
  return {
    ok: true,
    kind,
    ...(columns.length ? { rows: { columns, cells } } : {}),
    stdout,
    text: extra,
    error: "",
  }
}

module.exports = { runHiveSsh, sshArgs, remoteCommand, shellQuote, filterSshNoise, asScript }
