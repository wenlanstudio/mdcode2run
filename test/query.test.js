/**
 * query 原型验收——`node query.test.js`。
 * 解析层（mysql --batch TSV / sqlite3 -json）用夹具逐条过；执行层用**真实 mysql CLI**
 * 测失败路径（本机无服务时"连不上"本身就是真实失败路径）；真实连接测试由环境变量
 * MDX_MYSQL_HOST / MDX_MYSQL_USER / MDX_MYSQL_PASSWORD 门控（可选 MDX_MYSQL_PORT / _DB）。
 */
const assert = require("assert")
const { spawnSync } = require("child_process")
const net = require("net")
const { parseMysqlBatch, unescapeBatch, parseSqliteJson, runQuery } = require("../runners/query")

let passed = 0
const failures = []
const t = (name, fn) => {
  try { fn(); passed += 1 } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}

// ---------- mysql --batch 解析 ----------
t("基本表：表头 + 两行", () => {
  const { columns, cells, extra } = parseMysqlBatch("word\tcount\na\t3\nb\t2\n")
  assert.deepEqual(columns, ["word", "count"])
  assert.deepEqual(cells, [["a", "3"], ["b", "2"]])
  assert.equal(extra, "")
})
t("空输出（DDL/DML）→ 无结果集", () => {
  const { columns, cells } = parseMysqlBatch("")
  assert.deepEqual(columns, [])
  assert.deepEqual(cells, [])
})
t("只有表头（SELECT 零行）→ 列在、行空", () => {
  const { columns, cells } = parseMysqlBatch("word\tcount\n")
  assert.deepEqual(columns, ["word", "count"])
  assert.deepEqual(cells, [])
})
t("值转义解码：\\t \\n \\\\ 还原为真字符，裸 \\t 只当列分隔符", () => {
  // 表头分隔符是真制表符；值里的制表符在 --batch 输出里是转义序列 \t（两字符）
  const { columns, cells } = parseMysqlBatch("name\tmemo\nline1\\tline2\t含\\t制表\n")
  assert.deepEqual(columns, ["name", "memo"])
  assert.deepEqual(cells, [["line1\tline2", "含\t制表"]])
})
t("NULL 字面量按字符串保留（批处理格式区分不了真 NULL）", () => {
  const { cells } = parseMysqlBatch("a\tb\nNULL\t1\n")
  assert.deepEqual(cells, [["NULL", "1"]])
})
t("反斜杠解码：\\\\n 是字面反斜杠+n，不是换行", () => {
  assert.equal(unescapeBatch("a\\\\nb"), "a\\nb")
  assert.equal(unescapeBatch("尾随反斜杠\\\\"), "尾随反斜杠\\")
})
t("多结果集：异宽的第二个结果集进 extra（同宽则无从分辨——格式极限，故一个块一条 SELECT）", () => {
  const out = "a\tb\n1\t2\nx\n3\n"
  const { columns, cells, extra } = parseMysqlBatch(out)
  assert.deepEqual(columns, ["a", "b"])
  assert.deepEqual(cells, [["1", "2"]])
  assert.equal(extra, "x\n3")
})
t("CRLF 输入不残留 \\r", () => {
  const { columns } = parseMysqlBatch("a\r\n1\r\n")
  assert.deepEqual(columns, ["a"])
})

// ---------- sqlite3 -json 解析 ----------
t("JSON 数组 → 列名取首行键序；null 保留", () => {
  const { columns, cells } = parseSqliteJson('[{"a":1,"b":null},{"a":2,"b":"x"}]')
  assert.deepEqual(columns, ["a", "b"])
  assert.deepEqual(cells, [["1", null], ["2", "x"]])
})
t("空数组 / 空输出 → 无结果集", () => {
  assert.deepEqual(parseSqliteJson("[]").columns, [])
  assert.deepEqual(parseSqliteJson("").columns, [])
})

// ---------- 执行层（真实 CLI）----------
;(async () => {
  // 执行层依赖本机 mysql CLI；没有 CLI、或 3306 已被占用时，这段没有可验证的语义，
  // 跳过而不是判红（CI / 新机器默认走这里）。
  const mysqlCli = (() => {
    try {
      return spawnSync("mysql", ["--version"], { stdio: "ignore", windowsHide: true }).status === 0
    } catch {
      return false
    }
  })()
  const portBusy = await new Promise(resolve => {
    const sock = net.connect({ host: "127.0.0.1", port: 3306 })
    const done = busy => { sock.destroy(); resolve(busy) }
    sock.once("connect", () => done(true))
    sock.once("error", () => done(false))
    sock.setTimeout(1500, () => done(false))
  })
  if (!mysqlCli || portBusy) {
    console.log(`  - 跳过：执行层失败路径（mysql CLI=${mysqlCli ? "有" : "无"}，3306=${portBusy ? "有服务" : "空闲"}）`)
  } else {
    await (async () => {
      const name = "执行层：mysql 连不上 → 真实失败路径（本机 3306 无服务）"
      try {
        const r = await runQuery({ client: "mysql", sql: "SELECT 1;" }, {
          host: "127.0.0.1", port: 3306, user: "root", password: "", timeout: 8000,
        })
        if (r.ok) throw new Error("不应成功：本机没有 MySQL 服务")
        assert.ok(r.error.length > 0, "错误信息不应为空")
        passed += 1
        console.log(`  ✓ ${name}`)
      } catch (e) {
        failures.push(`${name}\n    ${e.message}`)
        console.log(`  ✗ ${name}\n    ${e.message}`)
      }
    })()
  }

  const host = process.env.MDX_MYSQL_HOST
  if (host && !mysqlCli) console.log("  - 跳过：真实连接（未找到 mysql CLI）")
  if (host && mysqlCli) {
    const name = `执行层：真实连接 ${host} SELECT 标量与建表（环境变量门控）`
    await (async () => {
      try {
        const opts = {
          host,
          port: Number(process.env.MDX_MYSQL_PORT ?? 3306),
          user: process.env.MDX_MYSQL_USER ?? "root",
          password: process.env.MDX_MYSQL_PASSWORD ?? "",
          database: process.env.MDX_MYSQL_DB ?? "",
          timeout: 15000,
        }
        const r = await runQuery({ client: "mysql", sql: "SELECT 40+2 AS answer, NULL AS nothing, 'a\tb' AS memo;" }, opts)
        assert.equal(r.ok, true, r.error)
        assert.equal(r.kind, "table")
        assert.deepEqual(r.rows.columns, ["answer", "nothing", "memo"])
        assert.deepEqual(r.rows.cells[0], ["42", "NULL", "a\tb"])
        passed += 1
        console.log(`  ✓ ${name}`)
      } catch (e) {
        failures.push(`${name}\n    ${e.message}`)
        console.log(`  ✗ ${name}\n    ${e.message}`)
      }
    })()
  } else {
    console.log("  （真实连接测试未启用：设 MDX_MYSQL_HOST/USER/PASSWORD 后再跑）")
  }

  console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
