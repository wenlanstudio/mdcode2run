"use strict"
/**
 * front-matter 配置读取（配置三层的前言层：fence meta > front-matter > 引擎配置）。
 *
 * 查找顺序：`code-exec.<section>.<key>`（新，文档级默认）→ 顶层 `<key>`（旧写法，仍认）。
 * 键名大小写不敏感。密码不在此列——秘密只放引擎配置（宿主偏好），前言层无权读取。
 *
 * 这里只依赖 fences.js 的 parseCodeExecFrontMatter（code-exec: 段的缩进映射子集），
 * 外加一个顶层标量扫描——shell 连接信息与 java 旧写法（顶层 JAVA_HOME）在这一层。
 */

const { parseCodeExecFrontMatter } = require("./fences")

/**
 * front-matter 顶层 `key: value` 标量收集（不碰列表 / 嵌套 / 带空格的长文本值——
 * 那些属于 title / tags 这类展示性元数据，不是配置）。
 */
const parseTopScalars = md => {
  const top = {}
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(String(md ?? ""))
  if (!match) return top
  for (const line of match[1].split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w.-]*)[ \t]*:[ \t]*(.*)$/.exec(line)
    if (!m) continue
    const value = (m[2] ?? "").trim().replace(/^"([^"]*)"$/, "$1").replace(/^'([^']*)'$/, "$1")
    if (!value || /\s/.test(value)) continue
    if (!(m[1] in top)) top[m[1]] = value
  }
  return top
}

/** 把一篇 md 一次解析成 front-matter 视图：{ codeExec: object, top: object }。 */
const frontMatterOf = md => ({ codeExec: parseCodeExecFrontMatter(md).config, top: parseTopScalars(md) })

/** 在一个节点里按大小写不敏感找键；值是数组原样返回，标量剥引号后返回字符串。 */
const find = (node, wanted) => {
  if (!node || typeof node !== "object") return null
  const key = String(wanted).trim().toUpperCase()
  for (const [name, value] of Object.entries(node)) {
    if (String(name).trim().toUpperCase() !== key) continue
    if (Array.isArray(value)) return value
    const text = String(value ?? "").trim()
    if (text) return text
  }
  return null
}

/**
 * 查 front-matter 视图里的某个键。
 * @param {{codeExec: object, top: object}} fm frontMatterOf 的结果
 * @param {string} key 键名（大小写不敏感）
 * @param {string} [section] 语言段（"java" / "python" / "mysql"…）
 */
const frontMatterValue = (fm, key, section = "") => {
  if (section) {
    const sectionNode = fm?.codeExec?.[String(section).toLowerCase()]
    const hit = sectionNode ? find(sectionNode, key) : null
    if (hit != null) return hit
  }
  return find(fm?.top, key) ?? null
}

module.exports = { frontMatterOf, frontMatterValue, parseTopScalars }
