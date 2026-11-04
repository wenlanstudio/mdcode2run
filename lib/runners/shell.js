/**
 * runners/shell.js —— 一次性（非交互）执行 shell 代码块。
 *
 * 与 python/java 的 runner 同构：spawn / ssh exec 实时管道，stdout/stderr 按 chunk 外发，
 * 结构化结果走返回值。**不做交互式终端**：没有 pty、没有持久会话、没有 stdin 交互。
 * 每个代码块都是一次性的——本地 `bash -c` 或远端 `ssh2 exec`，跑完即断。
 *
 * 从旧交互式 shell 保留下来的四项能力，讲义正是靠它们工作：
 *   1) parsePromptTarget：从 `[zhangsan@node0 ~]$` 解析 user/host——目标主机写在块里
 *   2) prepareScript：剥掉提示符前缀（**不剥的话每条命令都会语法错**，这是最关键的一条）
 *   3) 远端 SSH 执行：ssh2 是纯 JS，不是原生模块，保留它不影响可移植性
 *   4) sudoFeed：把 `sudo xxx` 改写成喂密码的形式——没有 tty 时的必要变通，不是 bug
 *
 * 纯 Node：不依赖 DOM。
 */

const fs = require("fs")
const os = require("os")
const path = require("path")
const { spawn } = require("child_process")

const DEFAULT_LOCAL_TIMEOUT = 60000
const DEFAULT_REMOTE_TIMEOUT = 60000
const DEFAULT_CONNECT_TIMEOUT = 15000
/** 输出上限：讲义里的 `hdfs dfsadmin -report` 之类可能很长，截断避免撑爆卡片。 */
const DEFAULT_MAX_CHARS = 20000

const HOST_KEYS = new Set(["host", "hostname", "ssh_host", "remote_host"])
const USER_KEYS = new Set(["user", "username", "ssh_user", "remote_user"])

// ── 提示符解析与剥离 ────────────────────────────────────────────────────

/** 从代码块里的 `[zhangsan@node1 subdir0]$` 式提示符提取 user/host。 */
const parsePromptTarget = raw => {
  const m = /\[\s*([\w.-]+)@([\w.-]+)[^\]]*\]/.exec(String(raw ?? ""))
  return m ? { user: m[1], host: m[2] } : { user: "", host: "" }
}

/**
 * 剥掉文档式提示符前缀。括号内必须含 @（[zhangsan@node1 …]$ / [root@node1 …]#），
 * 不会误伤普通注释；行首裸 `$ ` 也是提示符（bash 里 `$` 开头本就不是合法命令）。
 * PowerShell 的 `PS C:\path>` 要求提示符那段含路径特征，否则会误伤合法命令。
 * `(base) ` 这类环境前缀（conda/venv）可出现在括号提示符之前。
 */
const prepareScript = (raw, { stripPrompts = true } = {}) => {
  if (!raw) return null
  const lines = String(raw).split(/\r?\n/).map(line => {
    if (!stripPrompts) return line
    line = line.replace(/^(\s*)(?:\([\w-]+\)\s*)?\[[^@\]]+@[^\]]*\]\s*[$#]?\s*/, "$1")
    line = line.replace(/^(\s*)\$\s+/, "$1")
    return line.replace(/^(\s*)PS\s+[^>\r\n]*[\/\\:~][^>]*>\s*/, "$1")
  })
  return lines.join("\n").trim() || null
}

/**
 * `sudo xxx` → `printf '%s\n' <pw> | sudo -S -p '' xxx`。
 * 远端非 root 登录且拿不到 tty 时，不这么改写 sudo 会直接失败。
 */
const sudoFeed = (script, password, user) => {
  if (!script || !password || user === "root") return script
  return String(script).split(/\r?\n/).map(line => {
    const m = /^(\s*)sudo\s+(.+)$/.exec(line)
    if (!m) return line
    const [, indent, cmd] = m
    return `${indent}printf '%s\\n' '${password}' | sudo -S -p '' ${cmd}`
  }).join("\n")
}

// ── front-matter 解析（host / user / 凭据）──────────────────────────────

/** 解析 md 的 front-matter：host / user，以及 `用户名: 密码` 形式的凭据。 */
const parseFrontMatter = md => {
  const result = { host: "", user: "", credentials: new Map() }
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(String(md ?? ""))
  if (!match) return result
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    // 空值 / 含空格的值（title、date、带引号串）一律不当凭据
    if (!value || /\s/.test(value)) continue
    const lower = key.toLowerCase()
    if (HOST_KEYS.has(lower)) result.host = value
    else if (USER_KEYS.has(lower)) result.user = value
    else if (!result.credentials.has(key)) result.credentials.set(key, value)
  }
  return result
}

/** 决定这一块跑本地还是远端；返回 { mode } 或 { error }。 */
const resolveTarget = ({ raw, config = {}, frontMatter = {} }) => {
  const prompt = (config.STRIP_PROMPTS ?? true) ? parsePromptTarget(raw) : { user: "", host: "" }
  const mode = String(config.MODE ?? "auto").toLowerCase()
  const host = (prompt.host || frontMatter.host || String(config.HOST ?? "").trim() || "").trim()
  if (mode === "local") return { mode: "local" }
  if (!host) {
    if (mode === "remote") {
      return { error: "MODE=remote 但无法确定主机：请在代码块里加 `[user@host …]$` 提示符，或在 shell.HOST" }
    }
    return { mode: "local" }   // auto：解析不出 host 就本机跑
  }
  const user = prompt.user || String(config.USER ?? "").trim() || frontMatter.user || [...frontMatter.credentials.keys()][0] || ""
  if (!user) {
    return { error: "远程执行需要用户名：请在代码块里加 `[user@host …]$` 提示符，或在 shell.USER" }
  }
  const creds = frontMatter.credentials ?? new Map()
  const password = creds.get(user) ?? creds.get(String(user).toLowerCase()) ?? String(config.PASSWORD ?? "").trim() ?? ""
  return { mode: "remote", host, port: Number(config.PORT ?? 22) || 22, user, password }
}

// ── 本机 bash 定位 ──────────────────────────────────────────────────────

/**
 * 找本机 bash。Git Bash 必须排在 PATH 前面：PATH 里靠前的常是
 * %LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe —— 那是 WSL 的应用执行别名（0 字节存根），
 * spawn 出来既不干活也不输出。
 */
const findLocalShell = config => {
  const configured = String(config.LOCAL_SHELL ?? "").trim()
  if (configured) return configured
  const exe = process.platform === "win32" ? "bash.exe" : "bash"
  const candidates = []
  for (const root of [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], "C:\\Program Files"].filter(Boolean)) {
    candidates.push(path.join(root, "Git", "bin", exe))
    candidates.push(path.join(root, "Git", "usr", "bin", exe))
  }
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    if (/WindowsApps/i.test(dir)) continue
    candidates.push(path.join(dir, exe))
  }
  return candidates.find(c => { try { return fs.existsSync(c) } catch { return false } }) ?? null
}

// ── 执行 ────────────────────────────────────────────────────────────────

const cap = (text, maxChars) => {
  if (!text || text.length <= maxChars) return text
  return text.slice(0, maxChars) + "\n...（已截断）"
}

/** 本机一次性执行：`bash -c <script>`。 */
const runLocal = (script, { config = {}, cwd, onChunk }) => {
  const shell = findLocalShell(config)
  if (!shell) {
    throw new Error("未找到 bash：请安装 Git Bash，或在 shell.LOCAL_SHELL 指向 bash.exe")
  }
  const timeout = Number(config.LOCAL_TIMEOUT ?? DEFAULT_LOCAL_TIMEOUT) || DEFAULT_LOCAL_TIMEOUT
  const maxChars = Number(config.MAX_OUTPUT_CHARS ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS
  return new Promise((resolve, reject) => {
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      proc.kill()
      resolve({ ok: false, code: -1, stdout: cap(stdout, maxChars), stderr: cap(stderr, maxChars), note: `超时（>${Math.round(timeout / 1000)}s），已终止` })
    }, timeout)
    const proc = spawn(shell, ["-c", script], { cwd: cwd || process.cwd(), windowsHide: true })
    // setEncoding 而非 chunk.toString("utf8")：后者会在 chunk 边界切坏多字节字符
    proc.stdout.setEncoding("utf8")
    proc.stderr.setEncoding("utf8")
    proc.stdout.on("data", chunk => {
      if (stdout.length <= maxChars) stdout += chunk
      onChunk?.({ stream: "stdout", text: chunk })
    })
    proc.stderr.on("data", chunk => {
      if (stderr.length <= maxChars) stderr += chunk
      onChunk?.({ stream: "stderr", text: chunk })
    })
    proc.on("error", err => { clearTimeout(timer); reject(err) })
    proc.on("close", (code, signal) => {
      if (settled) return
      clearTimeout(timer)
      const exit = code ?? (signal ? -1 : 0)
      resolve({ ok: exit === 0, code: exit, stdout: cap(stdout, maxChars), stderr: cap(stderr, maxChars), note: "" })
    })
  })
}

// ── 远端 SSH（ssh2，纯 JS）──────────────────────────────────────────────

// ssh2 是纯 JS（不是原生模块），作为正式 npm 依赖随包分发——不再外挂 shell_exec_lib 目录。
const loadSsh2 = () => {
  try { return require("ssh2") }
  catch (error) {
    console.warn("[shell] ssh2 unavailable:", error?.message ?? error)
    return null
  }
}

/** ~/.ssh 里第一把默认私钥。 */
const defaultPrivateKey = () => {
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const file = path.join(os.homedir(), ".ssh", name)
    try { if (fs.existsSync(file)) return fs.readFileSync(file) }
    catch { /* unreadable → next candidate */ }
  }
  return null
}

/**
 * ssh2 的 `agent` 只接受 socket/管道路径或 'pageant'（没有 true 自动探测）。
 * Windows：OpenSSH agent 的命名管道，其次 Pageant；其他平台：SSH_AUTH_SOCK。
 */
const agentPath = () => {
  if (process.platform === "win32") {
    const pipe = "\\\\.\\pipe\\openssh-ssh-agent"
    try { if (fs.existsSync(pipe)) return pipe } catch { /* pipe stat failed */ }
    return "pageant"
  }
  return process.env.SSH_AUTH_SOCK || ""
}

const connectOnce = (ssh2, target, authCfg, timeout) => new Promise((resolve, reject) => {
  const { Client } = ssh2
  const conn = new Client()
  // 'keyboard-interactive' 只是把 prompt 转成事件发出来，必须自己接管应答
  // （用同一个密码回答所有 prompt），否则认证挂起到超时
  if (authCfg.password) {
    conn.on("keyboard-interactive", (name, instructions, lang, prompts, finish) => {
      finish((prompts ?? []).map(() => authCfg.password))
    })
  }
  const cleanup = () => {
    clearTimeout(timer)
    conn.removeListener("ready", onReady)
    conn.removeListener("error", onError)
  }
  const timer = setTimeout(() => {
    cleanup()
    conn.end()
    reject(new Error(`连接 ${target.user}@${target.host}:${target.port} 超时（>${Math.round(timeout / 1000)}s）`))
  }, timeout)
  const onReady = () => { cleanup(); resolve(conn) }
  const onError = err => { cleanup(); try { conn.end() } catch { /* not connected */ } reject(err) }
  conn.on("ready", onReady).on("error", onError)
  conn.connect({ host: target.host, port: target.port, username: target.user, readyTimeout: timeout, ...authCfg })
})

/** 免密优先（agent/私钥），失败再回退密码。 */
const connectRemote = async (ssh2, target, timeout) => {
  const attempts = []
  const agent = agentPath()
  const key = defaultPrivateKey()
  if (agent || key) {
    attempts.push({
      label: "免密登录（agent/私钥）",
      cfg: {
        ...(agent ? { agent } : {}),
        ...(key ? { privateKey: key } : {}),
        authHandler: [...(agent ? ["agent"] : []), "publickey"],
      },
    })
  }
  if (target.password) {
    attempts.push({
      label: `密码登录（${target.user}）`,
      cfg: { password: target.password, tryKeyboard: true, authHandler: ["password", "keyboard-interactive"] },
    })
  }
  if (!attempts.length) {
    throw new Error("既没有可用的免密凭据（agent/私钥），也没有可用的密码（frontmatter 或引擎配置 shell.PASSWORD），无法连接")
  }
  const errors = []
  for (const { label, cfg } of attempts) {
    try {
      const conn = await connectOnce(ssh2, target, cfg, timeout)
      conn.authLabel = label
      return conn
    } catch (error) {
      errors.push(`${label} → ${error?.message ?? error}`)
    }
  }
  const hint = target.password ? "" : "\n（未配置该用户的密码，只试了免密）"
  throw new Error(`SSH 连接失败：\n${errors.join("\n")}${hint}`)
}

/** 远端一次性执行：`conn.exec(command)`，跑完即断。 */
const runRemote = async (script, target, { config = {}, onChunk }) => {
  const ssh2 = loadSsh2()
  if (!ssh2) throw new Error("SSH 库未安装：请在 mdcode2run 目录下执行 `npm install ssh2`")
  const command = (config.SUDO_PASSWORD_FEED ?? true) ? sudoFeed(script, target.password, target.user) : script
  const timeout = Number(config.REMOTE_TIMEOUT ?? DEFAULT_REMOTE_TIMEOUT) || DEFAULT_REMOTE_TIMEOUT
  const connectTimeout = Number(config.CONNECT_TIMEOUT ?? DEFAULT_CONNECT_TIMEOUT) || DEFAULT_CONNECT_TIMEOUT
  const maxChars = Number(config.MAX_OUTPUT_CHARS ?? DEFAULT_MAX_CHARS) || DEFAULT_MAX_CHARS
  const conn = await connectRemote(ssh2, target, connectTimeout)
  try {
    return await new Promise((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      let settled = false
      const timer = setTimeout(() => {
        settled = true
        conn.end()
        resolve({ ok: false, code: -1, stdout: cap(stdout, maxChars), stderr: cap(stderr, maxChars), note: `超时（>${Math.round(timeout / 1000)}s），已断开` })
      }, timeout)
      // pty: false —— 一次性执行不需要终端，也拿不到 tty
      conn.exec(command, { pty: false }, (err, stream) => {
        if (err) { clearTimeout(timer); return reject(err) }
        stream.setEncoding("utf8")
        stream.stderr.setEncoding("utf8")
        stream.on("data", chunk => {
          if (stdout.length <= maxChars) stdout += chunk
          onChunk?.({ stream: "stdout", text: chunk })
        })
        stream.stderr.on("data", chunk => {
          if (stderr.length <= maxChars) stderr += chunk
          onChunk?.({ stream: "stderr", text: chunk })
        })
        stream.on("close", (code, signal) => {
          if (settled) return
          clearTimeout(timer)
          conn.end()
          const exit = code ?? (signal ? -1 : 0)
          resolve({ ok: exit === 0, code: exit, stdout: cap(stdout, maxChars), stderr: cap(stderr, maxChars), note: "" })
        })
      })
    })
  } finally {
    try { conn.end() } catch { /* already closed */ }
  }
}

/**
 * 一次性执行一个 shell 代码块。
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string, note:string}>}
 */
const runShell = async (script, { target = { mode: "local" }, config = {}, cwd, onChunk } = {}) => {
  if (target.error) throw new Error(target.error)
  return target.mode === "remote"
    ? runRemote(script, target, { config, onChunk })
    : runLocal(script, { config, cwd, onChunk })
}

module.exports = {
  runShell,
  parsePromptTarget,
  prepareScript,
  sudoFeed,
  parseFrontMatter,
  resolveTarget,
  findLocalShell,
}
