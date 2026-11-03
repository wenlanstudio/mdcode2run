# MDCODE2RUN

Markdown 代码执行引擎：**块角色标注 + 章会话 + file= 物化 + 过期链 + 重放 + 作业**。
从 Typora 插件 code-exec 提取的无头核心——**引擎不知道 DOM 的存在**，结果只经
结果契约 + 事件流交付，呈现归宿主（Typora 壳 / [md2slides](../md2slides) 放映器各自渲染）。

与 md2slides 是姊妹引擎：一个管"怎么呈现"，一个管"怎么执行"，共享同一套架构铁律——
core 不知道编辑器 / 放映的存在。

## 快速开始

```bash
npm install
node bin/mdcode2run.js list   讲义.md                  # 盘点：哪些块可跑、什么角色
node bin/mdcode2run.js run    讲义.md --at 128          # 跑第 128 行所在的块（行号 1 基）
node bin/mdcode2run.js replay 讲义.md --at 360          # 从本章第一个可跑块连跑到这里
npm test                                                # 10 套测试（真实 JDK / anaconda 自动门控）
```

作为库使用，对外入口只有一个：`require("mdcode2run")`。

```js
const { createEngine } = require("mdcode2run")

const engine = createEngine({
  config: {                               // 宿主偏好层——秘密全在这（PYTHON_PATH / JAVA_HOME / 密码 / ssh）
    java: { JAVA_HOME: "D:/jdk-17" },
    python: { PYTHON_PATH: "D:/anaconda3/python.exe" },
  },
  documentPath: "D:/课/讲义.md",           // 会话身份的锚
  documentDir: "D:/课",
})

const parsed = engine.parse(md)           // → { blocks, chapters, fm, fences }（建 UI 用）
const ctx = engine.locate(md, { line })   // → 运行上下文（不可执行 / 不支持的语言 → null）
const result = await engine.run(ctx, {
  onChunk: ({ stream, text }) => {},      // stdout/stderr 实时流
  // replay: true,                        // ⏩ 从本章开头连跑到这里
})
// result: { ok, kind, stdout, text, error, rows?, images?, session?, job? }

engine.events.on("chunk", d => {})        // started / chunk / done（EventEmitter）
engine.resetSession(ctx)                  // ⟳ 销毁会话，下次运行重建
engine.dispose()                          // 宿主关文档时回收全部常驻会话
```

**消费方注意**：常驻会话（JVM / 解释器）的 stdio 管道会撑住 Node 事件循环——长驻宿主
（编辑器）可以一直留着（10 分钟空闲自动回收）；一次性进程（CLI、构建脚本）干完活必须
显式 `engine.dispose()`，等 `process.on("exit")` 是等不到的。

## 执行原型

语言不是本质差异，执行的形状才是：

| 原型 | 形状 | 覆盖 | 语言模块 |
|---|---|---|---|
| eval | 常驻解释器，逐块喂代码，同章共享命名空间 | python、jshell/java | `languages/python.js` `languages/java.js` |
| exec | 本地 bash 或远端 ssh，一次性跑完即断 | bash/sh/shell | `languages/shell.js` |
| query | SQL → 结构化行列（rows） | mysql、hive/beeline（` ```hive ` · ` ```hql ` · ` ```hiveql ` · ` ```sparksql `） | `languages/mysql.js`、`languages/hive.js` |
| job | 异步长任务：句柄 + 日志流 + 可终止（` ```bash job `） | — | shell 模块路由 |
| tunnel | 远端集群操作（`[user@host ~]$` 提示符自动路由 ssh） | hdfs / hadoop | shell 模块路由 |

## 块角色词汇表（fence info-string）

| 标注 | 名义 | 行为 |
|---|---|---|
| （无） | 代码块 | 会话内执行；按文档序进过期链 |
| `demo` | 示意块 | 不可执行，伪代码 / 终端转写 |
| `setup` | 引导块 | 会话建立时自动先跑，要求幂等 |
| `file=<相对路径>` | 文件块 | 物化进章工作目录（跨语言文件总线），不可执行 |
| `session=<名>` | 会话归属 | 显式命名会话（词汇已解析，路由待接） |
| `dialect=<名>` / `workdir=<路径>` | 方言 / 工作目录 | 均已解析；`dialect` 只在 `sql` 围栏上待接线（hive 直标围栏已可用），`workdir` 尚未被消费 |
| `job` | 作业模式 | 异步启动 + 日志流 + 树杀终止；与 demo/setup/file 互斥 |

## 配置三层

```
fence meta（块级） > front-matter code-exec:（文档级） > createEngine config（引擎层，持秘密）
```

front-matter 示例（讲义自包含，可进 git；密码永远只在引擎层）：

```yaml
code-exec:
  java:  { class-path: "D:/repo/hadoop-client-3.1.3/*", JAVA_HOME: "D:/jdk-17" }
  python: { PYTHON_PATH: "D:/anaconda3/python.exe" }
  mysql: { HOST: db.example.com, DATABASE: homework }
```

引擎层配置键与原 Typora `settings.toml` 的 `[exec_*]` 段一致（`config.java.CLASS_PATH`、
`config.shell.MODE/HOST/USER/PASSWORD`…），迁移旧的宿主配置即拷即用。

## 目录结构

```
index.js               引擎门面（parse / locate / run / replay / resetSession / events）
bin/mdcode2run.js      CLI（list / run / replay，--json 走契约）
fences.js              块解析：info-string 词汇表 / 分章 / front-matter 子集（纯函数，可单测）
front-matter.js        前言配置读取（code-exec.<段>.<键> → 顶层旧写法）
sessions.js            会话注册表（懒建立 / 并发共享创建 / 死会话重建 / 空闲回收）
chapter.js             章计划：setup/file/blocks 清单、内容指纹、file= 物化
session-run.js         会话编排：物化 → 引导 → 过期链 → 运行/重放（语言无关）
languages/             五个语言模块：认语言、查环境、给选项、路由 runner（原 plugins/ 去插件壳）
runners/               八个执行器：python(.session) / java(.session) / shell / query / hive(beeline) / job（纯 Node）
test/                  10 套测试；真实 JDK / anaconda / mysql / Hive 按 MDX_* 与默认路径门控
                       （fences、session-run 两套仍依赖本机标本，待 fixture 化）
lab/                   实验原型：mrjob 一文档一作业（独立于主引擎，npm run test:mrjob）
archive/               前身 code-exec 插件快照（只读，2026-10-25）
TODO.md                路线图与已知问题
```

## 架构铁律

1. **引擎不知道 DOM 的存在**——document/window 零引用；呈现 = 消费者渲染结果契约。
2. **结果契约是唯一的墙**：`{ ok, kind, stdout, text, error }` 上扩展 `rows`（query）、
   `images`（图捕获）、`session`（章会话 HUD）、`job`（作业句柄）。上面三层不认识具体语言。
3. **章 = 会话边界**（h1）：同章同语言共享解释器状态，章工作目录跨语言共享
   （shell put 的文件 java 读得到）；跨章天然隔离。
4. **重放只有最后一块进流**——重放的意义是恢复状态，中间块的输出只会淹没观众。
5. **重放跳过作业块**——重放必须幂等安全，重启作业是手动 ▶ 的事。

## 与 Typora 插件版的差异

- 删除：结果卡片 / 放映浮层 / ▶ 按钮 / marp 接线 / fence_enhance 适配 / BasePlugin 基座
  （这些归宿主；原版见 Typora `resources/plugin/code-exec/`，本仓只读快照在
  [archive/code-exec-2026-10-25](archive/code-exec-2026-10-25/)，两版并存，插件版未动）。
- 删除：PYTHON_PATH 的 [matplotlib] 插件回退（Typora 生态问答）；需要等效行为就在
  config.python.PYTHON_PATH 写同一路径。
- 变化：事件从 DOM CustomEvent 改为 EventEmitter；会话注册表从模块级单例改为随引擎实例。
- ssh2 从外挂目录（shell_exec_lib）改为正式 npm 依赖（纯 JS，不碍分发）。

## 已知边界

- CLI 的会话**不跨进程**：每条命令是新进程、新会话（章工作目录在 tmp 稳定复用，
  file= 物化产物仍在）。跨块状态链路请用 `--replay`（一个进程内 setup → … → 目标块）。
- jshell 首次建会话（大 classpath）有秒级预热；`--timeout` 管的是单请求上限（超时会话
  作废、下次重建）。
- mysql / hive 密码只放引擎层配置；前言层无权携带（讲义分享/进 git 的前提）。
- Hive 走 beeline：`hive.CLIENT` 需指向可直接执行的 wrapper。beeline 由 Hive 发行版提供
  （Hadoop 发行版不含）；Windows 上 `beeline.cmd` 不能直接 spawn，需包一层可执行入口。
- ` ```sql dialect=hive ` 尚未接线（仍走 mysql）；当前可用的是直标围栏
  ` ```hive `/`hql`/`hiveql`/`sparksql `。
