/**
 * preset 六层环境验收（DESIGN §4）——零依赖、不碰真机：
 * 解析顺序 / 三护栏（白名单、runner 锁定、秘密禁字面量）/ ${} 替换 / 引擎接线。
 * 引擎集成用例全部走契约失败路径（checkRuntime / 解析问题壳），无需真 Python。
 */
const assert = require("assert")
const { resolveFamily, presetNameOf, BUILTIN_TECHS, BUILTIN_COURSES } = require("../preset")
const { createEngine } = require("..")

let passed = 0
const failures = []
const pending = []
/** 同步当场计数；async 进 pending，汇总前必须 await 全部（测试壳铁律）。 */
const t = (name, fn) => {
  try {
    const r = fn()
    if (r && typeof r.then === "function") {
      pending.push(r.then(
        () => { passed += 1 },
        e => failures.push(`${name}\n    ${e.message}`),
      ))
      return
    }
    passed += 1
  } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}

const MD_NO_PRESET = "# 章\n\n```python\nprint(1)\n```\n"
const mdWithPreset = name => `---\npreset: ${name}\n---\n\n# 章\n\n\`\`\`python\nprint(1)\n\`\`\`\n`

;(async () => {
  // ── 解析核心 ──

  t("tech 默认值打底：shell 无覆盖时 MODE=auto（模块同款默认）", () => {
    const { config, problems } = resolveFamily({ family: "shell" })
    assert.deepEqual(problems, [])
    assert.equal(config.MODE, "auto")
  })

  t("合并顺序 tech < course < doc：上层只盖点名的键", () => {
    const { config, problems } = resolveFamily({
      family: "shell",
      courseName: "linux-remote",
      secrets: { LAB_HOST: "10.0.0.9", LAB_USER: "stu", LAB_PW: "pw123" },
      docOverride: { MODE: "local" },   // 文档盖回本机调试
    })
    assert.deepEqual(problems, [])
    assert.equal(config.MODE, "local")          // doc 盖 course
    assert.equal(config.HOST, "10.0.0.9")       // course 盖 tech（无默认 → 填真值）
    assert.equal(config.PASSWORD, "pw123")      // 秘密占位符 → engine 真值
  })

  t("白名单：覆盖未声明参数记 problem 且不生效", () => {
    const { config, problems } = resolveFamily({
      family: "shell", docOverride: { FOO: "x", MODE: "local" },
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /shell\.FOO/)
    assert.equal(config.FOO, undefined)
    assert.equal(config.MODE, "local")          // 合法的照常生效
  })

  t("秘密禁字面量：course 写明文密码被拒", () => {
    const { config, problems } = resolveFamily({
      family: "shell", courseName: "bad-course", // 用自定义课程表注入
      courses: { ...BUILTIN_COURSES, "bad-course": { shell: { PASSWORD: "明文密码" } } },
    })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /字面量/)
    assert.equal(config.PASSWORD, undefined)
  })

  t("秘密占位符合法：${NAME} → engine 真值", () => {
    const { config, problems } = resolveFamily({
      family: "shell", courseName: "linux-remote",
      secrets: { LAB_HOST: "h", LAB_USER: "u", LAB_PW: "secret!" },
    })
    assert.deepEqual(problems, [])
    assert.equal(config.PASSWORD, "secret!")
  })

  t("缺秘密真值：${NAME} 在 engine 层没值记 problem", () => {
    const { config, problems } = resolveFamily({
      family: "shell", courseName: "linux-remote", secrets: {},
    })
    assert.ok(problems.some(p => p.includes("${LAB_PW}")))
    assert.equal(config.PASSWORD, "${LAB_PW}")   // 原样保留，运行时也看得见
  })

  t("未知课程档案 → 明确人话，附可用清单", () => {
    const { problems } = resolveFamily({ family: "python", courseName: "nope" })
    assert.equal(problems.length, 1)
    assert.match(problems[0], /未知课程档案 preset: nope/)
    assert.match(problems[0], /java-basic/)
  })

  t("course 引用未声明技术 → problem（防拼错静默）", () => {
    const { problems } = resolveFamily({
      family: "python", courseName: "spark-mix",
      courses: { ...BUILTIN_COURSES, "spark-mix": { spark: { FOO: 1 }, python: {} } },
    })
    assert.ok(problems.some(p => p.includes("未声明的技术 spark")))
  })

  t("未知语言族 → 直接报无 schema", () => {
    const { problems } = resolveFamily({ family: "spark" })
    assert.match(problems[0], /未知语言族/)
  })

  t("presetNameOf：大小写不敏感、无 preset 返 null", () => {
    assert.equal(presetNameOf({ top: { Preset: "hive-course" } }), "hive-course")
    assert.equal(presetNameOf({ top: {} }), null)
    assert.equal(presetNameOf(null), null)
  })

  t("内置 schema/课程齐备：五族 schema、六门课", () => {
    assert.deepEqual(Object.keys(BUILTIN_TECHS).sort(), ["hive", "java", "mysql", "python", "shell"])
    assert.deepEqual(Object.keys(BUILTIN_COURSES).sort(),
      ["hadoop-mr", "hive-course", "java-basic", "linux-local", "linux-remote", "python-data"])
  })

  // ── 引擎接线（全部走契约失败路径，不碰真机） ──

  t("无 preset 文档：行为与现状一致（PYTHON_PATH 缺 → checkRuntime 人话）", async () => {
    const engine = createEngine({ documentPath: "D:/t/a.md" })
    const ctx = engine.locate(MD_NO_PRESET, { code: "print(1)", lang: "python" })
    assert.ok(ctx, "应定位到块")
    const result = await engine.run(ctx)
    assert.equal(result.ok, false)
    assert.match(result.error, /没有可用的 Python/)
    engine.dispose()
  })

  t("preset 解析失败：run 走契约失败，报错带 preset 名与原因", async () => {
    const engine = createEngine({ documentPath: "D:/t/b.md" })
    const ctx = engine.locate(mdWithPreset("nope"), { code: "print(1)", lang: "python" })
    assert.ok(ctx, "标注问题不影响块定位（preset 是文档层，不进 fence problems）")
    const result = await engine.run(ctx)
    assert.equal(result.ok, false)
    assert.match(result.error, /环境档案解析失败/)
    assert.match(result.error, /preset: nope/)
    engine.dispose()
  })

  t("preset 解析成功：配置送达语言模块（假路径 → python 的人话，不是解析失败）", async () => {
    const engine = createEngine({
      documentPath: "D:/t/c.md",
      config: { secrets: { ANACONDA: "Z:/no-such/python.exe" } },
    })
    const ctx = engine.locate(mdWithPreset("python-data"), { code: "print(1)", lang: "python" })
    const result = await engine.run(ctx)
    assert.equal(result.ok, false)
    assert.match(result.error, /没有可用的 Python/)     // 解析成功、PYTHON_PATH 已送达
    assert.doesNotMatch(result.error, /解析失败/)
    engine.dispose()
  })

  await Promise.all(pending)   // 异步用例的断言全部落定后才许汇总（测试壳铁律）
  console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
  for (const f of failures) console.log(`  ✗ ${f}`)
  process.exit(failures.length ? 1 : 0)
})().catch(e => { console.error("脚本自身失败:", e); process.exit(1) })
