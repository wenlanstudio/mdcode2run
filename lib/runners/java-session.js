/**
 * 常驻 JShell 会话——「可执行讲义」eval 原型的 Java 实现（DESIGN.md §5）。
 *
 * 与 runner_java.js（一次性）的本质区别：JVM 与 JShell 实例跨块存活，同一章里的块
 * 共享同一个状态世界——setup 块里声明的变量与类，后续片段块直接用（wordcount 讲义的
 * mapper/reducer 片段因此才能逐块跑）。工作目录（cwd）即 DESIGN 的「章工作目录」：
 * 用户代码里的相对路径（FileReader("bigdata.txt")）落在章里。
 *
 * 协议（无需握手：请求先进 OS 管道，harness 就绪后自然读到）：
 *   Node → stdin   每行一个请求 {"op":"eval"|"reset","id":N,"token":"<hex16>","file":"<req 文件>"}
 *   stdout         用户程序的 System.out（jshell 执行引擎转发，真实流式）+ 每请求收尾一行
 *                  `MDXDONE <id> <token>`——token 由 Node 每请求随机生成，用户程序撞不出来
 *   stderr         用户 System.err 与 JVM/harness 自身的错误
 *   .md-exec/res-<id>.json  结构化结果 {"ok":bool,"values":[..],"problems":[..]}
 *
 * 状态边界的诚实说明：片段状态活在 jshell 的执行引擎（另一个 JVM）里——用户代码
 * System.exit 会杀掉引擎，jshell 下次 eval 自动重建引擎，但**状态清零**；Node 侧杀的是
 * harness（本 JVM），整个会话作废、下次 acquire 全新重建。两者都表现为"会话没了"，
 * 差别只在要不要重启 harness。
 *
 * HARNESS 用 String.raw：里面就是 Java 源码本来的样子，不再过 JS 转义层。
 * harness 保持纯 ASCII（javac 按平台默认编码 GBK 读它，写中文必乱码）；用户代码一律
 * 走 req 文件由 harness 显式按 UTF-8 读。
 */

const fs = require("fs")
const path = require("path")
const os = require("os")
const crypto = require("crypto")
const { spawn } = require("child_process")

const MAX_TEXT = 20000

/**
 * The session harness, written into <workdir>/.md-exec and launched by `java` once per
 * session; it then serves eval/reset requests until stdin closes. ASCII only.
 */
const HARNESS = String.raw`import java.io.BufferedReader;
import java.io.InputStreamReader;
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

public class JsSession {
    // jshell 命令行在 DEFAULT 启动脚本里预先 import 的十个包（与 JsBlock 相同，见彼处注释）
    private static final String[] DEFAULT_IMPORTS = {
        "import java.io.*;", "import java.math.*;", "import java.net.*;",
        "import java.nio.file.*;", "import java.util.*;", "import java.util.concurrent.*;",
        "import java.util.function.*;", "import java.util.prefs.*;", "import java.util.regex.*;",
        "import java.util.stream.*;"
    };
    private static JShell js;

    public static void main(String[] args) throws Exception {
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;
            handle(line);
        }
        closeJs();
    }

    private static void handle(String line) throws Exception {
        String id = field(line, "id");
        String token = field(line, "token");
        String op = field(line, "op");
        List<String> values = new ArrayList<String>();
        List<String> problems = new ArrayList<String>();
        boolean ok = true;
        if ("reset".equals(op)) {
            closeJs();
        } else if ("eval".equals(op)) {
            String source = new String(Files.readAllBytes(Paths.get(field(line, "file"))), StandardCharsets.UTF_8);
            try {
                ensureJs();
                StringBuilder remaining = new StringBuilder(source);
                while (remaining.length() > 0) {
                    SourceCodeAnalysis.CompletionInfo info = js.sourceCodeAnalysis().analyzeCompletion(remaining.toString());
                    boolean complete = info.completeness().isComplete();
                    String snippet = complete ? info.source() : remaining.toString();
                    if (snippet.trim().isEmpty()) break;
                    StringBuilder rest = new StringBuilder(complete ? info.remaining() : "");
                    evaluate(snippet, values, problems);
                    ok = ok && problems.isEmpty();
                    if (!complete || rest.toString().equals(remaining.toString())) break;
                    remaining = rest;
                }
            } catch (Throwable t) {
                ok = false;
                problems.add(String.valueOf(t));
            }
        } else {
            ok = false;
            problems.add("unknown op: " + op);
        }
        writeResult(id, ok, values, problems);
        System.out.println("MDXDONE " + id + " " + token);
        System.out.flush();
    }

    private static void ensureJs() throws Exception {
        if (js != null) return;
        String classPath = readClassPath();
        List<String> compilerOpts = new ArrayList<String>();
        List<String> remoteOpts = new ArrayList<String>();
        remoteOpts.add("-Dfile.encoding=UTF-8");
        remoteOpts.add("-Dstdout.encoding=UTF-8");
        remoteOpts.add("-Dstderr.encoding=UTF-8");
        if (!classPath.isEmpty()) {
            // 两边都要（见 JsBlock 注释）：编译器找得到符号，执行引擎跑得起来
            compilerOpts.add("--class-path");
            compilerOpts.add(classPath);
            remoteOpts.add("--class-path");
            remoteOpts.add(classPath);
        }
        js = JShell.builder()
                .compilerOptions(compilerOpts.toArray(new String[0]))
                .remoteVMOptions(remoteOpts.toArray(new String[0]))
                .build();
        for (String imp : DEFAULT_IMPORTS) {
            js.eval(imp);
        }
    }

    private static void closeJs() {
        if (js != null) {
            try { js.close(); } catch (Throwable ignored) { }
            js = null;
        }
    }

    private static void evaluate(String source, List<String> values, List<String> problems) {
        for (SnippetEvent event : js.eval(source)) {
            if (event.status() == Snippet.Status.REJECTED) {
                problems.add(diagnostics(event.snippet()));
            } else if (event.exception() != null) {
                problems.add(exception(event));
            } else {
                String value = event.value();
                if (value != null && !value.isEmpty()) {
                    values.add(label(event.snippet()) + " ==> " + value);
                }
            }
        }
    }

    private static String readClassPath() throws Exception {
        Path p = Paths.get(".md-exec", "java", "classpath.txt");
        if (!Files.exists(p)) return "";
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8).trim();
    }

    private static String label(Snippet snippet) {
        String name = snippet instanceof VarSnippet ? ((VarSnippet) snippet).name() : null;
        if (name != null && !name.isEmpty() && !name.startsWith("$")) return name;
        return snippet.source().trim();
    }

    private static String diagnostics(Snippet snippet) {
        StringBuilder sb = new StringBuilder(snippet.source().trim()).append("\n");
        for (Diag diag : js.diagnostics(snippet).toArray(Diag[]::new)) {
            sb.append("  ").append(diag.getMessage(Locale.getDefault())).append("\n");
        }
        return sb.toString().trim();
    }

    private static String exception(SnippetEvent event) {
        StringBuilder sb = new StringBuilder(event.snippet().source().trim()).append("\n");
        Throwable cause = event.exception();
        String name = cause instanceof EvalException ? ((EvalException) cause).getExceptionClassName() : cause.getClass().getName();
        sb.append("  ").append(name);
        String message = cause.getMessage();
        if (message != null && !message.isEmpty()) {
            sb.append(": ").append(message);
        }
        return sb.toString();
    }

    /** 请求字段都是 Node 侧生成的不含转义字符的简单值（hex / 数字 / .md-exec 路径），直接正则取。 */
    private static String field(String line, String name) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"" + name + "\"\\s*:\\s*\"([^\"]*)\"").matcher(line);
        return m.find() ? m.group(1) : "";
    }

    private static void writeResult(String id, boolean ok, List<String> values, List<String> problems) {
        StringBuilder sb = new StringBuilder("{\"ok\": ");
        sb.append(ok);
        sb.append(", \"values\": [");
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append("\"").append(escape(values.get(i))).append("\"");
        }
        sb.append("], \"problems\": [");
        for (int i = 0; i < problems.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append("\"").append(escape(problems.get(i))).append("\"");
        }
        sb.append("]}");
        try {
            Files.write(Paths.get(".md-exec", "java", "res-" + id + ".json"), sb.toString().getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            System.err.println(e);
        }
    }

    private static String escape(String text) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }
}
`

/**
 * 一个常驻会话。eval/reset 排队串行（jshell 的状态世界只有一个）；每个请求有独立的
 * 超时与 token。进程死了（kill / 崩溃）→ alive=false，挂着的请求全部 reject，注册表
 * 下次 acquire 会重建全新会话（状态丢失，这是讲义语义下可接受的代价）。
 */
class JShellSession {
  /**
   * @param {{ javaExe: string, classPath?: string, workdir: string, ownsWorkdir?: boolean }} opts
   *   workdir 即章工作目录：JVM 的 cwd（用户相对路径的基准），文件物化与协议文件(.md-exec/java/)
   *   的家。章目录由多方共享（shell/java 同章同目录），默认**不**随会话销毁而删除；
   *   仅当调用方没有章概念（自建临时目录，ownsWorkdir=true）时才整目录删除。
   */
  constructor({ javaExe, classPath = "", workdir, ownsWorkdir = false }) {
    this._javaExe = javaExe
    this._classPath = classPath ?? ""
    this._workdir = workdir
    this._ownsWorkdir = !!ownsWorkdir
    this._child = null
    this._dead = false
    this._lineBuf = ""
    this._pending = null          // { id, token, resolve, reject, timer, stdout, stderr, onChunk }
    this._nextId = 1
    this._queue = Promise.resolve()
  }

  get alive() {
    return !this._dead && this._child !== null && this._child.exitCode === null
  }

  /**
   * 跑一块代码，返回与一次性 runner 相同的契约：{ ok, kind, stdout, text, error }。
   * @param {string} source 代码块源码
   * @param {{ onChunk?: (c: {stream: "stdout"|"stderr", text: string}) => void, timeout?: number }} [opts]
   */
  eval(source, opts = {}) {
    return this._enqueue((resolve, reject) => this._request("eval", source, opts, resolve, reject))
  }

  /** 清空状态（JShell 重建，classpath.txt 重新读取——改 classpath 后 reset 即生效）。 */
  reset(opts = {}) {
    return this._enqueue((resolve, reject) => this._request("reset", "", opts, resolve, reject))
  }

  destroy(reason = "destroy") {
    this._dead = true
    const child = this._child
    this._child = null
    this._failPending(`JShell 会话已终止（${reason}）`)
    if (child) {
      try { child.kill() } catch { /* already gone */ }
    }
    // 章工作目录是共享的（file= 物化产物 / 其他语言的会话都在里面），只清自己的协议文件；
    // 整目录删除仅限自建临时目录的场合
    try {
      if (this._ownsWorkdir) fs.rmSync(this._workdir, { recursive: true, force: true })
      else fs.rmSync(this._auxDir(), { recursive: true, force: true })
    } catch { /* best effort */ }
  }

  // ==================== 内部 ====================

  _auxDir = () => path.join(this._workdir, ".md-exec", "java")

  _enqueue(body) {
    if (this._dead) return Promise.reject(new Error("JShell 会话已终止"))
    const run = () => new Promise(body)
    const next = this._queue.then(run, run)
    // 单个请求的失败不能毒化队列（队列本身只为串行，不为传递错误）
    this._queue = next.then(() => undefined, () => undefined)
    return next
  }

  _ensureChild() {
    if (this._child) return this._child
    const aux = this._auxDir()
    fs.mkdirSync(aux, { recursive: true })
    fs.writeFileSync(path.join(aux, "JsSession.java"), HARNESS, "utf8")
    if (this._classPath) fs.writeFileSync(path.join(aux, "classpath.txt"), this._classPath, "utf8")
    const child = spawn(this._javaExe, ["-Dfile.encoding=UTF-8", path.join(".md-exec", "java", "JsSession.java")], {
      cwd: this._workdir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", chunk => this._onStdout(chunk))
    child.stderr.on("data", chunk => this._onStderr(chunk))
    child.on("error", err => {
      this._child = null
      this._dead = true
      this._failPending(`无法启动 java（JShell 会话）: ${err.message}`)
    })
    child.on("close", () => {
      if (this._child === child) this._child = null
      if (!this._dead) {
        this._dead = true
        this._failPending("JShell 会话已终止（JVM 退出）")
      }
    })
    this._child = child
    return child
  }

  _request(op, source, opts, resolve, reject) {
    if (this._dead) {
      reject(new Error("JShell 会话已终止"))
      return
    }
    const child = this._ensureChild()
    const id = this._nextId++
    const token = crypto.randomBytes(8).toString("hex")
    const file = `.md-exec/java/req-${id}.jsh`
    fs.writeFileSync(path.join(this._workdir, file), source, "utf8")
    const pending = {
      id,
      token,
      resolve,
      reject,
      stdout: "",
      stderr: "",
      onChunk: opts.onChunk,
      timer: null,
    }
    pending.timer = setTimeout(() => {
      if (this._pending === pending) this._pending = null
      this.destroy("timeout")
      reject(new Error("Java 执行超时（会话已终止，下次运行将重建会话）"))
    }, Number(opts.timeout ?? 60000))
    this._pending = pending
    try {
      // id 发字符串：harness 的字段正则只认带引号的值，数字会被它丢成空串（哨兵就永远对不上）
      child.stdin.write(`${JSON.stringify({ op, id: String(id), token, file })}\n`)
    } catch (err) {
      clearTimeout(pending.timer)
      if (this._pending === pending) this._pending = null
      reject(new Error(`会话管道已断开: ${err.message}`))
    }
  }

  /** stdout 按行扫描：哨兵行收请求，其余是用户程序输出——立即转发（流式）并记账。 */
  _onStdout(chunk) {
    this._lineBuf += chunk
    let idx
    while ((idx = this._lineBuf.indexOf("\n")) >= 0) {
      const line = this._lineBuf.slice(0, idx).replace(/\r$/, "")
      this._lineBuf = this._lineBuf.slice(idx + 1)
      this._onLine(line)
    }
  }

  _onLine(line) {
    const pending = this._pending
    const m = /^MDXDONE (\d+) ([0-9a-f]{16})$/.exec(line)
    if (m && pending && Number(m[1]) === pending.id && m[2] === pending.token) {
      this._finish(pending)
      return
    }
    if (pending) {
      pending.stdout += line + "\n"
      pending.onChunk?.({ stream: "stdout", text: line + "\n" })
    }
  }

  _onStderr(chunk) {
    const pending = this._pending
    if (pending) {
      pending.stderr += chunk
      pending.onChunk?.({ stream: "stderr", text: chunk })
    }
  }

  _finish(pending) {
    clearTimeout(pending.timer)
    if (this._pending === pending) this._pending = null
    let parts
    try {
      parts = JSON.parse(fs.readFileSync(path.join(this._workdir, ".md-exec", "java", `res-${pending.id}.json`), "utf8"))
    } catch (err) {
      pending.reject(new Error(`会话结果读取失败: ${err.message}`))
      return
    }
    const clean = text => String(text ?? "").split(this._workdir + path.sep).join("").split(this._workdir).join("")
    const stdout = cap(clean(pending.stdout))
    const values = parts.values ?? []
    const problems = parts.problems ?? []
    let error = cap(problems.join("\n"))
    const stderr = cap(clean(pending.stderr))
    if (stderr) error = error ? `${error}\n${stderr}` : stderr
    const empty = values.length === 0 && !stdout.trim()
    pending.resolve({
      ok: !!parts.ok && problems.length === 0,
      kind: empty ? "none" : "text",
      stdout,
      text: cap(values.join("\n")),
      error,
    })
  }

  _failPending(message) {
    const pending = this._pending
    if (!pending) return
    clearTimeout(pending.timer)
    this._pending = null
    pending.reject(new Error(message))
  }
}

const cap = text => (text.length <= MAX_TEXT ? text : text.slice(0, MAX_TEXT) + "\n...（已截断）")

/**
 * 造一个会话。带 workdir（章工作目录，session-run.js 传入）＝共享目录，销毁只清
 * `.md-exec/java/`；不带＝自建临时目录、销毁时整个删掉（测试与无章概念的场合）。
 */
const createJShellSession = ({ javaExe, classPath = "", workdir = "", workdirPrefix = "md-exec-jshell-" }) => {
  if (!javaExe) throw new Error("没有可用的 java 可执行文件")
  if (workdir) return new JShellSession({ javaExe, classPath, workdir, ownsWorkdir: false })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), workdirPrefix))
  return new JShellSession({ javaExe, classPath, workdir: dir, ownsWorkdir: true })
}

module.exports = { JShellSession, createJShellSession, MAX_TEXT }
