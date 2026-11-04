# MDCODE2RUN

Markdown 代码执行引擎：**块角色标注 + 章会话 + file= 物化 + 过期链 + 重放 + 作业**。
无头核心——**引擎不知道 DOM 的存在**，结果只经结果契约 + 事件流交付，

> 设计规范见 [`DESIGN.md`](./DESIGN.md)（两轴分离、六层配置、marker 语义、执行日志/stale、复现模式、不做清单）。README 是使用说明，DESIGN 是设计权威，二者冲突以 DESIGN 为准。
> 围栏标注规则见 [`FENCE.md`](./FENCE.md)；AI 协作规范见 [`AGENTS.md`](./AGENTS.md)。

呈现归宿主
呈现归宿主（[md2slides](../md2slides) 放映器或任意自定义宿主）。

与 md2slides 是姊妹引擎：一个管"怎么呈现"，一个管"怎么执行"，共享同一套架构铁律——
core 不知道编辑器 / 放映的存在。

## 快速开始

```bash
npm install
node bin/mdcode2run.js list   讲义.md                  # 盘点：哪些块可跑、什么角色
node bin/mdcode2run.js run    讲义.md --at 128          # 跑第 128 行所在的块（行号 1 基）
node bin/mdcode2run.js replay 讲义.md --at 360          # 从本章第一个可跑块连跑到这里
node bin/mdcode2run.js run    讲义.md --at 360 --trace  # 执行即录制到 讲义.md.trace（sidecar）
node bin/mdcode2run.js replay 讲义.md --trace          # 按录制序重演整篇（含重跑；改动块标 stale 跳过）
npm test                                                # 全套测试（真实 JDK / anaconda 自动门控）
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

info-string 的权威规则见 [`FENCE.md`](./FENCE.md)（语法、冲突矩阵、消费状态、示例）。
下表是简版速查：

| 标注 | 名义 | 行为 |
|---|---|---|
| （无） | 代码块 | 会话内执行；按文档序进过期链 |
| `demo` | 示意块 | 不可执行，伪代码 / 终端转写 |
| `setup` | 引导块 | 会话建立时自动先跑，要求幂等 |
| `file=<相对路径>` | 文件块 | 物化进章工作目录（跨语言文件总线），不可执行 |
| `job` | 作业模式 | 异步启动 + 日志流 + 树杀终止；与 demo/setup/file 互斥 |

（`session=`/`dialect=`/`workdir=` 已按 DESIGN §12 删除——六门课零需求。
写它们记 `未知标注` problem、块降级展示；SQL 方言用直标围栏 ` ```hive ` 等。）

## 环境配置（preset 六层，DESIGN §4）

```
tech（技术 schema+默认） < course（课程装订） < doc（front-matter） < chapter < block < engine（秘密）
```

老师只写一个词——front-matter 里 `preset: <课程名>`，环境全到位：

```yaml
---
title: Hive 数据仓库实验
preset: hive-course        # 内置六门课：java-basic / hadoop-mr / python-data /
---                        # hive-course / linux-local / linux-remote
```

课程里引用的秘密用 `${NAME}` 占位符，真值只放引擎层 `config.secrets`：

```json
{ "secrets": { "ANACONDA": "D:/ProgramData/anaconda3/python.exe", "CLUSTER_PW": "…" } }
```

不带 preset 的文档走直配（`config.<family>` 直接生效）。三条护栏：覆盖只能盖 tech
schema 声明过的参数（白名单）、执行器按语言族硬绑（runner 锁定）、秘密参数在
course/doc 层禁写明文（只能 `${NAME}`）。自定义课程/技术经 `createEngine({ techs,
courses })` 或 CLI `--config` 里的 `techs`/`courses` 键合入内置表。

front-matter 直配仍可用（讲义自包含，可进 git；密码永远只在引擎层）：

```yaml
code-exec:
  java:  { class-path: "D:/repo/hadoop-client-3.1.3/*", JAVA_HOME: "D:/jdk-17" }
  python: { PYTHON_PATH: "D:/anaconda3/python.exe" }
  mysql: { HOST: db.example.com, DATABASE: homework }
```

引擎层配置键是普通对象（`config.java.CLASS_PATH`、`config.shell.MODE/HOST/USER/PASSWORD`…），
持久化形式由宿主决定。

## 目录结构

```
lib/                   引擎实现（bin 与测试之外的全部源码都在这层）
  index.js             引擎门面（parse / locate / run / replay / resetSession / journalOf / traceOf / traceLoad / replayTrace / events）
  journal.js           执行日志（章作用域 ▶ 序列；result.session.seq + journalOf 供宿主渲染）
  trace.js             trace sidecar 纯函数层（JSONL 序列化/校验/重演计划；文件 I/O 在门面）
  preset.js            preset 六层解析核心（tech/course 装订 + 三护栏，纯函数）
  fences.js            块解析：info-string 词汇表 / 分章 / front-matter 子集（纯函数，可单测）
  front-matter.js      前言配置读取（code-exec.<段>.<键> → 顶层旧写法）
  sessions.js          会话注册表（懒建立 / 并发共享创建 / 死会话重建 / 空闲回收）
  chapter.js           章计划：setup/file/blocks 清单、内容指纹、file= 物化
  session-run.js       会话编排：物化 → 引导 → 过期链 → 运行/重放（语言无关）
  languages/           五个语言模块：认语言、查环境、给选项、路由 runner
  runners/             八个执行器：python(.session) / java(.session) / shell / query / hive(beeline) / job（纯 Node）
bin/mdcode2run.js      CLI（list / run / replay，--json 走契约）
test/                   测试套件（run-all.js 自动纳管）；测试标本在 test/fixtures/；真实 JDK / anaconda / mysql / Hive
                       按 MDX_* 门控，缺环境时对应段自动跳过
sample/                可运行讲义样本（给老师参照）：python / java 基础各一份，
                       真跑验证过，复制改内容即成第一份讲义；见 sample/README.md
sample/mrjob/          实验原型：mrjob 一文档一 MapReduce 作业（独立于主引擎，
                       npm run test:mrjob，不在 run-all 批里）
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

## 已知边界

- CLI 的会话**不跨进程**：每条命令是新进程、新会话（章工作目录在 tmp 稳定复用，
  file= 物化产物仍在）。跨块状态链路请用 `--replay`（一个进程内 setup → … → 目标块）。
- jshell 首次建会话（大 classpath）有秒级预热；`--timeout` 管的是单请求上限（超时会话
  作废、下次重建）。
- mysql / hive 密码只放引擎层配置；前言层无权携带（讲义分享/进 git 的前提）。
- Hive 走 beeline：`hive.CLIENT` 需指向可直接执行的 wrapper。beeline 由 Hive 发行版提供
  （Hadoop 发行版不含）；Windows 上 `beeline.cmd` 不能直接 spawn，需包一层可执行入口。
- SQL 方言用直标围栏：` ```hive `/`hql`/`hiveql`/`sparksql `（`dialect=` 标注已删除）。
