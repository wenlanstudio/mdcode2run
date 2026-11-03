"use strict"
/**
 * 作业管线——物化 file= → 织入 → javac → jar → 提交（流式日志、超时、树杀）。
 *
 * 管线里只有这一层碰进程与文件；parse/weave 是纯函数。步骤边界清晰，失败时
 * result.step 告诉你死在哪一步，javac 失败经 remap 回映成片段行号。
 * 提交后端本地 spawn 起步；上集群是加一个 exec 后端的事（spawn 点已收拢在 submit）。
 */
const fs = require("fs")
const path = require("path")
const { spawn, spawnSync } = require("child_process")
const { parseDoc, badRelPath } = require("./parse")
const { weave, remap } = require("./weave")

const WIN = process.platform === "win32"
const CP_SEP = WIN ? ";" : ":"

const q = s => `"${String(s)}"`

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// Windows：目录可能被杀软扫描 / 残留 JVM 的 cwd 短暂锁住——rmSync 带退避重试；
// 实在删不掉就退而清空子项（javac/jar 拿的是显式文件清单，陈旧产物进不了链路）。
const rmRf = (p, tries = 6) => {
  if (!fs.existsSync(p)) return true
  for (let i = 0; i < tries; i++) {
    try {
      fs.rmSync(p, { recursive: true, force: true })
      return !fs.existsSync(p)
    } catch (e) {
      if (!["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"].includes(e.code)) throw e
      sleep(250)
    }
  }
  try {
    for (const c of fs.readdirSync(p)) {
      try { fs.rmSync(path.join(p, c), { recursive: true, force: true }) } catch { /* 子项也被锁就带病上阵 */ }
    }
  } catch { /* 目录句柄本身被锁 */ }
  return false
}

// hadoop-config.cmd 的 JAVA_HOME 检查等发行版脚本问题，本地后端靠绕开而非修补——
// 见 submit 处注释。

// ── 环境解析 ──────────────────────────────────────────────────────────────
// JDK：MDX_JDK_HOME → JAVA_HOME（值可写 JDK 根目录，也可写 bin 目录）
const jdkOf = override => {
  const home = String(override ?? process.env.MDX_JDK_HOME ?? process.env.JAVA_HOME ?? "").trim()
  if (!home) return null
  const bin = /[\\/]bin$/.test(home) ? home : path.join(home, "bin")
  const exe = name => path.join(bin, WIN ? `${name}.exe` : name)
  return fs.existsSync(exe("javac")) ? { bin, javac: exe("javac"), jar: exe("jar"), home } : null
}

// hadoop：MDX_HADOOP_HOME → HADOOP_HOME；必须是完整发行版（share/hadoop 下有客户端 jar）
const hadoopHomeOf = override => {
  for (const candidate of [override, process.env.MDX_HADOOP_HOME, process.env.HADOOP_HOME]) {
    const home = String(candidate ?? "").trim()
    if (home && fs.existsSync(path.join(home, "share", "hadoop", "common"))) return home
  }
  return null
}

// 原生层（winutils.exe + hadoop.dll 所在的 bin）：与 jar 的目录**不是一回事**——
// 课程机的常见组合就是「3.1.0 的 winutils 工具包 + 3.1.3 的发行版 jar」。
// 解析：MDX_WINUTILS_HOME → 带着 winutils 的 HADOOP_HOME → jar 目录自己。
const nativeHomeOf = jarHome => {
  for (const candidate of [process.env.MDX_WINUTILS_HOME, process.env.HADOOP_HOME, jarHome]) {
    const home = String(candidate ?? "").trim()
    if (home && fs.existsSync(path.join(home, "bin", WIN ? "winutils.exe" : "winutils"))) return home
  }
  return null
}

// javac classpath：fm.classpath（分号分隔，支持 dir/*）优先，否则发行版客户端 jar 全集
const expandCpEntry = entry => {
  const p = entry.trim()
  if (!p) return []
  if (p.endsWith("*")) {
    const dir = p.slice(0, -1)
    try {
      return fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".jar")).sort().map(f => path.join(dir, f))
    } catch { return [] }
  }
  return [p]
}

const classPathOf = (fmCp, hadoopHome) => {
  if (String(fmCp ?? "").trim()) {
    return String(fmCp).split(CP_SEP).flatMap(expandCpEntry).join(CP_SEP)
  }
  if (!hadoopHome) return ""
  const subs = ["common", "common/lib", "hdfs", "hdfs/lib", "mapreduce", "mapreduce/lib", "yarn", "yarn/lib"]
  const jars = []
  for (const sub of subs) {
    const dir = path.join(hadoopHome, "share", "hadoop", ...sub.split("/"))
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.toLowerCase().endsWith(".jar")) jars.push(path.join(dir, f))
      }
    } catch { /* 发行版缺子目录不致命 */ }
  }
  return jars.join(CP_SEP)
}

// ── 进程底座：流式 + 超时 + 树杀 ─────────────────────────────────────────
const killTree = pid => {
  if (WIN) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
  else try { process.kill(-pid, "SIGKILL") } catch { try { process.kill(pid, "SIGKILL") } catch {} }
}

const runProc = (cmd, args, { cwd, env, timeoutMs = 120000, onChunk, verbatim = false } = {}) =>
  new Promise(resolve => {
    const child = spawn(cmd, args, { cwd, env: env ?? process.env, windowsHide: true, windowsVerbatimArguments: verbatim })
    let stdout = ""
    let stderr = ""
    const sink = (stream, chunk) => {
      const text = chunk.toString()
      if (stream === "stdout") stdout += text
      else stderr += text
      onChunk?.({ stream, text })
    }
    child.stdout?.on("data", d => sink("stdout", d))
    child.stderr?.on("data", d => sink("stderr", d))
    const timer = setTimeout(() => killTree(child.pid), timeoutMs)
    child.on("error", e => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e) }) })
    child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })

// ── 管线 ─────────────────────────────────────────────────────────────────
/**
 * @param {string} docPath 讲义路径（工作目录 = <docDir>/.mdjob/）
 * @param {{compileOnly?: boolean, jdkHome?: string, hadoopHome?: string,
 *          timeoutMs?: number, onChunk?: fn, onStage?: fn}} [opts]
 * @returns {Promise<{ok, step, problems?, code?, stdout?, stderr?, doc, workdir, jar?, files?}>}
 */
const runJob = async (docPath, opts = {}) => {
  docPath = path.resolve(docPath)
  const docDir = path.dirname(docPath)
  const workdir = path.join(docDir, ".mdjob")
  const { fm, blocks, problems: fmProblems } = parseDoc(fs.readFileSync(docPath, "utf8"))

  // 无歧义门禁：解析层任何 problems（未知标注 / 角色冲突 / fm 拼写）都拒绝执行
  const parseProblems = [...fmProblems]
  for (const b of blocks) for (const p of b.problems) parseProblems.push(`第 ${b.line + 1} 行：${p}`)
  if (parseProblems.length) return { ok: false, step: "parse", problems: parseProblems, doc: docPath, workdir }

  const w = weave(fm, blocks)
  if (!w.ok) return { ok: false, step: "weave", problems: w.problems, doc: docPath, workdir }

  rmRf(workdir)
  for (const d of ["src", "classes", "data", "conf"]) fs.mkdirSync(path.join(workdir, d), { recursive: true })

  // 本地跑的 hermetic 配置：默认的 /tmp、/tmp/hadoop/mapred/staging 这类无盘符路径
  // 在 Windows 原生层（winutils/hadoop.dll）上 mkdirs 直接失败——全部钉进作业工作目录
  // （带盘符）。走 classpath 上的 core-site.xml：-D 系统属性对 Hadoop 配置键无效。
  const W = workdir.split(path.sep).join("/")
  fs.writeFileSync(path.join(workdir, "conf", "core-site.xml"), `<?xml version="1.0"?>
<configuration>
  <property><name>hadoop.tmp.dir</name><value>${W}/tmp</value></property>
  <property><name>mapreduce.jobtracker.staging.root.dir</name><value>${W}/staging</value></property>
  <property><name>mapreduce.cluster.local.dir</name><value>${W}/local</value></property>
  <property><name>yarn.app.mapreduce.am.staging-dir</name><value>${W}/staging</value></property>
</configuration>
`, "utf8")

  for (const b of blocks) {
    if (b.role !== "file" || b.problems.length) continue
    fs.writeFileSync(path.join(workdir, b.file), b.code.endsWith("\n") ? b.code : b.code + "\n", "utf8")
  }
  const fileNames = []
  for (const [name, f] of Object.entries(w.files)) {
    fs.writeFileSync(path.join(workdir, "src", name), f.code + "\n", "utf8")
    fileNames.push(name)
  }
  opts.onStage?.("weave", { files: fileNames, workdir })

  const jdk = jdkOf(opts.jdkHome)
  if (!jdk) return { ok: false, step: "javac", problems: ["找不到 JDK：请设 MDX_JDK_HOME 或 JAVA_HOME"], doc: docPath, workdir }
  const hadoopHome = hadoopHomeOf(opts.hadoopHome)
  const cp = classPathOf(w.classpath, hadoopHome)
  if (!cp) {
    return {
      ok: false, step: "javac", doc: docPath, workdir,
      problems: ["找不到 hadoop 客户端 jar：MDX_HADOOP_HOME / HADOOP_HOME 须指向完整发行版（含 share/hadoop），或在 mr-job.classpath 里写 jar 位置"],
    }
  }

  const classes = path.join(workdir, "classes")
  const srcs = fileNames.map(n => path.join(workdir, "src", n))
  // -J-Duser.language=en：javac 诊断钉死英文（系统中文 locale 的 GBK 输出会打碎
  // remap 的行匹配；诊断是机器要读的，稳定性优先于本地化）
  const c = await runProc(jdk.javac,
    ["-J-Duser.language=en", "-encoding", "UTF-8", "-cp", cp, "-d", classes, ...srcs], {
    timeoutMs: 60000, onChunk: opts.onChunk,
  })
  if (c.code !== 0) return { ok: false, step: "javac", problems: remap(w, c.stderr || c.stdout), doc: docPath, workdir }

  const jarPath = path.join(workdir, w.jar)
  const j = await runProc(jdk.jar, ["cfe", jarPath, w.mainClass, "-C", classes, "."], { timeoutMs: 60000 })
  if (j.code !== 0) return { ok: false, step: "jar", problems: (j.stderr || j.stdout).split("\n").filter(Boolean), doc: docPath, workdir }

  if (opts.compileOnly) return { ok: true, step: "jar", doc: docPath, workdir, jar: jarPath, files: fileNames }

  // MR 规矩：输出目录必须不存在。引擎代劳清除并提示（作业可重复提交）。
  const outDir = path.join(workdir, w.output)
  if (fs.existsSync(outDir)) {
    rmRf(outDir)
    opts.onStage?.("clean", { path: outDir })
  }

  // 提交。本地后端 = IDEA 式直接启动主类（绕开 hadoop.cmd：发行版脚本对带空格的
  // JDK 路径有多处裸展开；且 hadoop jar 外壳对本机调试没有增益）。classpath =
  // conf（hermetic core-site）+ classes + 发行版 jar 全集。集群后端（ssh 上跑真
  // hadoop jar，jar 已产出待分发）后续接入。
  const nativeHome = nativeHomeOf(hadoopHome)
  const nativeBin = nativeHome ? path.join(nativeHome, "bin") : path.join(hadoopHome, "bin")
  if (WIN && !nativeHome) {
    opts.onStage?.("notice", { text: "没找到 winutils（bin/winutils.exe）：本地提交会在原生文件操作上失败。设 MDX_WINUTILS_HOME 指向 winutils 工具包。" })
  }
  const env = {
    ...process.env,
    HADOOP_HOME: nativeHome ?? hadoopHome,   // winutils / hadoop.dll 的查找锚点
    JAVA_HOME: jdk.home.replace(/[\\/]bin$/, ""),
  }
  env.PATH = `${nativeBin}${path.delimiter}${path.join(jdk.bin)}${path.delimiter}${env.PATH ?? ""}`
  const s = await runProc(path.join(jdk.bin, WIN ? "java.exe" : "java"),
    // java.library.path 指向原生 bin——hadoop.dll 在那里（原生 chmod/mkdir 走它）；
    // 绕过 hadoop.cmd 时得自己给。路径一律正斜杠（Hadoop Path 对反斜杠不友好）。
    [WIN ? `-Djava.library.path=${nativeBin}` : "-Djava.library.path=...",
      "-cp", [path.join(workdir, "conf"), classes, cp].join(CP_SEP), w.mainClass,
      path.join(workdir, w.input).split(path.sep).join("/"),
      outDir.split(path.sep).join("/")],
    { cwd: workdir, env, timeoutMs: opts.timeoutMs ?? 180000, onChunk: opts.onChunk })

  return {
    ok: s.code === 0, step: "submit", code: s.code, stdout: s.stdout, stderr: s.stderr,
    doc: docPath, workdir, jar: jarPath, files: fileNames,
    output: outDir,
  }
}

module.exports = { runJob, classPathOf, jdkOf, hadoopHomeOf }
