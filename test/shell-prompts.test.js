/**
 * shell 提示符剥离的验收——零依赖，`node shell-prompts.test.js`。
 * 讲义里"会话实录"式写法（[zhangsan@node0 ~]$ cmd）要能原样执行：提示符剥掉、
 * user@host 还能拿去做远端路由。stripPrompts 默认开（config.STRIP_PROMPTS）。
 */
const assert = require("assert")
const { prepareScript, parsePromptTarget } = require("../lib/runners/shell")

let passed = 0
const failures = []
const t = (name, fn) => {
  try { fn(); passed += 1 } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}

t("会话实录：[user@host 路径]$ 剥掉，命令保留", () => {
  const src = "[zhangsan@node0 ~]$ hdfs dfs -mkdir -p /input\n[zhangsan@node0 ~]$ hdfs dfs -put bigdata.txt /input/bigdata.txt"
  assert.equal(prepareScript(src), "hdfs dfs -mkdir -p /input\nhdfs dfs -put bigdata.txt /input/bigdata.txt")
})

t("(base) 等环境前缀 + root 的 # 提示符", () => {
  assert.equal(prepareScript("(base) [zhangsan@node0 ~]$ jps"), "jps")
  assert.equal(prepareScript("[root@node0 ~]# hdfs dfsadmin -report"), "hdfs dfsadmin -report")
})

t("无提示符的脚本一行不动（含注释与 [ 开头的测试命令）", () => {
  const src = "echo hi\n# 注释不是提示符\n[ -f x ] && echo y"
  assert.equal(prepareScript(src), src)
})

t("行首裸 $ 也是提示符", () => {
  assert.equal(prepareScript("$ ls -l"), "ls -l")
})

t("parsePromptTarget：user@host 拿去路由远端；(base) 前缀不妨事", () => {
  assert.deepEqual(parsePromptTarget("[zhangsan@node0 ~]$ hdfs"), { user: "zhangsan", host: "node0" })
  assert.equal(parsePromptTarget("(base) [zhangsan@node0 ~]$ jps").host, "node0")
  assert.deepEqual(parsePromptTarget("hdfs dfs -ls /"), { user: "", host: "" })
})

console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(failures.length ? 1 : 0)
