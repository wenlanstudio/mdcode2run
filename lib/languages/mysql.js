"use strict"
/**
 * MySQL 语言模块——```sql / ```mysql 块的执行策略。
 * query 原型：SQL 交给本机 mysql 客户端批处理执行，结果按结构化行列（rows）回来——
 * 查询的状态活在数据库服务端，客户端一次性来去（见 runners/query.js），所以不走
 * 常驻会话；重放在这里与运行等价。
 */

const fs = require("fs")
const { runQuery } = require("../runners/query")
const { frontMatterValue } = require("../front-matter")

const create = ({ config = {} } = {}) => ({
  family: "mysql",
  langs: (config.LANGS ?? ["sql", "mysql"]).map(x => String(x).toLowerCase()),

  /**
   * 连接参数：front-matter `code-exec.mysql.*` 可覆盖 HOST / PORT / USER / DATABASE
   * （讲义自包含：这篇课连哪个库写在哪篇里）；**PASSWORD 例外**——秘密只放引擎配置，
   * 前言层无权携带。
   */
  runOpts(ctx) {
    const fm = ctx?.doc?.fm ?? {}
    const fmv = key => frontMatterValue(fm, key, "mysql")
    return {
      timeout: config.TIMEOUT ?? 30000,
      clientPath: String(config.CLIENT ?? "").trim(),
      host: fmv("HOST") ?? String(config.HOST ?? "127.0.0.1"),
      port: fmv("PORT") ?? config.PORT ?? 3306,
      user: fmv("USER") ?? String(config.USER ?? "root"),
      password: config.PASSWORD ?? "",
      database: fmv("DATABASE") ?? String(config.DATABASE ?? ""),
      charset: String(config.CHARSET ?? "utf8mb4"),
    }
  },

  /** 客户端找得到才可执行：CLIENT 显式给路径，否则认 PATH 上的 mysql。 */
  checkRuntime() {
    const clientPath = String(config.CLIENT ?? "").trim()
    if (clientPath && !fs.existsSync(clientPath)) {
      return { ok: false, message: `找不到 SQL 客户端：${clientPath}（请在引擎配置 mysql.CLIENT 修正）` }
    }
    return { ok: true }
  },

  run: (source, opts = {}) => runQuery({ client: "mysql", sql: source }, opts),

  resetSession: () => {},
  dispose: () => {},
})

module.exports = { create }
