"use strict"
/**
 * Hive 语言模块——```hive / ```hql / ```hiveql / ```sparksql 块的执行策略（原 plugins 无，
 * 按 TODO 的 query 方言路线新增：HiveQL 经 beeline 一次性执行，结构化行列回来）。
 *
 * query 原型：与 mysql 同形——状态活在 HiveServer2 服务端，beeline 一次性来去，无常驻会话；
 * 重放在这里与运行等价。连接信息可由 front-matter `code-exec.hive.*` 覆盖（PASSWORD 除外，
 * 只放引擎配置层）。
 */

const fs = require("fs")
const { runHive } = require("../runners/hive")
const { frontMatterValue } = require("../front-matter")

// 与 md2slides 的 HLJS_ALIASES 对齐（hive/hiveql/hql/sparksql 都按 SQL 高亮），
// 让任意一个围栏语言标记都能定位进本族；具体用哪个由作者约定。
const DEFAULT_LANGS = ["hive", "hql", "hiveql", "sparksql"]

const create = ({ config = {} } = {}) => ({
  family: "hive",
  langs: (config.LANGS ?? DEFAULT_LANGS).map(x => String(x).toLowerCase()),

  /**
   * 连接参数：front-matter `code-exec.hive.*` 可覆盖 HOST / PORT / DATABASE / USER / JDBC_URL
   * （讲义自包含：这篇课连哪个 HS2 写在哪篇里）；**PASSWORD 例外**——秘密只放引擎配置层，
   * 前言层无权携带。也可直接给完整 JDBC_URL（含 principal），覆盖按 HOST/PORT 拼的默认 URL。
   */
  runOpts(ctx) {
    const fm = ctx?.doc?.fm ?? {}
    const fmv = key => frontMatterValue(fm, key, "hive")
    return {
      timeout: config.TIMEOUT ?? 30000,
      clientPath: String(config.CLIENT ?? "").trim(),
      jdbcUrl: fmv("JDBC_URL") ?? String(config.JDBC_URL ?? "").trim(),
      host: fmv("HOST") ?? String(config.HOST ?? "localhost"),
      port: fmv("PORT") ?? config.PORT ?? 10000,
      database: fmv("DATABASE") ?? String(config.DATABASE ?? "default"),
      user: fmv("USER") ?? String(config.USER ?? "").trim(),
      password: config.PASSWORD ?? "",
      auth: String(config.AUTH ?? "").trim(),
    }
  },

  /** beeline 找得到才可执行：CLIENT 显式给路径但不存在才拦截；否则交给运行时报错
   *  （beeline 多半在 PATH 上，或 HS2 在远端——这里不预检连通性）。 */
  checkRuntime() {
    const clientPath = String(config.CLIENT ?? "").trim()
    if (clientPath && !fs.existsSync(clientPath)) {
      return { ok: false, message: `找不到 beeline：${clientPath}（请在引擎配置 hive.CLIENT 修正）` }
    }
    return { ok: true }
  },

  run: (source, opts = {}) => runHive({ sql: source }, opts),

  resetSession: () => {},
  dispose: () => {},
})

module.exports = { create }
