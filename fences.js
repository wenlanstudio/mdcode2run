/**
 * 围栏代码块的解析与「分页切片还原」——放映态跨插件共用的能力。
 *
 * 存在的理由：marp 分页时 overflow.js 的 splitCodeBlock 会把过长的代码块**按行切成多片**，
 * 每片各自渲染到一张幻灯片上，且切片后不留「我属于哪个原始块」的痕迹。于是 deck 里那个 pre
 * 的 textContent 只是原块的一段连续行——拿去执行就是半截代码（缺变量声明、SQL 截在半路）。
 * 要跑就得跑源码里完整的那一块，所以得先从源码把块解析出来，再把片段按连续行对回整块。
 *
 * 这份知识不属于任何一个具体插件：shell / java / python 在放映态面对的是同一件事，
 * 所以放在这里，而不是塞进某个 exec_* 里。纯函数，不依赖 Typora / DOM，可单测。
 */

/**
 * 块角色词汇表与标注解析（DESIGN.md §3）。
 *
 * fence info-string 语法：语言在前，其后空格分隔的标注——
 *   旗标：demo（示意块）/ setup（引导块）/ job（作业模式：异步启动、日志流、可终止）
 *   键值：file=<相对路径> / session=<名> / dialect=<名> / workdir=<路径>
 * 值可用单双引号包住（路径含空格时）。job 是**执行模式**不是角色——块仍是 code，
 * 但与 demo/setup/file 互斥（示意块不该起作业；setup 要求幂等，起作业不幂等；
 * 文件块不执行）。未知 token 一律忽略，但未知的 key=value 记入 problems（多半是
 * 拼错标注）；problems 非空的块不参与执行 / 物化，只作展示。
 */
const META_FLAGS = { demo: "demo", setup: "setup" }
const META_KEYS = new Set(["file", "session", "dialect", "workdir"])
const META_TOKEN = /([A-Za-z][\w-]*)[ \t]*=[ \t]*(?:"([^"]*)"|'([^']*)'|([^\s]*))|(\S+)/g

// file= 必须是章工作目录内的相对路径：禁空、禁绝对、禁 .. 逃逸
const badRelPath = p => !p || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p) || p.split(/[\\/]/).includes("..")

/**
 * 解析 fence info-string。
 * @param {string} info 围栏开启行的标注串（语言 + 标注）
 * @returns {{lang: string, meta: {role: string, job?: boolean, file?: string,
 *   session?: string, dialect?: string, workdir?: string, problems: string[]}}}
 *   role ∈ code | demo | setup | file | invalid（冲突）；值保留原样大小写。
 */
const parseFenceInfo = info => {
  const text = String(info ?? "").split("`")[0].trim()
  const lang = (text.match(/^[^\s]+/) || [""])[0].toLowerCase()
  const roles = []
  const seen = {}
  const problems = []
  let jobRequested = false
  let m
  META_TOKEN.lastIndex = text.length ? (text.match(/^[^\s]+/) || [""])[0].length : 0
  while ((m = META_TOKEN.exec(text))) {
    if (m[5] !== undefined) {                       // 旗标 / 无关词
      const word = m[5].toLowerCase()
      if (word === "job") { jobRequested = true; continue }
      const flag = META_FLAGS[word]
      if (flag && !roles.includes(flag)) roles.push(flag)
      continue                                      // 其余裸词不属于本词汇表，忽略
    }
    const key = m[1].toLowerCase()
    if (!META_KEYS.has(key)) { problems.push(`未知标注 ${m[1]}=`); continue }
    if (seen[key] !== undefined) { problems.push(`重复标注 ${key}=`); continue }
    const value = m[2] ?? m[3] ?? m[4] ?? ""
    seen[key] = value
    if (key === "file" && badRelPath(value)) problems.push(`file= 须为章工作目录内的相对路径：${value || "(空)"}`)
    if (key !== "file" && !value) problems.push(`${key}= 值为空`)
  }
  if (seen.file !== undefined) roles.push("file")
  let role = "code"
  if (roles.length === 1) role = roles[0]
  else if (roles.length > 1) { role = "invalid"; problems.push(`角色冲突：${roles.join(" + ")}`) }
  const job = jobRequested && role === "code"
  if (jobRequested && !job) { role = "invalid"; problems.push("job 与 demo/setup/file 互斥") }
  const meta = { role, problems }
  if (job) meta.job = true
  for (const k of ["file", "session", "dialect", "workdir"]) if (seen[k] !== undefined) meta[k] = seen[k]
  return { lang, meta }
}

/**
 * 解析 md 源码里所有围栏代码块（按出现顺序）。
 * @param {string} md markdown 源码
 * @returns {{lang: string, code: string, meta: object, line: number, end: number}[]}
 *   line/end 为开启/结束行号（0 基，end 指向闭合围栏的下一行；未闭合 = 总行数）。
 */
const parseFences = md => {
  const lines = String(md ?? "").split(/\r?\n/)
  const out = []
  let i = 0
  while (i < lines.length) {
    const open = /^(\s{0,3})(`{3,}|~{3,})[ \t]*(.*)/.exec(lines[i])
    if (!open) { i += 1; continue }
    const openLine = i
    const indent = open[1]
    const fence = open[2]
    // 闭合围栏：同字符、不短于开启、其后只有空白
    const closeRe = new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}[ \\t]*$`)
    const body = []
    i += 1
    for (; i < lines.length; i++) {
      if (closeRe.test(lines[i])) { i += 1; break }
      body.push(indent && lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i])
    }
    const { lang, meta } = parseFenceInfo(open[3])
    out.push({ lang, code: body.join("\n"), meta, line: openLine, end: i })
  }
  return out
}

/**
 * 解析 front-matter 里的 `code-exec:` 文档级默认（DESIGN.md §7）。
 * 只支持映射嵌套（缩进分层）与标量值，不碰 YAML 其余语法——front-matter 其余
 * 部分（title / tags / 列表…）一概不看。顶层键出现在 `code-exec:` 段之后即视为段结束。
 * @param {string} md markdown 源码
 * @returns {{config: object, problems: string[]}}
 */
const parseCodeExecFrontMatter = md => {
  const lines = String(md ?? "").split(/\r?\n/)
  const empty = { config: {}, problems: [] }
  if ((lines[0] ?? "").trim() !== "---") return empty
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) { end = i; break }
  }
  if (end < 0) return empty
  let start = -1
  for (let i = 1; i < end; i++) {
    if (/^code-exec:[ \t]*$/.test(lines[i])) { start = i; break }
  }
  if (start < 0) return empty
  const config = {}
  const problems = []
  const stack = [{ indent: -1, obj: config }]
  for (let i = start + 1; i < end; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const m = /^([ \t]*)([A-Za-z][\w-]*):(?:[ \t]*(.*))?$/.exec(line)
    if (!m) { problems.push(`front-matter 第 ${i + 1} 行无法解析：${line.trim()}`); continue }
    const indent = m[1].replace(/\t/g, "  ").length
    if (indent === 0) break                                  // 离开了 code-exec 段
    const key = m[2]
    const raw = (m[3] ?? "").trim()
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].obj
    if (raw === "") {
      parent[key] = {}
      stack.push({ indent, obj: parent[key] })
    } else {
      parent[key] = raw.replace(/^"([^"]*)"$/, "$1").replace(/^'([^']*)'$/, "$1")
    }
  }
  return { config, problems }
}

/**
 * 按 h1 把围栏分章（DESIGN.md §2/§4：h1 = 教学单元 = 会话边界）。
 * 识别 h1 时跳过所有围栏内部（代码里的 `#` 注释不是标题）与 front-matter（YAML 注释同理）；
 * 首个 h1 之前的内容属于隐式首章（title 为空串），仅当其中确有围栏时才保留——不规范文档
 * 没有 h1 时，整个正文自然落进这一个隐式章，不需要任何兼容分支。
 * @param {string} md markdown 源码
 * @param {object[]} [precomputedFences] parseFences 的结果。传入可保证分章里的围栏对象
 *   与调用方手里那份是**同一批对象**（identity 可比），调用方据此把围栏归属到章。
 * @returns {{title: string, line: number, fences: object[]}[]}
 */
const parseChapters = (md, precomputedFences) => {
  const fences = precomputedFences ?? parseFences(md)
  const lines = String(md ?? "").split(/\r?\n/)
  const inFence = idx => fences.some(f => f.line < idx && idx < f.end)
  // front-matter 区整体跳过：YAML 注释「#」不是标题
  let bodyStart = 0
  if ((lines[0] ?? "").trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (/^(---|\.\.\.)[ \t]*$/.test(lines[i])) { bodyStart = i + 1; break }
    }
  }
  const chapters = [{ title: "", line: -1, fences: [] }]
  for (let i = bodyStart; i < lines.length; i++) {
    if (inFence(i)) continue
    const h = /^\s{0,3}#\s+(.+)$/.exec(lines[i])
    if (h) chapters.push({ title: h[1].replace(/[ \t]+#+[ \t]*$/, "").trim(), line: i, fences: [] })
  }
  for (const f of fences) {
    let owner = chapters[0]
    for (const ch of chapters) if (f.line >= ch.line) owner = ch
    owner.fences.push(f)
  }
  return chapters.filter(ch => ch.title !== "" || ch.fences.length > 0)
}

/**
 * 读当前文件源码并解析出围栏列表；读不到（无打开文件或接口抛错）就返回 []，
 * 调用方据此退回「原样执行片段」，行为与修复前一致。
 * @param {() => string} readContent 取源码的函数（通常是 () => utils.getCurrentFileContent()）
 */
const sourceFences = readContent => {
  let md = ""
  try { md = readContent() ?? "" } catch { return [] }
  return md ? parseFences(md) : []
}

/**
 * 用 deck 里（可能已被切片的）代码片段，回源码找回它所属的**完整**代码块。
 *
 * 判据：片段的行序列必须是源码某块行序列里的一段**连续**子列。切片本来就是按连续行切的，
 * 所以这个判据既准确，又能把「同文件里几个长得像的块」区分开（只认连续整段，不认零散行）。
 * 找不到（源码已改动、或该 pre 不是来自 md 围栏）就原样返回片段。
 *
 * @param {string} slice deck 里 pre 的实际内容（可能只是切片）
 * @param {string} lang 语言标识，用于在同语言块里优先匹配
 * @param {{lang: string, code: string}[]} fences parseFences 的结果
 */
const fullFenceCode = (slice, lang, fences) => {
  const text = String(slice ?? "")
  if (!text.trim()) return text
  const list = fences ?? []
  if (!list.length) return text
  const parts = text.split("\n")
  // 闭合围栏会在末尾留下一个空行，切片时也被 pop 掉（见 overflow.js），这里同样清掉
  while (parts.length > 1 && parts[parts.length - 1].trim() === "") parts.pop()
  const key = String(lang ?? "").toLowerCase()
  const sameLang = list.filter(f => f.lang === key)
  const pool = sameLang.length ? sameLang : list
  for (const f of pool) {
    if (f.code === text) return f.code            // 没被切分：整块直接命中
    const src = f.code.split("\n")
    if (src.length < parts.length) continue
    for (let s = 0; s + parts.length <= src.length; s++) {
      if (src[s] !== parts[0]) continue           // 首行就不等，跳过整段比对
      let ok = true
      for (let k = 1; k < parts.length; k++) {
        if (src[s + k] !== parts[k]) { ok = false; break }
      }
      if (ok) return f.code
    }
  }
  return text
}

/**
 * 在源码围栏列表里定位一个块：先在同语言里找内容全等的，退而求其次只对内容
 * （语言标记可能因 LANGS 配置而异，如 jshell 与 java 指向同一个 runner）。
 * 定位结果是块在源码中的**下标**——会话归属（它在哪一章）、过期链（它在文档序里的
 * 位置）都以它为锚。找不到返回 -1，调用方退回一次性执行。
 * @param {object[]} fences parseFences 的结果
 * @param {string} lang 块的语言标记
 * @param {string} code 块的完整内容（编辑态来自 getFenceContent，放映态来自 fullFenceCode）
 * @returns {number}
 */
const locateFence = (fences, lang, code) => {
  const text = String(code ?? "")
  if (!text.trim()) return -1
  const key = String(lang ?? "").toLowerCase()
  let anyLang = -1
  for (let i = 0; i < fences.length; i++) {
    const f = fences[i]
    if (f.code !== text) continue
    if (f.lang === key) return i
    if (anyLang < 0) anyLang = i
  }
  return anyLang
}

module.exports = { parseFences, parseFenceInfo, parseChapters, parseCodeExecFrontMatter, locateFence, sourceFences, fullFenceCode }
