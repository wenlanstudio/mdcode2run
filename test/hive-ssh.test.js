"use strict"
/**
 * Hive SSH 通道验收——`node hive-ssh.test.js`。
 * 参数拼装 / 转义 / 噪声过滤 / spawn 失败人话都是纯本地用例；末尾一段真实远端
 * 由 MDX_HIVE_SSH_HOST 门控（可选 MDX_HIVE_SSH_USER / MDX_HIVE_BEELINE），未设则跳过。
 */
const assert = require("assert")
const {
  runHiveSsh, sshArgs, remoteCommand, shellQuote, filterSshNoise, asScript,
} = require("../lib/runners/hive-ssh")

let passed = 0
const failures = []
const t = (name, fn) => {
  try { fn(); passed += 1 } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}
const ta = async (name, fn) => {
  try { await fn(); passed += 1 } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}

const OPTS = {
  sshHost: "node0", sshUser: "zhangsan", sshPort: 2222,
  clientPath: "/opt/bigdata/hive/default/bin/beeline",
  host: "localhost", port: 10000, database: "zjsm", user: "zhangsan",
  timeout: 60000,
}

// ---------- SQL 不经命令行 ----------
t("shellQuote：单引号转义为 '\\''", () => {
  assert.equal(shellQuote("a'b"), "'a'\\''b'")
})
t("remoteCommand：silent + tsv2 + stdin，且不含 SQL", () => {
  const cmd = remoteCommand(OPTS, 60000)
  assert.ok(cmd.startsWith("timeout 60s "), cmd)
  assert.ok(cmd.includes("'-u' 'jdbc:hive2://localhost:10000/zjsm'"), cmd)
  assert.ok(cmd.includes("'--silent=true'"), cmd)
  assert.ok(cmd.includes("'--outputformat=tsv2'"), cmd)
  assert.ok(cmd.includes("'-f' '/dev/stdin'"), cmd)
  assert.ok(cmd.includes("'/opt/bigdata/hive/default/bin/beeline'"), cmd)
  assert.ok(!cmd.includes("SELECT"), "SQL 绝不能出现在命令行里")
})
t("remoteCommand：显式 JDBC_URL / 密码 / auth", () => {
  const cmd = remoteCommand({ ...OPTS, jdbcUrl: "jdbc:hive2://h:10000/d;principal=p", password: "p w", auth: "" }, 30000)
  assert.ok(cmd.includes("jdbc:hive2://h:10000/d;principal=p"))
  assert.ok(cmd.includes("'-p' 'p w'"))
})
t("asScript：无分号补分号，有分号不重复", () => {
  assert.equal(asScript("SELECT 1"), "SELECT 1;\n")
  assert.equal(asScript("SELECT 1;  \n"), "SELECT 1;\n")
  assert.equal(asScript(""), "\n")
})
t("filterSshNoise：滤掉后量子告警，保留真错误", () => {
  const raw = "** WARNING: connection is not using a post-quantum key exchange algorithm.\n" +
    "** This session may be vulnerable to \"store now, decrypt later\" attacks.\n" +
    "** The server may need to be upgraded. See https://openssh.com/pq.html\n" +
    "Error: Could not open connection\n"
  assert.equal(filterSshNoise(raw), "Error: Could not open connection")
})
t("sshArgs：BatchMode/-T/端口/目标/额外选项", () => {
  const a = sshArgs({ ...OPTS, sshOptions: ["-i", "C:/keys/id_rsa"] }, 60000)
  assert.ok(a.includes("-T") && a.includes("BatchMode=yes"))
  assert.deepEqual(a.slice(a.indexOf("-p"), a.indexOf("-p") + 2), ["-p", "2222"])
  assert.equal(a[a.length - 2], "zhangsan@node0")
  assert.ok(a.includes("-i") && a.includes("C:/keys/id_rsa"))
  assert.ok(a[a.length - 1].includes("-f' '/dev/stdin'"))
})

// ---------- spawn 失败走契约，不抛 ENOENT ----------
;(async () => {
  await ta("ssh 不存在 → ok:false + 中文诊断", async () => {
    const r = await runHiveSsh(
      { sql: "SELECT 1" },
      { ...OPTS, sshBin: "D:/definitely/not/here/ssh.exe", timeout: 5000 }
    )
    assert.equal(r.ok, false)
    assert.equal(r.kind, "none")
    assert.ok(/找不到 ssh 客户端/.test(r.error), r.error)
  })

  // ---------- 执行层（真实远端，环境变量门控）----------
  const host = process.env.MDX_HIVE_SSH_HOST
  if (host) {
    // Git Bash 会把传给 node.exe 的 env 值 '/opt/...' 改写成 'D:/.../opt/...'，
    // 这里还原成远端视角的绝对路径（产品代码从 JSON 配置读，不经过这层转换）。
    const rawBeeline = process.env.MDX_HIVE_BEELINE ?? ""
    const clientPath = /\/opt\//.test(rawBeeline) && !rawBeeline.startsWith("/opt/")
      ? "/opt/" + rawBeeline.split("/opt/").slice(1).join("/opt/")
      : rawBeeline
    await ta(`执行层：真实 ${host} SELECT 标量`, async () => {
      const r = await runHiveSsh({ sql: "SELECT 40+2 AS answer, NULL AS nothing;" }, {
        sshHost: host,
        sshUser: process.env.MDX_HIVE_SSH_USER ?? "",
        clientPath,
        host: "localhost", port: 10000,
        database: process.env.MDX_HIVE_DB ?? "default",
        user: process.env.MDX_HIVE_USER ?? "",
        timeout: 60000,
      })
      assert.equal(r.ok, true, r.error)
      assert.equal(r.kind, "table")
      assert.deepEqual(r.rows.columns, ["answer", "nothing"])
      assert.deepEqual(r.rows.cells[0], ["42", "NULL"])
    })
  } else {
    console.log("  · 执行层跳过（设 MDX_HIVE_SSH_HOST 开启真实远端验收）")
  }

  console.log(`\n${passed} passed, ${failures.length} failed`)
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`)
    process.exit(1)
  }
})()
