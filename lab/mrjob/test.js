"use strict"
/**
 * mrjob 测试——标本全链路（解析 / 织入 / 行号映射 / 校验清单），纯逻辑段无条件跑；
 * javac / hadoop 提交按真实环境门控（沿引擎惯例：默认路径 + 环境变量覆盖）。
 * `node test.js`        MDX_MRRUN=1 时附带真实提交（本地 hadoop，约半分钟）
 */
const assert = require("assert")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { parseDoc } = require("./parse")
const { weave, remap } = require("./weave")
const { runJob } = require("./run")

const failures = []
const test = (name, fn) => Promise.resolve()
  .then(fn)
  .then(() => console.log(`  ✓ ${name}`))
  .catch(e => { failures.push(name); console.error(`  ✗ ${name}\n    ${e?.message ?? e}`) })

const SPECIMEN = fs.readFileSync(path.join(__dirname, "wordcount.md"), "utf8")
const HADOOP_DEFAULT = process.env.MDX_HADOOP_HOME || "D:/bigdata/hadoop/hadoop-3.1.3"
const HAS_HADOOP = (() => {
  try { return fs.existsSync(path.join(HADOOP_DEFAULT, "share", "hadoop", "common")) } catch { return false }
})()

// 一份最小可织入文档（负向用例在它上面做手术）
const BASE = fm => `---
title: t
mr-job:
${fm}
---

\`\`\`java map
context.write(new Text(value.toString()), new IntWritable(1));
\`\`\`

\`\`\`java reduce
context.write(key, new IntWritable(0));
\`\`\`
`
const GOOD_FM = `  name: Foo
  types:
    in: LongWritable, Text
    map-out: Text, IntWritable
    out: Text, IntWritable
  input: data/x.txt
  output: out/x`

const main = async () => {
  console.log("== 解析 ==")

  await test("parse：骨架 + 块清单", () => {
    const { fm, blocks, problems } = parseDoc(SPECIMEN)
    assert.deepStrictEqual(problems, [])
    assert.strictEqual(fm.name, "WordCount")
    assert.strictEqual(fm.combine, "reduce")
    assert.strictEqual(fm.input, "data/bigdata.txt")
    const stages = blocks.filter(b => b.role === "stage").map(b => b.stage)
    assert.deepStrictEqual(stages, ["map", "reduce"])
    const file = blocks.find(b => b.role === "file")
    assert.strictEqual(file.file, "data/bigdata.txt")
    assert.ok(blocks.some(b => b.role === "job"), "提交块")
    assert.ok(blocks.some(b => b.role === "demo"), "骨架示意块")
  })

  await test("parse：未知标注与角色冲突不静默", () => {
    const { blocks } = parseDoc("```java map reduce\nx\n```\n")
    assert.ok(blocks[0].problems.join(" ").includes("冲突"))
    const { problems } = parseDoc("---\nmr-job:\n  nam: X\n---\n")
    assert.ok(problems.join(" ").includes("未知 mr-job 键"))
  })

  console.log("== 织入 ==")

  await test("weave：标本 → 三文件，骨架来自 front-matter", () => {
    const { fm, blocks } = parseDoc(SPECIMEN)
    const w = weave(fm, blocks)
    assert.deepStrictEqual(w.problems, [])
    assert.deepStrictEqual(Object.keys(w.files),
      ["WordCountMapper.java", "WordCountReducer.java", "WordCountMain.java"])
    const mapper = w.files["WordCountMapper.java"].code
    assert.ok(mapper.includes("extends Mapper<LongWritable, Text, Text, IntWritable> {"), "泛型来自 fm")
    assert.ok(mapper.includes('protected void map(LongWritable key, Text value, Context context)'), "签名来自骨架")
    assert.ok(mapper.includes('String[] wordArray = value.toString().split(" ");'), "方法体来自片段")
    const reducer = w.files["WordCountReducer.java"].code
    assert.ok(reducer.includes("Iterable<IntWritable> values"))
    const main = w.files["WordCountMain.java"].code
    assert.ok(main.includes("job.setCombinerClass(WordCountReducer.class);"), "combine: reduce → 驱动生成")
    assert.ok(main.includes('args[0] : "data/bigdata.txt"'), "路径缺省值来自 fm")
    assert.ok(!main.includes("setPartitionerClass"), "无 partition 片段就不生成")
  })

  await test("weave：行号映射能指回片段", () => {
    const { fm, blocks } = parseDoc(SPECIMEN)
    const w = weave(fm, blocks)
    const code = w.files["WordCountMapper.java"].code.split("\n")
    const at = code.findIndex(l => l.includes("context.write(new Text(word), one);"))
    const slot = w.files["WordCountMapper.java"].lineMap[at]
    assert.strictEqual(slot.src, "map")
    assert.ok(slot.line >= 1)
    // 映射的自洽：织入行数 = 映射条数；片段每一行都有来源
    assert.strictEqual(code.length, w.files["WordCountMapper.java"].lineMap.length)
    const fragAt = w.files["WordCountMapper.java"].lineMap.filter(s => s.src === "map").length
    assert.strictEqual(fragAt, blocks.find(b => b.stage === "map").code.split("\n").length)
  })

  await test("remap：javac 诊断回映成片段行号", () => {
    const { fm, blocks } = parseDoc(SPECIMEN)
    const w = weave(fm, blocks)
    const code = w.files["WordCountMapper.java"].code.split("\n")
    const at = code.findIndex(l => l.includes("split(\" \")"))
    const expectLine = w.files["WordCountMapper.java"].lineMap[at].line
    const out = remap(w, `src\\WordCountMapper.java:${at + 1}: error: cannot find symbol\n  symbol: variable wrod`)
    assert.strictEqual(out.length, 1)
    assert.ok(out[0].includes(`map 片段第 ${expectLine} 行`), out[0])
    assert.ok(out[0].includes("cannot find symbol"))
    // 生成骨架里的错不嫁祸给片段
    const genAt = w.files["WordCountMain.java"].lineMap.findIndex(s => s.src === "gen") + 1
    const out2 = remap(w, `WordCountMain.java:${genAt}: error: no suitable method found for getInstance`)
    assert.ok(out2[0].includes("生成骨架"), out2[0])
  })

  await test("校验清单：必需片段 / 类型形状 / combine 冲突", () => {
    const noReduce = weave({ name: "Foo", types: { in: "A, B", "map-out": "C, D", out: "E, F" }, input: "i", output: "o" },
      [{ role: "stage", stage: "map", code: "x;", line: 0, problems: [] }])
    assert.ok(noReduce.problems.join(" ").includes("缺 reduce 片段"))
    const badTypes = weave({ name: "Foo", types: { in: "A", "map-out": "C, D", out: "E, F" }, input: "i", output: "o" },
      [{ role: "stage", stage: "map", code: "x;", line: 0, problems: [] }, { role: "stage", stage: "reduce", code: "y;", line: 3, problems: [] }])
    assert.ok(badTypes.problems.join(" ").includes("types.in"))
    const both = weave({ name: "Foo", types: { in: "A, B", "map-out": "C, D", out: "E, F" }, combine: "reduce", input: "i", output: "o" },
      [{ role: "stage", stage: "map", code: "x;", line: 0, problems: [] },
       { role: "stage", stage: "reduce", code: "y;", line: 3, problems: [] },
       { role: "stage", stage: "combine", code: "z;", line: 6, problems: [] }])
    assert.ok(both.problems.join(" ").includes("combine 片段与"))
  })

  await test("weave：partition / combine 片段进驱动", () => {
    const md = `---
mr-job:
  name: Foo
  types:
    in: LongWritable, Text
    map-out: Text, IntWritable
    out: Text, IntWritable
  input: i
  output: o
---

\`\`\`java map
context.write(new Text(value.toString()), new IntWritable(1));
\`\`\`

\`\`\`java reduce
context.write(key, new IntWritable(0));
\`\`\`

\`\`\`java combine
context.write(key, new IntWritable(1));
\`\`\`

\`\`\`java partition
return (key.hashCode() & Integer.MAX_VALUE) % numPartitions;
\`\`\`
`
    const { fm, blocks } = parseDoc(md)
    const w = weave(fm, blocks)
    assert.deepStrictEqual(w.problems, [])
    assert.ok("FooCombiner.java" in w.files && "FooPartitioner.java" in w.files)
    assert.ok(w.files["FooPartitioner.java"].code.includes("public int getPartition(Text key, IntWritable value, int numPartitions)"))
    assert.ok(!w.files["FooPartitioner.java"].code.includes("IOException"), "getPartition 不声明受检异常")
    const main = w.files["FooMain.java"].code
    assert.ok(main.includes("job.setPartitionerClass(FooPartitioner.class);"))
    assert.ok(main.includes("job.setCombinerClass(FooCombiner.class);"))
  })

  await test("weave：driver 片段覆盖生成驱动", () => {
    const md = `---
mr-job:
  name: Foo
  types:
    in: LongWritable, Text
    map-out: Text, IntWritable
    out: Text, IntWritable
  input: i
  output: o
---

\`\`\`java map
context.write(new Text(value.toString()), new IntWritable(1));
\`\`\`

\`\`\`java reduce
context.write(key, new IntWritable(0));
\`\`\`

\`\`\`java driver
Job job = Job.getInstance(conf);
job.setMapperClass(FooMapper.class);
job.waitForCompletion(true);
\`\`\`
`
    const { fm, blocks } = parseDoc(md)
    const w = weave(fm, blocks)
    assert.deepStrictEqual(w.problems, [])
    const main = w.files["FooMain.java"].code
    assert.ok(main.includes("Job job = Job.getInstance(conf);"), "片段行进 main 体")
    const at = main.split("\n").findIndex(l => l.includes("waitForCompletion(true);"))
    const slot = w.files["FooMain.java"].lineMap[at]
    assert.strictEqual(slot.src, "driver")
    assert.ok(slot.line >= 1)
    assert.ok(!main.includes("setInputFormatClass"), "覆盖后不再注入默认配置调用（import 仍为全集）")
  })

  await test("weave：fm.imports 进入全部生成文件", () => {
    const fm = { name: "Foo", types: { in: "LongWritable, Text", "map-out": "Text, IntWritable", out: "Text, IntWritable" }, input: "i", output: "o", imports: ["java.util.StringTokenizer"] }
    const blocks = [
      { role: "stage", stage: "map", code: "new StringTokenizer(value.toString());", line: 0, problems: [] },
      { role: "stage", stage: "reduce", code: "context.write(key, new IntWritable(0));", line: 3, problems: [] },
    ]
    const w = weave(fm, blocks)
    assert.deepStrictEqual(w.problems, [])
    for (const f of Object.values(w.files)) assert.ok(f.code.includes("import java.util.StringTokenizer;"))
  })

  console.log("== 编译（真实 JDK 门控）==")

  const jdk = (() => {
    const home = process.env.MDX_JDK_HOME || process.env.JAVA_HOME || ""
    const bin = /[\\/]bin$/.test(home) ? home : path.join(home, "bin")
    return fs.existsSync(path.join(bin, process.platform === "win32" ? "javac.exe" : "javac"))
  })()

  await test("run --compile-only：物化 + 织入 + javac + jar", async () => {
    if (!jdk || !HAS_HADOOP) return console.log("    (跳过：无 JDK 或 hadoop 发行版)")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrjob-"))
    const doc = path.join(dir, "wordcount.md")
    fs.writeFileSync(doc, SPECIMEN)
    const r = await runJob(doc, { compileOnly: true, hadoopHome: HADOOP_DEFAULT })
    assert.strictEqual(r.ok, true, JSON.stringify(r.problems))
    assert.ok(fs.existsSync(path.join(dir, ".mdjob", "data", "bigdata.txt")), "file= 已物化")
    assert.ok(fs.existsSync(r.jar), "jar 已产出")
    assert.ok(fs.readFileSync(path.join(dir, ".mdjob", "src", "WordCountMapper.java"), "utf8").includes("WordCountMapper"))
  })

  if (process.env.MDX_MRRUN === "1") {
    console.log("== 真实提交（MDX_MRRUN=1）==")
    await test("run：本地 hadoop 提交 wordcount，输出 a/3 b/2 c/1", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrjob-run-"))
      const doc = path.join(dir, "wordcount.md")
      fs.writeFileSync(doc, SPECIMEN)
      const r = await runJob(doc, { hadoopHome: HADOOP_DEFAULT, timeoutMs: 300000 })
      assert.strictEqual(r.ok, true, `提交失败：${(r.stderr || "").slice(-1500)}`)
      const part = fs.readFileSync(path.join(r.output, "part-r-00000"), "utf8")
      assert.ok(/a\t3/.test(part) && /b\t2/.test(part) && /c\t1/.test(part), part)
    })
  }

  console.log(failures.length ? `\n${failures.length} 项失败` : "\n全部通过")
  process.exit(failures.length ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
