/**
 * fences.js 验收脚本——零依赖，`node fences.test.js [标本路径]` 直接跑。
 * 两部分：单元用例（parseFenceInfo / parseCodeExecFrontMatter / parseChapters /
 * 回归：parseFences 与 fullFenceCode 旧契约）+ 标本走查（DESIGN.md §10 的数字）。
 */
const assert = require("assert")
const fs = require("fs")
const path = require("path")
const { parseFences, parseFenceInfo, parseChapters, parseCodeExecFrontMatter, sourceFences, fullFenceCode } = require("../lib/fences")

let passed = 0
const failures = []
const t = (name, fn) => {
  try { fn(); passed += 1 } catch (e) { failures.push(`${name}\n    ${e.message}`) }
}

// ---------- parseFenceInfo：词法 ----------
t("无标注 → role code", () => {
  const { lang, meta } = parseFenceInfo("java")
  assert.equal(lang, "java")
  assert.equal(meta.role, "code")
  assert.deepEqual(meta.problems, [])
})
t("demo 旗标", () => {
  assert.equal(parseFenceInfo("shell demo").meta.role, "demo")
})
t("setup 旗标", () => {
  assert.equal(parseFenceInfo("java setup").meta.role, "setup")
})
t("file= → role file, 值保留大小写", () => {
  const { meta } = parseFenceInfo("java file=src/Main.Java")
  assert.equal(meta.role, "file")
  assert.equal(meta.file, "src/Main.Java")
})
t("带引号的值（路径含空格）", () => {
  assert.equal(parseFenceInfo('text file="my data.txt"').meta.file, "my data.txt")
  assert.equal(parseFenceInfo("csv file='a b.csv'").meta.file, "a b.csv")
})
t("session=/dialect=/workdir= 已按 DESIGN §12 移除 → 记未知标注 problem，块降级展示", () => {
  const { meta } = parseFenceInfo("sql dialect=hive session=cluster workdir=D:/tmp")
  assert.equal(meta.role, "code")
  assert.equal(meta.dialect, undefined)
  assert.equal(meta.session, undefined)
  assert.equal(meta.workdir, undefined)
  assert.equal(meta.problems.length, 3, JSON.stringify(meta.problems))
  assert.ok(meta.problems.every(p => p.includes("未知标注")), JSON.stringify(meta.problems))
})
t("demo + setup → invalid + problem", () => {
  const { meta } = parseFenceInfo("java demo setup")
  assert.equal(meta.role, "invalid")
  assert.ok(meta.problems.some(p => p.includes("角色冲突")))
})
t("demo + file= → invalid", () => {
  assert.equal(parseFenceInfo("java demo file=a.txt").meta.role, "invalid")
})
t("file= 绝对路径 → problem（值仍保留供诊断）", () => {
  const { meta } = parseFenceInfo("text file=D:/x/a.txt")
  assert.ok(meta.problems.some(p => p.includes("相对路径")))
})
t("file= .. 逃逸 → problem", () => {
  assert.ok(parseFenceInfo("text file=../secrets.txt").meta.problems.length > 0)
})
t("file= 空值 → problem", () => {
  assert.ok(parseFenceInfo("text file=").meta.problems.length > 0)
})
t("重复标注 → 保留首个 + problem", () => {
  const { meta } = parseFenceInfo("text file=a.txt file=b.txt")
  assert.equal(meta.file, "a.txt")
  assert.ok(meta.problems.some(p => p.includes("重复标注")))
})
t("未知 key=value → problem（拼错标注要抓）；未知裸词忽略", () => {
  const { meta } = parseFenceInfo("java sesson=wc nowrap")
  assert.ok(meta.problems.some(p => p.includes("未知标注")))
  assert.equal(meta.session, undefined)
  assert.deepEqual(meta.problems.filter(p => !p.includes("未知标注")), [])
})
t("语言大小写归一；info 含反引号截断（波浪线围栏）", () => {
  assert.equal(parseFenceInfo("JAVA demo").lang, "java")
  assert.equal(parseFenceInfo("java file=a`b").meta.file, "a")
})
t("空 info → 空 lang, code", () => {
  const { lang, meta } = parseFenceInfo("")
  assert.equal(lang, "")
  assert.equal(meta.role, "code")
})
t("setup 块带已移除的 session= → problem 非空，不再参与执行（旧文档安全降级）", () => {
  const { meta } = parseFenceInfo("shell setup session=cluster")
  assert.equal(meta.role, "setup")
  assert.equal(meta.session, undefined)
  assert.ok(meta.problems.some(p => p.includes("未知标注")), JSON.stringify(meta.problems))
})
t("job 旗标：执行模式而非角色——role 仍 code，meta.job=true", () => {
  const { meta } = parseFenceInfo("bash job")
  assert.equal(meta.role, "code")
  assert.equal(meta.job, true)
  assert.deepEqual(meta.problems, [])
})
t("job 与 demo / setup / file 互斥 → invalid + problem", () => {
  for (const info of ["bash job demo", "bash job setup", "text file=a.txt job"]) {
    const { meta } = parseFenceInfo(info)
    assert.equal(meta.role, "invalid", info)
    assert.ok(meta.problems.some(p => p.includes("互斥")), info)
  }
})
t("job 重复出现只算一次", () => {
  const { meta } = parseFenceInfo("bash job job")
  assert.equal(meta.job, true)
  assert.deepEqual(meta.problems, [])
})
t("job 旗标不受未知标注影响：problems 记录但 job 语义不变", () => {
  const { meta } = parseFenceInfo("bash job session=cluster")
  assert.equal(meta.job, true)
  assert.equal(meta.role, "code")
  assert.equal(meta.session, undefined)
  assert.ok(meta.problems.some(p => p.includes("未知标注")), JSON.stringify(meta.problems))
})

// ---------- parseCodeExecFrontMatter ----------
t("提取 code-exec 段（两层嵌套 + 引号值），其余 front-matter 不看", () => {
  const md = [
    "---",
    "title: T",
    "tags:",
    "- Hadoop",
    "date: 2026-09-13 16:00:00",
    "code-exec:",
    "  session-boundary: h1",
    "  java:",
    '    class-path: "D:/repo/hadoop-client-3.1.3/*"',
    "  shell:",
    "    remote: node0",
    "---",
    "# 正文",
  ].join("\n")
  const { config, problems } = parseCodeExecFrontMatter(md)
  assert.deepEqual(problems, [])
  assert.equal(config["session-boundary"], "h1")
  assert.equal(config.java["class-path"], "D:/repo/hadoop-client-3.1.3/*")
  assert.equal(config.shell.remote, "node0")
  assert.equal(config.title, undefined)
})
t("code-exec 段之后的顶层键视为段结束", () => {
  const md = ["---", "code-exec:", "  a: 1", "title: T", "---"].join("\n")
  const { config } = parseCodeExecFrontMatter(md)
  assert.deepEqual(config, { a: "1" })
  assert.equal(config.title, undefined)
})
t("无 front-matter / 无 code-exec 段 → 空 config", () => {
  assert.deepEqual(parseCodeExecFrontMatter("# A\n```js\n1\n```").config, {})
  assert.deepEqual(parseCodeExecFrontMatter("---\ntitle: T\n---\n").config, {})
})

// ---------- parseChapters ----------
t("h1 分章；围栏内的 # 与 front-matter 的 # 不算标题；隐式首章仅有围栏时保留", () => {
  const md = [
    "---",
    "# yaml 注释不是标题",
    "---",
    "封面内容",
    "```bash",
    "# 这是代码注释",
    "echo hi",
    "```",
    "# 第一章",
    "```js",
    "1",
    "```",
    "# 第二章",
    "## 小节不算边界",
    "```python",
    "2",
    "```",
  ].join("\n")
  const chapters = parseChapters(md)
  assert.deepEqual(chapters.map(c => c.title), ["", "第一章", "第二章"])
  assert.equal(chapters[0].fences.length, 1)
  assert.equal(chapters[0].fences[0].lang, "bash")
  assert.equal(chapters[2].fences[0].lang, "python")
})
t("无 h1 的文档 → 整个正文一个隐式章（零兼容分支）", () => {
  const md = "前言\n```js\n1\n```\n后记"
  const chapters = parseChapters(md)
  assert.equal(chapters.length, 1)
  assert.equal(chapters[0].title, "")
  assert.equal(chapters[0].fences.length, 1)
})
t("有 h1 但首个 h1 前无围栏 → 隐式首章不出现", () => {
  const md = "封面\n# 章\n```js\n1\n```"
  assert.deepEqual(parseChapters(md).map(c => c.title), ["章"])
})

// ---------- 回归：旧契约不破坏 ----------
t("parseFences 旧字段 lang/code 仍在；line/end 正确；缩进剥离不变", () => {
  const md = ["前文", "```python", "print(1)", "print(2)", "```", "后文"].join("\n")
  const [f] = parseFences(md)
  assert.equal(f.lang, "python")
  assert.equal(f.code, "print(1)\nprint(2)")
  assert.equal(f.line, 1)
  assert.equal(f.end, 5)
  const ind = parseFences(["  ```js", "  let a = 1", "  ```"].join("\n"))[0]
  assert.equal(ind.code, "let a = 1")
})
t("sourceFences 读不到 → []（原退路不变）", () => {
  assert.deepEqual(sourceFences(() => { throw new Error("x") }), [])
})
t("fullFenceCode：整块命中 + 切片回源 + meta 字段不影响匹配", () => {
  const md = ["```java", "a", "b", "c", "```"].join("\n")
  const fences = parseFences(md)
  assert.equal(fullFenceCode("a\nb\nc", "java", fences), "a\nb\nc")
  assert.equal(fullFenceCode("b\nc", "java", fences), "a\nb\nc")
  assert.equal(fullFenceCode("x", "java", fences), "x")
})

// ---------- 标本走查（DESIGN.md §10）----------
// 标本随仓库分发（test/fixtures/）；显式传入的路径不存在时，整段跳过而不是判红。
const specimenPath = process.argv[2]
  || path.join(__dirname, "fixtures", "4-1-1-Hadoop_MapReduce.specimen.md")
const md = fs.existsSync(specimenPath) ? fs.readFileSync(specimenPath, "utf8") : ""
const specimenTest = (name, fn) => {
  if (md) t(name, fn)
  else console.log(`  - 跳过：${name}（标本不存在：${specimenPath}）`)
}
if (!md) console.log("  - 未找到标本，跳过标本走查段（可用第一个参数指定）")
const count = (arr, pred) => arr.filter(pred).length
specimenTest("标本：7 章（隐式首章无围栏不出现）", () => {
  const chapters = parseChapters(md)
  assert.deepEqual(chapters.map(c => c.title), [
    "案例概览", "理论篇：分而治之怎么落到代码", "框架负责排序与分组",
    "常规词频统计", "实训篇：实现词频统计", "小结", "附录",
  ])
})
const all = parseFences(md)
specimenTest("标本：demo×7 / file×6 / setup×1（DESIGN §10）", () => {
  assert.equal(count(all, f => f.meta.role === "demo"), 7, "demo 数")
  assert.equal(count(all, f => f.meta.role === "file"), 6, "file 数")
  assert.equal(count(all, f => f.meta.role === "setup"), 1, "setup 数")
})
specimenTest("标本：file= 路径清单（数据×2 + pom + 源码×3）", () => {
  const files = all.filter(f => f.meta.role === "file").map(f => f.meta.file).sort()
  assert.deepEqual(files, [
    "bigdata.txt", "bigdata.txt", "pom.xml",
    "src/main/java/com/studybigdata/hadoop/mapred/awordcount/WordCountMain.java",
    "src/main/java/com/studybigdata/hadoop/mapred/awordcount/WordCountMapper.java",
    "src/main/java/com/studybigdata/hadoop/mapred/awordcount/WordCountReducer.java",
  ])
})
specimenTest("标本：所有块 problems 为空（标本自身干净）", () => {
  const bad = all.filter(f => f.meta.problems.length)
  assert.deepEqual(bad.map(f => [f.lang, f.meta.problems]), [])
})
specimenTest("标本 front-matter：session-boundary=h1 / JAVA_HOME / class-path / remote=node0", () => {
  const { config, problems } = parseCodeExecFrontMatter(md)
  assert.deepEqual(problems, [])
  assert.equal(config["session-boundary"], "h1")
  assert.equal(config.java["JAVA_HOME"], "D:/Program Files/Java/jdk-17.0.20.1")
  assert.equal(config.java["class-path"],
    "D:/bigdata/hadoop/hadoop-3.1.3/share/hadoop/common/*;D:/bigdata/hadoop/hadoop-3.1.3/share/hadoop/common/lib/*")
  assert.equal(config.shell.remote, "node0")
})
specimenTest("标本会话走查：实训篇·java = setup1+可跑2+demo3+源码file3；shell 族 = hdfs1+jps demo1 + bash2；file 块按自身语言计数", () => {
  const chapters = parseChapters(md)
  const byLang = ch => {
    const m = {}
    for (const f of ch.fences) {
      const k = f.lang
      m[k] ??= { code: 0, demo: 0, setup: 0, file: 0 }
      m[k][f.meta.role] += 1
    }
    return m
  }
  // 注：bash/shell 同属 shell-runner，"语言→会话"的家族归并（bash/shell→shell、
  // sql→dialect=）在 plugin 层做（实施顺序第 2 步），fences.js 只如实报告原始 lang。
  const regular = byLang(chapters.find(c => c.title === "常规词频统计"))
  assert.deepEqual(regular.java, { code: 1, demo: 0, setup: 0, file: 0 })
  assert.deepEqual(regular.text, { code: 0, demo: 0, setup: 0, file: 1 })
  const training = byLang(chapters.find(c => c.title === "实训篇：实现词频统计"))
  assert.deepEqual(training.java, { code: 2, demo: 3, setup: 1, file: 3 })
  assert.deepEqual(training.shell, { code: 0, demo: 1, setup: 0, file: 0 })
  assert.deepEqual(training.bash, { code: 3, demo: 0, setup: 0, file: 0 })   // hdfs/mvn/hadoop jar（步骤一现为 bash 实录风格）
  assert.deepEqual(training.xml, { code: 1, demo: 0, setup: 0, file: 1 })
  const appendix = byLang(chapters.find(c => c.title === "附录"))
  assert.deepEqual(appendix.java, { code: 0, demo: 3, setup: 0, file: 0 })
})
specimenTest("标本：可跑块与文件块的 file 依赖可对上（单机版读 bigdata.txt，物化自本章）", () => {
  const ch = parseChapters(md).find(c => c.title === "常规词频统计")
  assert.equal(count(ch.fences, f => f.meta.role === "file" && f.meta.file === "bigdata.txt"), 1)
  const runner = ch.fences.find(f => f.meta.role === "code")
  assert.ok(runner.code.includes('new FileReader("bigdata.txt")'))
})
specimenTest("标本：可跑 java 块不含 package 声明（jshell 限制；带包完整类必须走 file= 配方）", () => {
  const ch = parseChapters(md).find(c => c.title === "实训篇：实现词频统计")
  for (const f of ch.fences) {
    if (f.meta.role === "code" && f.lang === "java") {
      assert.ok(!/\bpackage\b/.test(f.code), "可跑块不得含 package 声明")
    }
  }
})

// ---------- 汇总 ----------
console.log(`通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : ""}`)
for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(failures.length ? 1 : 0)
