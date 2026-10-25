/**
 * query 原型（DESIGN.md §5）：SQL 片段 → 结构化行列。
 *
 * 与 eval/exec 的分工：查询的状态活在**数据库服务端**（建表、导数、USE），客户端可以
 * 一次性来去——所以这里不做常驻会话，每个块一次 CLI 调用（教学讲义的
 * "建表→导入→查询"序列天然成立）。`session`/`replay` 选项由 base 传入但此处忽略，
 * ⏩ 在 SQL 块上的行为与 ▶ 相同。
 *
 * 客户端与输出格式：
 *   mysql   `--batch`：TSV，首行表头；特殊字符转义为 \t \n \\，NULL 字面量——解析侧解码。
 *           （不用 --raw：值里真有换行/制表时 --raw 的表格直接散架，转义反而可解析。）
 *   sqlite3 `-json`：整个输出是一个 JSON 数组（空结果为空输出），无需解析 TSV。
 *
 * 结构化结果走契约新字段 `rows: { columns, cells }`（DESIGN §6 表格形态）；
 * stdout/text/error 沿用旧契约——附加输出（多结果集的后半段）进 text，错误进 error。
 */

const { spawn } = require("child_process")

const MAX_TEXT = 20000
const MAX_ROWS = 2000   // 失控的 SELECT 不该撑爆渲染：行数到顶即止（截断提示由渲染层补）

/** mysql --batch 的值转义解码：\\ \t \n \0；其余反斜杠序列原样保留。 */
const unescapeBatch = text => String(text ?? "").replace(/\\(.)/g, (_, c) => {
  switch (c) {
    case "0": return "\0"
    case "n": return "\n"
    case "t": return "\t"
    case "\\": return "\\"
    default: return `\\${c}`
  }
})

/**
 * 解析 mysql --batch 输出：首行表头，其后是与表头等列数的行。
 * 值已被转义，所以裸 \t 只可能是列分隔符——按裸 \t 切列是安全的。
 * 等列数不再成立时视为第二个结果集开始，余下行原样进 extra（"一个块一条 SELECT 为宜"）。
 * @returns {{ columns: string[], cells: string[][], extra: string }}
 */
const parseMysqlBatch = output => {
  const lines = String(output ?? "").split(/\r?\n/)
  while (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (!lines.length) return { columns: [], cells: [], extra: "" }
  const columns = lines[0].split("\t").map(unescapeBatch)
  const width = columns.length
  const cells = []
  let i = 1
  for (; i < lines.length; i++) {
    const raw = lines[i].split("\t")
    if (raw.length !== width) break
    cells.push(raw.map(unescapeBatch))
  }
  const extra = lines.slice(i).join("\n")
  return { columns, cells: cells.slice(0, MAX_ROWS), extra }
}

/** sqlite3 -json 输出：JSON 对象数组 → 列名取首行键序，空数组/空输出 = 无结果。 */
const parseSqliteJson = output => {
  const text = String(output ?? "").trim()
  if (!text) return { columns: [], cells: [], extra: "" }
  const objs = JSON.parse(text)
  if (!Array.isArray(objs) || !objs.length) return { columns: [], cells: [], extra: "" }
  const columns = Object.keys(objs[0])
  const cells = objs.slice(0, MAX_ROWS).map(o => columns.map(c => (o[c] == null ? null : String(o[c]))))
  return { columns, cells, extra: "" }
}

const CLIENTS = {
  mysql: {
    // 密码走 -p<password>：会出现在进程列表里——本机教学工具，与 mysql CLI 惯例一致；
    // 真要严格，上 ~/.my.cnf 或 socket，这里不做。
    args: o => [
      "--batch",
      `--default-character-set=${o.charset ?? "utf8mb4"}`,
      "-h", String(o.host ?? "127.0.0.1"),
      "-P", String(o.port ?? 3306),
      "-u", String(o.user ?? "root"),
      o.password ? `-p${o.password}` : "--skip-password",
      ...(o.database ? ["-D", String(o.database)] : []),
    ],
    parse: parseMysqlBatch,
  },
  sqlite3: {
    args: o => ["-json", "-header", ...(o.database ? [String(o.database)] : [":memory:"])],
    parse: parseSqliteJson,
  },
}

/**
 * 跑一个 SQL 块。契约：{ ok, kind: "table"|"text"|"none", rows?, stdout, text, error }。
 * @param {{ client?: "mysql"|"sqlite3", sql: string }} args
 * @param {{ clientPath?: string, host?, port?, user?, password?, database?, charset?,
 *           timeout?: number, onChunk?: Function }} opts
 */
const runQuery = async (args, opts = {}) => {
  const clientName = args.client ?? "mysql"
  const client = CLIENTS[clientName]
  if (!client) throw new Error(`未知的 SQL 客户端：${clientName}`)
  const exe = opts.clientPath || clientName
  const timeout = Number(opts.timeout ?? 30000)

  const { stdout, stderr, code, timedOut } = await new Promise((resolve, reject) => {
    const child = spawn(exe, client.args(opts), { windowsHide: true })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout)
    child.stdout.on("data", chunk => {
      if (stdout.length < MAX_TEXT) stdout += chunk
      opts.onChunk?.({ stream: "stdout", text: chunk })
    })
    child.stderr.on("data", chunk => {
      if (stderr.length < MAX_TEXT) stderr += chunk
      opts.onChunk?.({ stream: "stderr", text: chunk })
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
      error: timedOut ? `SQL 执行超时（${timeout}ms）` : (detail || `${clientName} 退出码 ${code}`),
    }
  }

  const { columns, cells, extra } = client.parse(stdout)
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

module.exports = { runQuery, parseMysqlBatch, unescapeBatch, parseSqliteJson, MAX_ROWS }
