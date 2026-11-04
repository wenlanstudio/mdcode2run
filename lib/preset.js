"use strict"
/**
 * preset 环境档案（DESIGN §4 六层配置的解析核心）。
 *
 *   tech < course < doc < chapter < block < engine
 *
 * v1 实现 tech / course / doc / engine 四层；chapter（h1 子树）与 block（fence
 * override:）两层留位——它们复用同一套 apply 语义，接入时只是多两次 apply。
 *
 * 职责边界：本模块是纯函数，无 I/O、无进程、无文件——给它 schema、装订、秘密，
 * 它还一个「该语言族的最终执行配置 + 问题清单」。谁调用（engine/CLI/宿主）、
 * schema 从哪来（内置/外置 JSON），都不是这里的事。
 *
 * 三条护栏（覆盖自由不等于乱盖）：
 *   1. 白名单：上层只能盖 tech schema 声明过的参数，盖不存在的键记 problem。
 *   2. runner 锁定：由「执行器永远按 family 硬绑」保证——解析产物只有参数，
 *      没有 runner 字段，上层无从覆盖。
 *   3. 秘密禁字面量：schema 标 secret:true 的参数，course/doc 层只能写 ${NAME}
 *      占位符；真值只从 engine 层（config.secrets）取。
 */

/** 内置技术 schema：runner 按 family 硬绑（护栏 2），这里只声明参数与默认值。 */
const BUILTIN_TECHS = {
  python: { params: { PYTHON_PATH: {}, DPI: {}, TIMEOUT: {} } },
  java: { params: { JAVA_HOME: {}, CLASS_PATH: {}, TIMEOUT: {} } },
  shell: { params: { MODE: { default: "auto" }, HOST: {}, PORT: {}, USER: {}, PASSWORD: { secret: true }, LOCAL_SHELL: {}, STRIP_PROMPTS: {} } },
  mysql: { params: { CLIENT: {}, HOST: { default: "127.0.0.1" }, PORT: { default: 3306 }, USER: { default: "root" }, PASSWORD: { secret: true }, DATABASE: {}, CHARSET: { default: "utf8mb4" }, TIMEOUT: {} } },
  hive: { params: { CLIENT: {}, HOST: {}, PORT: {}, USER: {}, PASSWORD: { secret: true }, DATABASE: {}, JDBC_URL: {}, AUTH: {}, TIMEOUT: {} } },
}

/** 内置课程装订（DESIGN §11 的六门课）。值可含 ${NAME} 占位符，真值在 engine 层。 */
const BUILTIN_COURSES = {
  "java-basic": { java: {} },
  "hadoop-mr": {
    java: { CLASS_PATH: "hadoop-client/*" },
    shell: { MODE: "remote", HOST: "${CLUSTER_HOST}", USER: "${CLUSTER_USER}", PASSWORD: "${CLUSTER_PW}" },
  },
  "python-data": { python: { PYTHON_PATH: "${ANACONDA}" } },
  "hive-course": {
    hive: { DATABASE: "homework" },
    shell: { MODE: "remote", HOST: "${CLUSTER_HOST}", USER: "${CLUSTER_USER}", PASSWORD: "${CLUSTER_PW}" },
  },
  "linux-local": { shell: {} },
  "linux-remote": { shell: { MODE: "remote", HOST: "${LAB_HOST}", USER: "${LAB_USER}", PASSWORD: "${LAB_PW}" } },
}

/** 占位符语法：${NAME}。 */
const PLACEHOLDER = /\$\{([A-Za-z_]\w*)\}/g

/** front-matter 顶层找 preset 名（大小写不敏感）；无则 null。 */
const presetNameOf = fm => {
  for (const [k, v] of Object.entries(fm?.top ?? {})) {
    if (String(k).trim().toUpperCase() === "PRESET") {
      const name = String(v ?? "").trim()
      return name || null
    }
  }
  return null
}

/** ${NAME} 替换；engine 层缺真值记 problem（原样保留，让运行时也看得见）。 */
const substitute = (text, secrets, label, problems) =>
  String(text).replace(PLACEHOLDER, (raw, name) => {
    const value = secrets[name]
    if (value === undefined || value === null || value === "") {
      problems.push(`${label}：\${${name}} 在 engine 层（config.secrets）没有真值`)
      return raw
    }
    return String(value)
  })

/**
 * 解析一个语言族的最终执行配置。
 * @param {object} p
 * @param {string} p.family 语言族（tech schema 的键）
 * @param {string} [p.courseName] 文档 front-matter 的 preset 名；无则 course 层跳过
 * @param {object} [p.techs] 技术 schema 表（默认内置五族）
 * @param {object} [p.courses] 课程装订表（默认内置六门课）
 * @param {object} [p.secrets] engine 层秘密：${NAME} 的真值
 * @param {object} [p.docOverride] doc 层覆盖（front-matter code-exec.<family>）
 * @returns {{config: object, problems: string[]}} problems 非空 = 解析失败，config 不可信
 */
const resolveFamily = ({ family, courseName = "", techs = BUILTIN_TECHS, courses = BUILTIN_COURSES, secrets = {}, docOverride = {} } = {}) => {
  const problems = []
  const tech = techs[family]
  if (!tech) return { config: {}, problems: [`未知语言族 ${family}：没有 tech schema`] }

  // ① tech 默认值打底（默认值就是给上层盖的）
  const config = {}
  for (const [key, spec] of Object.entries(tech.params ?? {})) {
    if (spec?.default !== undefined) config[key] = spec.default
  }

  // ② course 装订：先验装订引用的都是已声明技术，再取本族绑定
  let binding = {}
  if (courseName) {
    const course = courses[courseName]
    if (!course) {
      problems.push(`未知课程档案 preset: ${courseName}（可用：${Object.keys(courses).join(" / ")}）`)
    } else {
      for (const fam of Object.keys(course)) {
        if (!techs[fam]) problems.push(`课程 ${courseName} 引用了未声明的技术 ${fam}`)
      }
      binding = course[family] ?? {}
    }
  }

  /** 一层覆盖的通用语义：白名单 → 秘密检查 → ${} 替换 → 浅盖单键。 */
  const apply = (values, label) => {
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!(key in (tech.params ?? {}))) {
        problems.push(`${label} 覆盖了未声明的参数 ${family}.${key}`)
        continue
      }
      const spec = tech.params[key] ?? {}
      const text = typeof value === "string" ? value : String(value ?? "")
      if (spec.secret && !/^\$\{[A-Za-z_]\w*\}$/.test(text.trim())) {
        problems.push(`${label} 为秘密参数 ${family}.${key} 写了字面量——只能用 \${NAME} 占位符（秘密只进 engine 层）`)
        continue
      }
      config[key] = substitute(text, secrets, label, problems)
    }
  }

  apply(binding, `课程 ${courseName || "?"}`)
  apply(docOverride, "文档覆盖")

  return { config, problems }
}

module.exports = { BUILTIN_TECHS, BUILTIN_COURSES, resolveFamily, presetNameOf }
