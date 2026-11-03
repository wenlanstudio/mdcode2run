"use strict"
/**
 * Hive 查询原型（query 家族方言）——```hive / ```hql 块经本机 beeline（Hive JDBC CLI）
 * 一次性执行，结果按结构化行列（rows）回来，与 mysql 同族（见 runners/query.js）。
 *
 * 状态活在 HiveServer2 服务端，beeline 一次性来去——不做常驻会话，⏩ 与 ▶ 等价。
 *
 * 连接：front-matter `code-exec.hive.*` 可覆盖 HOST / PORT / DATABASE / USER / JDBC_URL
 * （讲义自包含：这篇课连哪个 HS2 写在哪篇里）；PASSWORD 例外——秘密只放引擎配置层，
 * 前言层无权携带。也可直接给完整 JDBC_URL（含 Kerberos principal 等），覆盖按
 * HOST/PORT 拼的默认 URL。
 */

const { spawn } = require("child_process")

const MAX_TEXT = 20000
const MAX_ROWS = 2000

/**
 * 跳过头部的 beeline 横幅 / 告警行。连不上、日志框架（SLF4J/log4j）噪声常泄到 stdout，
 * 不是表头；命中模式即从头部丢弃，直到遇到第一行非噪声行为止。
 */
const BANNER_RE = /^(WARNING|Connecting|Connected|SLF4J|log4j|java\.|Scanning|NOTE|Loading|Using)/i

/**
 * 解析 beeline `--outputformat=tsv2` 输出：首行表头，其后是与表头等列数的行。
 * tsv2 不转义（与 mysql --batch 不同），NULL 字面量为 "NULL"（渲染层按 NULL 弱化显示）。
 * 等列数不再成立时视为第二个结果集 / 尾部噪声（如 "N rows selected"），进 extra。
 * @returns {{ columns: string[], cells: string[][], extra: string }}
 */
const parseBeelineTsv = output => {
  const lines = String(output ?? "").split(/\r?\n/)
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop()
  while (lines.length && BANNER_RE.test(lines[0])) lines.shift()
  if (!lines.length) return { columns: [], cells: [], extra: "" }
  const columns = lines[0].split("\t")
  const width = columns.length
  const cells = []
  let i = 1
  for (; i < lines.length; i++) {
    const raw = lines[i].split("\t")
    if (raw.length !== width) break
    cells.push(raw)
  }
  return { columns, cells: cells.slice(0, MAX_ROWS), extra: lines.slice(i).join("\n") }
}

/** 拼 JDBC URL：显式 JDBC_URL 优先；否则按 host:port/db 拼默认，auth 段追加其后。 */
const buildJdbcUrl = o => {
  if (o.jdbcUrl && String(o.jdbcUrl).trim()) return String(o.jdbcUrl).trim()
  const host = (o.host == null || String(o.host).trim() === "") ? "localhost" : String(o.host).trim()
  const port = (o.port == null || o.port === "") ? 10000 : o.port
  const db = (o.database == null || String(o.database).trim() === "") ? "default" : String(o.database).trim()
  let url = `jdbc:hive2://${host}:${port}/${db}`
  const auth = String(o.auth ?? "").trim()
  if (auth) url += auth.startsWith(";") ? auth : `;${auth}`
  return url
}

/** beeline 命令行参数（不含可执行名）。 */
const beelineArgs = o => {
  const url = buildJdbcUrl(o)
  const args = ["-u", url]
  if (o.user && String(o.user).trim()) args.push("-n", String(o.user).trim())
  if (o.password) args.push("-p", String(o.password))   // 空密码不传 -p，避免 beeline 交互提示
  args.push("--outputformat=tsv2", "-e", o.sql)
  return args
}

/**
 * 跑一个 Hive 块。契约：{ ok, kind: "table"|"text"|"none", rows?, stdout, text, error }。
 * @param {{ sql: string }} args
 * @param {{ clientPath?: string, jdbcUrl?, host?, port?, database?, user?, password?,
 *           auth?, timeout?: number, onChunk?: Function }} opts
 */
const runHive = async (args, opts = {}) => {
  const exe = opts.clientPath || "beeline"
  const timeout = Number(opts.timeout ?? 30000)
  const procArgs = beelineArgs({ ...opts, sql: args.sql })
  const { stdout, stderr, code, timedOut } = await new Promise((resolve, reject) => {
    const child = spawn(exe, procArgs, { windowsHide: true })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    let stdout = "", stderr = "", timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout)
    child.stdout.on("data", c => {
      if (stdout.length < MAX_TEXT) stdout += c
      opts.onChunk?.({ stream: "stdout", text: c })
    })
    child.stderr.on("data", c => {
      if (stderr.length < MAX_TEXT) stderr += c
      opts.onChunk?.({ stream: "stderr", text: c })
    })
    child.on("error", err => { clearTimeout(timer); reject(err) })
    child.on("close", c => { clearTimeout(timer); resolve({ stdout, stderr, code: c, timedOut }) })
  })

  if (code !== 0) {
    const detail = (stderr || stdout || "").trim()
    return {
      ok: false,
      kind: "none",
      stdout: "",
      text: "",
      error: timedOut ? `Hive 执行超时（${timeout}ms）` : (detail || `beeline 退出码 ${code}`),
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

module.exports = { runHive, parseBeelineTsv, buildJdbcUrl, beelineArgs, MAX_ROWS }
