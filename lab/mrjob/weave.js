"use strict"
/**
 * 织入器——(mr-job 骨架, 阶段片段) → 完整 Java 源文件集 + 行号映射（纯函数，可单测）。
 *
 *   校验   front-matter 词汇封闭、类型形状、片段清点（必需 / 重复 / 冲突）→ problems
 *   生成   <Name>Mapper / <Name>Reducer / [<Name>Partitioner] / <Name>Main：
 *          外层类、方法签名、泛型、import、驱动配置全部由骨架生成，片段只供方法体
 *   映射   每个生成文件带 lineMap（织入行 → { src, line }），编译诊断经 remap 回到
 *          片段行号——文档不是被执行的原文，诊断就必须回得来
 *
 * 类型一致性不靠检查、靠构造：map 的输出类型与 reduce 的输入类型读的是同一份
 * fm.types.map-out，想不一致都难；片段逻辑对不对交给 javac，报错经 lineMap 回映。
 */

const IDENT = /^[A-Z][A-Za-z0-9_]*$/

const badRelPath = p => !p || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..")

/** "LongWritable, Text" → ["LongWritable", "Text"]；形状不对返回 null。 */
const parseTypes = raw => {
  const parts = String(raw ?? "").split(",").map(s => s.trim()).filter(Boolean)
  if (parts.length !== 2 || parts.some(t => !IDENT.test(t))) return null
  return parts
}

// ── 生成底座：每行入 lines，来源入 map（src = "gen" 或片段阶段名）──
const newFile = () => {
  const f = { lines: [], map: [] }
  f.gen = text => { f.lines.push(text); f.map.push({ src: "gen", line: null }) }
  f.frag = (src, rows, i) => { f.lines.push("        " + rows[i]); f.map.push({ src, line: i + 1 }) }
  f.done = () => ({ code: f.lines.join("\n"), lineMap: f.map })
  return f
}

const ioImports = types => [...new Set(types.flat())].sort()
  .map(t => `import org.apache.hadoop.io.${t};`)

const HEADER = "// 本文件由讲义织入生成（md 文档是唯一真源）——不要手改，下次运行会被覆盖。"

/** 片段正文按行织入；\r\n 归一由调用方保证（parseFences 已按行切）。 */
const fragRows = block => String(block?.code ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")

/**
 * 阶段骨架：public class <Name><Stage> extends <base><...> { 方法签名 { 片段 } }
 * 片段形参命名是协议的一部分：map → key/value/context，reduce/combiner →
 * key/values/context，partition → key/value/numPartitions。
 */
/**
 * @param throwsClause 覆写方法的 throws 子句。Partitioner.getPartition 的父类不声明
 *   受检异常，覆写不能再加宽——map/reduce/combiner 声明，partition 不声明。
 */
const stageFile = ({ cls, base, generics, signature, throwsClause = "            throws IOException, InterruptedException {", src, block, extraImports = [] }) => {
  const f = newFile()
  f.gen(HEADER)
  f.gen("")
  if (throwsClause) f.gen("import java.io.IOException;")
  f.gen("")
  for (const imp of ioImports([generics])) f.gen(imp)
  f.gen(`import org.apache.hadoop.mapreduce.${base};`)
  for (const imp of [...new Set(extraImports)].sort()) f.gen(`import ${imp};`)
  f.gen("")
  f.gen(`public class ${cls} extends ${base}<${generics.join(", ")}> {`)
  f.gen("")
  f.gen(`    @Override`)
  f.gen(`    ${signature}`)
  f.gen(throwsClause || "        {")
  const rows = fragRows(block)
  rows.forEach((_, i) => f.frag(src, rows, i))
  f.gen(`    }`)
  f.gen("")
  f.gen(`}`)
  return f.done()
}

/**
 * 驱动：<Name>Main。默认由骨架生成（配置顺序对齐教材步骤四）；文档写了
 * `java driver` 片段时改为包裹片段（教驱动本身的课），骨架只提供类壳与 main 签名。
 */
const mainFile = ({ name, stageClasses, types, input, output, driverBlock, extraImports }) => {
  const f = newFile()
  f.gen(HEADER)
  f.gen("")
  f.gen("import org.apache.hadoop.conf.Configuration;")
  f.gen("import org.apache.hadoop.fs.Path;")
  for (const imp of ioImports([types.in, types["map-out"], types.out])) f.gen(imp)
  f.gen("import org.apache.hadoop.mapreduce.Job;")
  f.gen("import org.apache.hadoop.mapreduce.lib.input.FileInputFormat;")
  f.gen("import org.apache.hadoop.mapreduce.lib.input.TextInputFormat;")
  f.gen("import org.apache.hadoop.mapreduce.lib.output.FileOutputFormat;")
  f.gen("import org.apache.hadoop.mapreduce.lib.output.TextOutputFormat;")
  for (const imp of [...new Set(extraImports)].sort()) f.gen(`import ${imp};`)
  f.gen("")
  f.gen(`public class ${name}Main {`)
  f.gen("")
  f.gen("    public static void main(String[] args) throws Exception {")
  if (driverBlock) {
    const rows = fragRows(driverBlock)
    rows.forEach((_, i) => {
      const text = "        " + rows[i]
      f.lines.push(text)
      f.map.push({ src: "driver", line: i + 1 })
    })
  } else {
    const sc = stageClasses
    f.gen("        Configuration conf = new Configuration();")
    f.gen("        Job job = Job.getInstance(conf);")
    f.gen("")
    f.gen("        job.setInputFormatClass(TextInputFormat.class);")
    f.gen("        job.setOutputFormatClass(TextOutputFormat.class);")
    f.gen("")
    f.gen(`        job.setJarByClass(${name}Main.class);`)
    f.gen(`        job.setMapperClass(${sc.mapper}.class);`)
    f.gen(`        job.setReducerClass(${sc.reducer}.class);`)
    if (sc.combiner) f.gen(`        job.setCombinerClass(${sc.combiner}.class);`)
    if (sc.partitioner) f.gen(`        job.setPartitionerClass(${sc.partitioner}.class);`)
    f.gen("")
    f.gen(`        job.setMapOutputKeyClass(${types["map-out"][0]}.class);`)
    f.gen(`        job.setMapOutputValueClass(${types["map-out"][1]}.class);`)
    f.gen("")
    f.gen(`        job.setOutputKeyClass(${types.out[0]}.class);`)
    f.gen(`        job.setOutputValueClass(${types.out[1]}.class);`)
    f.gen("")
    f.gen(`        FileInputFormat.setInputPaths(job, new Path(args.length > 0 ? args[0] : "${input}"));`)
    f.gen(`        FileOutputFormat.setOutputPath(job, new Path(args.length > 1 ? args[1] : "${output}"));`)
    f.gen("")
    f.gen("        job.waitForCompletion(true);")
  }
  f.gen("    }")
  f.gen("")
  f.gen("}")
  return f.done()
}

/**
 * 织入。problems 非空时 fail-closed：宁可拒绝执行，不猜作者意图。
 * @param {object} fm parseMrJob 的 fm
 * @param {object[]} blocks parseDoc 的 blocks
 * @returns {{ok, problems, name?, jar?, mainClass?, input?, output?, classpath?,
 *            files?: Record<string, {code, lineMap}>}}
 */
const weave = (fm, blocks = []) => {
  const problems = []

  // ── 片段清点 ──
  const stage = {}
  for (const b of blocks) {
    if (b.role !== "stage") continue
    if (b.problems.length) { problems.push(`第 ${b.line + 1} 行片段标注有误：${b.problems.join("；")}`); continue }
    if (stage[b.stage]) problems.push(`${b.stage} 片段重复（第 ${stage[b.stage].line + 1} 与第 ${b.line + 1} 行）——一文档一作业，每阶段一个片段`)
    else stage[b.stage] = b
  }
  if (!stage.map) problems.push("缺 map 片段（```java map）")
  if (!stage.reduce) problems.push("缺 reduce 片段（```java reduce）")

  // ── fm 校验 ──
  const name = String(fm.name ?? "").trim()
  if (!IDENT.test(name)) problems.push(`mr-job.name 须为大写字母开头的类名：“${name || "(缺)"}”`)
  const types = {}
  for (const [key, what] of [["in", "map 输入"], ["map-out", "map 输出"], ["out", "最终输出"]]) {
    const t = parseTypes(fm.types?.[key])
    if (!t) problems.push(`mr-job.types.${key}（${what}）须为“两个 Writable 类型，逗号分隔”：${fm.types?.[key] ?? "(缺)"}」`)
    else types[key] = t
  }
  const combine = fm.combine == null ? "" : String(fm.combine).trim()
  if (combine && combine !== "reduce") problems.push(`mr-job.combine 仅支持 reduce（复用 Reducer）；独立 combiner 请写 java combine 片段：“${combine}”`)
  if (stage.combine && combine) problems.push("java combine 片段与 mr-job.combine: reduce 冲突——独立 combiner 与复用二选一")
  const input = String(fm.input ?? "").trim()
  const output = String(fm.output ?? "").trim()
  if (badRelPath(input)) problems.push(`mr-job.input 须为相对路径：${input || "(缺)"}`)
  if (badRelPath(output)) problems.push(`mr-job.output 须为相对路径：${output || "(缺)"}`)
  const jar = String(fm.jar ?? `${name.toLowerCase()}.jar`).trim()
  const extraImports = Array.isArray(fm.imports) ? fm.imports.map(s => String(s).trim()).filter(Boolean) : []
  const classpath = fm.classpath == null ? "" : String(fm.classpath).trim()

  if (problems.length || !types.in || !types["map-out"] || !types.out) {
    return { ok: false, problems }
  }

  // ── 生成 ──
  const files = {}
  const cls = {
    mapper: `${name}Mapper`,
    reducer: `${name}Reducer`,
    combiner: combine ? `${name}Reducer` : (stage.combine ? `${name}Combiner` : null),
    partitioner: stage.partition ? `${name}Partitioner` : null,
  }
  files[`${cls.mapper}.java`] = stageFile({
    cls: cls.mapper, base: "Mapper", generics: [...types.in, ...types["map-out"]],
    signature: `protected void map(${types.in[0]} key, ${types.in[1]} value, Context context)`,
    src: "map", block: stage.map, extraImports,
  })
  files[`${cls.reducer}.java`] = stageFile({
    cls: cls.reducer, base: "Reducer", generics: [...types["map-out"], ...types.out],
    signature: `protected void reduce(${types["map-out"][0]} key, Iterable<${types["map-out"][1]}> values, Context context)`,
    src: "reduce", block: stage.reduce, extraImports,
  })
  if (stage.combine) {
    files[`${cls.combiner}.java`] = stageFile({
      cls: cls.combiner, base: "Reducer", generics: [...types["map-out"], ...types["map-out"]],
      signature: `protected void reduce(${types["map-out"][0]} key, Iterable<${types["map-out"][1]}> values, Context context)`,
      src: "combine", block: stage.combine, extraImports,
    })
  }
  if (stage.partition) {
    files[`${cls.partitioner}.java`] = stageFile({
      cls: cls.partitioner, base: "Partitioner", generics: [...types["map-out"]],
      signature: `public int getPartition(${types["map-out"][0]} key, ${types["map-out"][1]} value, int numPartitions)`,
      throwsClause: "", src: "partition", block: stage.partition, extraImports,
    })
  }
  files[`${name}Main.java`] = mainFile({ name, stageClasses: cls, types, input, output, driverBlock: stage.driver, extraImports })

  return { ok: true, problems, name, jar, mainClass: `${name}Main`, input, output, classpath, files }
}

/**
 * javac 诊断回映：`WordCountMapper.java:13: error: …` → 面向片段的报错行。
 * 落在生成骨架里的错如实标注“生成骨架”，不假装是片段的错；认不出的行原样保留。
 * @param {object} w weave 的成功结果
 * @param {string} javacText javac 的 stderr/stdout 原文
 */
const remap = (w, javacText) => {
  const byName = {}
  for (const [file, entry] of Object.entries(w.files ?? {})) byName[file.toLowerCase()] = entry
  const out = []
  for (const raw of String(javacText ?? "").split(/\r?\n/)) {
    // javac 的缩进行（symbol / location / 代码行 / 脱字符）是上一条的细节，并入上一条
    if (/^[ \t]/.test(raw)) {
      if (out.length && raw.trim()) out[out.length - 1] += `｜${raw.trim()}`
      continue
    }
    const m = /([^\\/:]+\.java):(\d+):\s*(?:error|错误):\s*(.*)/.exec(raw)
    if (!m) { if (raw.trim()) out.push(raw.trim()); continue }
    const [, file, lineNo, msg] = m
    const entry = byName[file.toLowerCase()]
    const slot = entry?.lineMap[Number(lineNo) - 1]
    if (!slot) { out.push(`${file}:${lineNo}：${msg}`); continue }
    if (slot.src === "gen") out.push(`${file}:${lineNo} → 生成骨架（weave 模板，不应发生）：${msg}`)
    else out.push(`${file}:${lineNo} → ${slot.src} 片段第 ${slot.line} 行：${msg}`)
  }
  return out
}

module.exports = { weave, remap, parseTypes }
