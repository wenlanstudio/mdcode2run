/**
 * Run one jshell code block under a real JDK and bring back everything it produced.
 *
 * 为什么不用 `jshell` 命令行：jshell 在非交互模式下不回显表达式的值（实测 `-q` / `-v`
 * 都只给 System.out 的输出，`2 + 3` 什么都不打印），而 jshell 代码块的意义恰恰是
 * "写一个表达式，看到它的值"。所以这里直接用 `jdk.jshell` 的 API：由 harness 把整段源码
 * 逐个 snippet 求值，值、用户输出、编译诊断、运行时异常分别收回，写成一份 JSON——
 * 与 runner_python.js 同一套契约：临时目录 + 源码文件 + spawn 实时管道（stdout 流式外发）+ 一份 JSON。
 *
 * harness 用 `java JsBlock.java`（JDK 11+ 的单文件源码启动），随用随编译，不在
 * 用户机器上预置产物（Program Files 下也没有写权限）。代价是每次多一次编译（约 0.5s）。
 *
 * harness 本身保持纯 ASCII：它会被 javac 按平台默认编码（中文 Windows 是 GBK）读取，
 * 里面写中文就会变成乱码。用户代码一律走 block.jsh，由 harness 显式按 UTF-8 读。
 */

const fs = require("fs")
const path = require("path")
const os = require("os")
const { spawn } = require("child_process")

/** Printed output is capped: a runaway print loop must not blow up the payload. */
const MAX_TEXT = 20000

/**
 * The harness, written beside the block source (block.jsh) and launched by `java`.
 *
 * 源码必须逐个 snippet 喂给 jshell：eval 一次只吃"一个完整 snippet"，实测把
 * `String s = "abc"; s.length()` 整段丢进去，jshell 只认前半句、后半句被静默丢弃。
 * 切分交给 `analyzeCompletion`（jshell 自己的"读到了几个完整片段"判断），而不是自己按行切——
 * 方法声明、多行表达式本来就不在一行里。
 */
const HARNESS = `import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import jdk.jshell.Diag;
import jdk.jshell.EvalException;
import jdk.jshell.JShell;
import jdk.jshell.Snippet;
import jdk.jshell.SnippetEvent;
import jdk.jshell.SourceCodeAnalysis;
import jdk.jshell.VarSnippet;

public class JsBlock {
    private static final int MAX_TEXT = 20000;
    // jshell 命令行在 DEFAULT 启动脚本里预先 import 的十个包（取自 JDK 自带的
    // jdk/jshell/tool/resources/DEFAULT.jsh）。走 API 时不会自动加载它，不补上就会出现
    // "命令行里能跑、这里找不到符号" 的怪事。
    private static final String[] DEFAULT_IMPORTS = {
        "import java.io.*;",
        "import java.math.*;",
        "import java.net.*;",
        "import java.nio.file.*;",
        "import java.util.*;",
        "import java.util.concurrent.*;",
        "import java.util.function.*;",
        "import java.util.prefs.*;",
        "import java.util.regex.*;",
        "import java.util.stream.*;"
    };
    private static final List<String> VALUES = new ArrayList<String>();
    private static final List<String> PROBLEMS = new ArrayList<String>();
    private static boolean ok = true;

    public static void main(String[] args) throws Exception {
        String source = new String(Files.readAllBytes(Paths.get("block.jsh")), StandardCharsets.UTF_8);
        String classPath = readClassPath();
        ByteArrayOutputStream userOut = new ByteArrayOutputStream();
        ByteArrayOutputStream userErr = new ByteArrayOutputStream();
        JShell js = null;
        try {
            List<String> compilerOpts = new ArrayList<String>();
            List<String> remoteOpts = new ArrayList<String>();
            remoteOpts.add("-Dfile.encoding=UTF-8");
            remoteOpts.add("-Dstdout.encoding=UTF-8");
            remoteOpts.add("-Dstderr.encoding=UTF-8");
            if (!classPath.isEmpty()) {
                // --class-path 要同时喂给编译器和执行用的 JVM，两边缺一边就是"编译得过、跑起来
                // NoClassDefFound"。这也是 jshell 命令行的做法：它的 OptionKind.CLASS_PATH
                // 的 toCompiler / toRemoteVm 两个开关都是 true。
                compilerOpts.add("--class-path");
                compilerOpts.add(classPath);
                remoteOpts.add("--class-path");
                remoteOpts.add(classPath);
            }
            // 不重定向 JShell 的 out/err：用户的 System.out/err 直接走 JVM 真实管道，
            // 由 Node 侧按 chunk 流式捕获（见 runJava 的 spawn 捕获），实现真正流式输出；
            // 结构化结果（VALUES / PROBLEMS）仍走 result.json。
            js = JShell.builder()
                    .compilerOptions(compilerOpts.toArray(new String[0]))
                    .remoteVMOptions(remoteOpts.toArray(new String[0]))
                    .build();
            for (String imp : DEFAULT_IMPORTS) {
                js.eval(imp);
            }
            String remaining = source;
            while (!remaining.isEmpty()) {
                SourceCodeAnalysis.CompletionInfo info = js.sourceCodeAnalysis().analyzeCompletion(remaining);
                boolean complete = info.completeness().isComplete();
                String snippet = complete ? info.source() : remaining;
                String rest = complete ? info.remaining() : "";
                if (snippet.trim().isEmpty()) break;
                evaluate(js, snippet);
                if (!complete || rest.equals(remaining)) break;
                remaining = rest;
            }
        } catch (Throwable t) {
            ok = false;
            PROBLEMS.add(String.valueOf(t));
        } finally {
            if (js != null) {
                try { js.close(); } catch (Throwable ignored) { /* already gone */ }
            }
        }
        write(userOut.toString(StandardCharsets.UTF_8), userErr.toString(StandardCharsets.UTF_8));
    }

    private static void evaluate(JShell js, String source) {
        for (SnippetEvent event : js.eval(source)) {
            if (event.status() == Snippet.Status.REJECTED) {
                ok = false;
                PROBLEMS.add(diagnostics(js, event.snippet()));
            } else if (event.exception() != null) {
                ok = false;
                PROBLEMS.add(exception(event));
            } else {
                String value = event.value();
                if (value != null && !value.isEmpty()) {
                    VALUES.add(label(event.snippet()) + " ==> " + value);
                }
            }
        }
    }

    /** 用户给的 class-path（Node 侧展开过通配符后写进 classpath.txt）。没有这个文件就是没有。 */
    private static String readClassPath() throws Exception {
        Path p = Paths.get("classpath.txt");
        if (!Files.exists(p)) {
            return "";
        }
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8).trim();
    }

    /** jshell 的显示习惯：变量声明报变量名，表达式报源码（临时变量名 $1 对读者没有意义）。 */
    private static String label(Snippet snippet) {
        String name = snippet instanceof VarSnippet ? ((VarSnippet) snippet).name() : null;
        if (name != null && !name.isEmpty() && !name.startsWith("$")) return name;
        return snippet.source().trim();
    }

    private static String diagnostics(JShell js, Snippet snippet) {
        StringBuilder sb = new StringBuilder(snippet.source().trim()).append("\\n");
        for (Diag diag : js.diagnostics(snippet).toArray(Diag[]::new)) {
            sb.append("  ").append(diag.getMessage(Locale.getDefault())).append("\\n");
        }
        return sb.toString().trim();
    }

    private static String exception(SnippetEvent event) {
        StringBuilder sb = new StringBuilder(event.snippet().source().trim()).append("\\n");
        Throwable cause = event.exception();
        String name = cause instanceof EvalException ? ((EvalException) cause).getExceptionClassName() : cause.getClass().getName();
        sb.append("  ").append(name);
        String message = cause.getMessage();
        if (message != null && !message.isEmpty()) {
            sb.append(": ").append(message);
        }
        return sb.toString();
    }

    private static void write(String stdoutText, String stderrText) {
        String stdout = cap(stdoutText);
        String stderr = cap(stderrText);
        String text = cap(join(VALUES, "\\n"));
        String error = cap(join(PROBLEMS, "\\n"));
        if (!stderr.isEmpty()) {
            error = error.isEmpty() ? stderr : error + "\\n" + stderr;
        }
        boolean empty = VALUES.isEmpty() && stdout.isEmpty();
        String json = "{\\n"
                + "  \\"ok\\": " + ok + ",\\n"
                + "  \\"kind\\": \\"" + (empty ? "none" : "text") + "\\",\\n"
                + "  \\"stdout\\": \\"" + escape(stdout) + "\\",\\n"
                + "  \\"text\\": \\"" + escape(text) + "\\",\\n"
                + "  \\"error\\": \\"" + escape(error) + "\\"\\n"
                + "}\\n";
        try {
            Files.write(Paths.get("result.json"), json.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            System.err.println(e);
        }
    }

    private static String join(List<String> parts, String sep) {
        StringBuilder sb = new StringBuilder();
        for (String part : parts) {
            if (sb.length() > 0) sb.append(sep);
            sb.append(part);
        }
        return sb.toString();
    }

    private static String cap(String text) {
        return text.length() <= MAX_TEXT ? text : text.substring(0, MAX_TEXT) + "\\n...（已截断）";
    }

    private static String escape(String text) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': sb.append("\\\\\\""); break;
                case '\\\\': sb.append("\\\\\\\\"); break;
                case '\\n': sb.append("\\\\n"); break;
                case '\\r': sb.append("\\\\r"); break;
                case '\\t': sb.append("\\\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }
}
`

/**
 * Where a JDK's binaries are. JAVA_HOME 写 JDK 根目录（`.../jdk-17`）或 bin 目录
 * （`.../jdk-17/bin`）都接受——两种写法在笔记里都常见，为这个让人去改文档没意义。
 *
 * @param {string} javaHome
 * @returns {{ javaExe: string|null, jshellExe: string|null }}
 */
const inspectJavaHome = javaHome => {
  const raw = String(javaHome ?? "").trim().replace(/^["']|["']$/g, "")
  if (!raw) return { javaExe: null, jshellExe: null }
  const bin = /[\\/]bin[\\/]?$/i.test(raw) ? raw : path.join(raw, "bin")
  const exe = name => {
    const file = path.join(bin, process.platform === "win32" ? `${name}.exe` : name)
    return fs.existsSync(file) ? file : null
  }
  return { javaExe: exe("java"), jshellExe: exe("jshell") }
}

/**
 * 把用户写的 class-path 变成 JDK 真正能用的那一条。
 *
 * 展开 `dir/*` 是这里非做不可的一步：通配符只有 `java` / `javac` 的**命令行启动器**会展开，
 * 而我们一半路径走的是 JDK 的 API（jshell 的编译选项、JDI 另起的执行 JVM），那里没人替你展开，
 * 写 `share/hadoop/common/*` 进去就是"目录不存在"。
 *
 * 相对路径按 `baseDir`（当前文档所在目录）解析——讲义里的 jar 通常就在文档旁边。
 *
 * @param {string|string[]} raw 分隔符分隔的字符串，或 YAML 里直接给的数组
 * @param {string} [baseDir] 相对路径的基准目录
 * @returns {string} 用 path.delimiter 连接的绝对路径（可能为空串）
 */
const expandClassPath = (raw, baseDir = "") => {
  const entries = Array.isArray(raw) ? raw : String(raw ?? "").split(path.delimiter)
  const out = []
  for (const rawEntry of entries) {
    const entry = String(rawEntry ?? "").trim().replace(/^["']|["']$/g, "")
    if (!entry) continue
    const absolute = path.isAbsolute(entry) || !baseDir ? entry : path.resolve(baseDir, entry)
    if (!absolute.endsWith("*")) {
      out.push(absolute)
      continue
    }
    // `dir/*`（也认 `dir/*.jar`）：收该目录下的 jar。目录不存在就原样留下——一个不存在的
    // classpath 项对 JDK 无害，而在这里报错只会让读者以为是环境坏了。
    const dir = path.dirname(absolute)
    if (!fs.existsSync(dir)) {
      out.push(absolute)
      continue
    }
    for (const name of fs.readdirSync(dir)) {
      if (name.toLowerCase().endsWith(".jar")) out.push(path.join(dir, name))
    }
  }
  return out.join(path.delimiter)
}

/**
 * @param {string} javaExe absolute path to java(.exe)
 * @param {string} source the code block's source
 * @param {{ timeout?: number, classPath?: string }} [opts]
 * @returns {Promise<{ ok: boolean, kind: string, stdout: string, text: string, error: string }>}
 */
const runJava = async (javaExe, source, opts = {}) => {
  const timeout = Number(opts.timeout ?? 60000)
  const onChunk = opts.onChunk
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdcode2run-java-"))
  // class-path 走文件而不是命令行参数：Hadoop 全套 jar 展开后几万字符，塞进 argv 迟早撞上
  // Windows 的 32767 长度上限。
  if (opts.classPath) fs.writeFileSync(path.join(dir, "classpath.txt"), opts.classPath, "utf8")
  fs.writeFileSync(path.join(dir, "block.jsh"), source, "utf8")
  fs.writeFileSync(path.join(dir, "JsBlock.java"), HARNESS, "utf8")

  // The temp directory means nothing to the reader, so it is scrubbed out of every message.
  const clean = text => String(text ?? "").split(dir + path.sep).join("").split(dir).join("")

  try {
    // spawn + 管道：stdout/stderr 实时按 chunk 回调（onChunk）。结构化结果仍走 result.json。
    const { stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn(javaExe, ["-Dfile.encoding=UTF-8", "JsBlock.java"], { cwd: dir, windowsHide: true })
      // setEncoding 而非 chunk.toString("utf8")：后者会在 chunk 边界切坏多字节字符（中文输出乱码），
      // 前者内部用 StringDecoder 跨 chunk 拼接。
      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      let stdout = ""
      let stderr = ""
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL") }, timeout)
      child.stdout.on("data", chunk => {
        if (stdout.length < MAX_TEXT) stdout += chunk   // 最终回传的结果仍限额，防失控输出撑爆载荷
        onChunk?.({ stream: "stdout", text: chunk })
      })
      child.stderr.on("data", chunk => {
        if (stderr.length < MAX_TEXT) stderr += chunk
        onChunk?.({ stream: "stderr", text: chunk })
      })
      child.on("error", err => { clearTimeout(timer); reject(err) })
      child.on("close", () => {
        clearTimeout(timer)
        if (timedOut && !fs.existsSync(path.join(dir, "result.json"))) {
          reject(new Error(clean(stderr).trim() || "Java 执行超时"))
        } else {
          resolve({ stdout, stderr })
        }
      })
    })

    const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"))
    result.error = clean(result.error)
    result.stdout = clean(stdout)   // 来自实时管道（harness 已不再重定向）
    result.text = result.text ?? ""
    if (!result.ok && !result.error) result.error = clean(stderr).trim() || "Java 执行失败"
    return result
  } catch (error) {
    throw error
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* already gone */ }
  }
}

module.exports = { runJava, inspectJavaHome, expandClassPath, MAX_TEXT }
