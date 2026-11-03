/**
 * Hive/beeline 验收——`node hive.test.js`。
 * 解析层（beeline --outputformat=tsv2 输出 / JDBC URL 拼装）用夹具逐条过；执行层需要真实
 * beeline + HiveServer2，由环境变量 MDX_HIVE_HOST 门控（可选 MDX_HIVE_PORT / _DB / _USER /
 * _PASSWORD / _JDBC_URL），未设则跳过。
 */
const assert = require("assert")
const { parseBeelineTsv, buildJdbcUrl, beelineArgs, runHive } = require("../runners/hive")

let passed = 0
const failures = []
const t = (name, fn) => {
  try { fn(); passed += 1 } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}

// ---------- beeline tsv2 解析 ----------
t("基本表：表头 + 两行", () => {
  const { columns, cells, extra } = parseBeelineTsv("word\tcount\na\t3\nb\t2\n")
  assert.deepEqual(columns, ["word", "count"])
  assert.deepEqual(cells, [["a", "3"], ["b", "2"]])
  assert.equal(extra, "")
})
t("空输出（DDL/DML）→ 无结果集", () => {
  const { columns, cells } = parseBeelineTsv("")
  assert.deepEqual(columns, [])
  assert.deepEqual(cells, [])
})
t("只有表头（SELECT 零行）→ 列在、行空", () => {
  const { columns, cells } = parseBeelineTsv("word\tcount\n")
  assert.deepEqual(columns, ["word", "count"])
  assert.deepEqual(cells, [])
})
t("NULL 字面量按字符串保留（tsv2 区分不了真 NULL，渲染层按 NULL 弱化）", () => {
  const { cells } = parseBeelineTsv("a\tb\nNULL\t1\n")
  assert.deepEqual(cells, [["NULL", "1"]])
})
t("尾部 'N rows selected' 异宽 → 进 extra（与 mysql 多结果集处理同构）", () => {
  const out = "a\tb\n1\t2\n2 rows selected (0.12 seconds)\n"
  const { columns, cells, extra } = parseBeelineTsv(out)
  assert.deepEqual(columns, ["a", "b"])
  assert.deepEqual(cells, [["1", "2"]])
  assert.ok(/rows selected/.test(extra), "尾部行应进 extra")
})
t("头部横幅/告警行被跳过（连不上/日志框架噪声泄到 stdout）", () => {
  const out = "WARNING: An illegal reflective access operation has occurred\nword\tcount\na\t3\n"
  const { columns, cells } = parseBeelineTsv(out)
  assert.deepEqual(columns, ["word", "count"])
  assert.deepEqual(cells, [["a", "3"]])
})
t("CRLF 输入不残留 \\r", () => {
  const { columns } = parseBeelineTsv("a\r\n1\r\n")
  assert.deepEqual(columns, ["a"])
})

// ---------- JDBC URL 拼装 ----------
t("默认 URL：host:port/db", () => {
  assert.equal(buildJdbcUrl({ host: "node1", port: 10000, database: "default" }), "jdbc:hive2://node1:10000/default")
})
t("空 host / port 回落默认", () => {
  assert.equal(buildJdbcUrl({ host: "", port: "", database: "" }), "jdbc:hive2://localhost:10000/default")
})
t("显式 JDBC_URL 优先", () => {
  const u = "jdbc:hive2://node1:10000/default;principal=hive/node1@REALM"
  assert.equal(buildJdbcUrl({ jdbcUrl: u, host: "x" }), u)
})
t("auth 段追加（带/不带前导分号都修成前导分号）", () => {
  assert.equal(buildJdbcUrl({ host: "h", database: "d", auth: "principal=p" }), "jdbc:hive2://h:10000/d;principal=p")
  assert.equal(buildJdbcUrl({ host: "h", database: "d", auth: ";principal=p" }), "jdbc:hive2://h:10000/d;principal=p")
})

// ---------- 命令行参数 ----------
t("beeline 参数：带 user/password 与 tsv2", () => {
  const args = beelineArgs({ host: "h", database: "d", user: "u", password: "p", sql: "SELECT 1" })
  assert.deepEqual(args, ["-u", "jdbc:hive2://h:10000/d", "-n", "u", "-p", "p", "--outputformat=tsv2", "-e", "SELECT 1"])
})
t("空密码不传 -p（避免交互提示）", () => {
  const args = beelineArgs({ host: "h", database: "d", password: "", sql: "SELECT 1" })
  assert.ok(!args.includes("-p"), "不应出现 -p")
  assert.ok(args.includes("-e"), "仍有 -e")
})

// ---------- 执行层（真实 beeline）----------
;(async () => {
  const host = process.env.MDX_HIVE_HOST
  if (host) {
    const name = `执行层：真实 HS2 ${host} SELECT 标量与 NULL（环境变量门控）`
    await (async () => {
      try {
        const opts = {
          host,
          port: Number(process.env.MDX_HIVE_PORT ?? 10000),
          database: process.env.MDX_HIVE_DB ?? "default",
          user: process.env.MDX_HIVE_USER ?? "",
          password: process.env.MDX_HIVE_PASSWORD ?? "",
          jdbcUrl: process.env.MDX_HIVE_JDBC_URL ?? "",
          timeout: 30000,
        }
        const r = await runHive({ sql: "SELECT 40+2 AS answer, NULL AS nothing;" }, opts)
        assert.equal(r.ok, true, r.error)
        assert.equal(r.kind, "table")
        assert.deepEqual(r.rows.columns, ["answer", "nothing"])
        assert.deepEqual(r.rows.cells[0], ["42", "NULL"])
        passed += 1
        console.log(`  ✓ ${name}`)
      } catch (e) {
        failures.push(`${name}\n    ${e.message}`)
        console.log(`  ✗ ${name}\n    ${e.message}`)
      }
    })()
  } else {
    console.log("  （真实连接测试未启用：设 MDX_HIVE_HOST/USER/PASSWORD 后再跑）")
  }

  console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
