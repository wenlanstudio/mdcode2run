# DESIGN

mdcode2run 的设计规范。权威来源——README/TODO/FENCE 的设计叙事与此冲突时，以此为准。

> 现状代码（v0.1）与本文有差距：执行日志、stale、preset、chapter 层配置尚未实现。
> 差距清单见 §13。

## 1. 设计前提

一份 md = 一份可运行讲义 / 实训报告。mdcode2run 是**混合语言编程工具**：老师在 md 里写代码块、调试实验手册、产出可复现的报告。不是数据科学笔记本，不是放映器——是引擎，呈现归宿主（wenlan-studio 编辑态、md2slides 放映态）。

## 2. 两轴分离

设计的根本动作：把"每块都不同的"和"整份讲义相同的"分开。

```
环境轴  WHERE：在什么环境、用什么跑        → 六层配置（§4），整份讲义声明一次
块轴    HOW：  这块干什么                  → marker（§5），每块才要想
```

两轴正交。环境轴不碰 marker，块轴不碰环境（除罕见 override escape）。

## 3. 概念体系

| 概念 | 定义 |
|---|---|
| fence 围栏 | 一个 ``` 代码块整体 |
| body 块正文 | 围栏里的代码——被执行的对象（"程序"） |
| info-string 标注串 | 围栏开启行 lang 后面的全部内容（"调度信息"） |
| lang 语言标签 | 标注串首位，选执行器 |
| marker 标注 | info-string 里 lang 之后的旗标与键值（不含 lang） |
| role 角色 | 由 marker 组合**推导**的调用形态：run/demo/setup/file（invalid 为错误态） |
| family 语言族 | 执行后端：python/java/shell/mysql/hive |
| prototype 执行原型 | 按形状分：eval/exec/query/job/tunnel（不按 lang 硬分） |
| chapter 章 | h1 围出的教学单元 = 会话边界 + 重放范围 + 工作目录范围 |
| session 会话 | 同章同 family 共享的常驻状态（命名空间 / JVM） |
| chapter workdir 章工作目录 | 跨语言共享的物化目录，key = 文档路径#章行号 |
| result contract 结果契约 | `{ok,kind,stdout,text,error,…}` 引擎与宿主之间的墙 |
| host 宿主 | 消费引擎的呈现方 |
| execution log 执行日志 | runtime 录制的 ▶ 序列（§7） |
| trace | 已保存的执行日志，用于复现 |
| stale | 块的源码/依赖变了、输出可能过时的标记 |

两条铁律（正交性）：
1. **lang 选执行器（family），role 定调用形态**——两个维度，别混。
2. **prototype 按"形状"分，不按 lang 分**——bash 能走 exec/job/tunnel 三态，取决于旗标与块内容。

## 4. 环境轴：六层配置

借鉴 org-babel 验证多年的覆盖链，按"高层覆盖低层"合并：

```
tech(语言 schema+默认) < course(装订) < doc(preset+front-matter)
  < chapter(h1 子树覆盖, 可选) < block(fence override:, 罕见)
  < engine(秘密, 正交轴)
```

| 层 | 内容 | 可被覆盖 |
|---|---|---|
| tech | runner + 参数 schema + 默认值 | ✓ |
| course | 选 tech + 覆盖参数 + 引入 `${SECRET}` | ✓ |
| doc | front-matter：`preset: <课程名>` + 可选 override | ✓ |
| chapter | h1 子树级覆盖（本章 hive 换 DB 等，罕见） | ✓ |
| block | fence `override:key=val`（单块 one-off，极罕见） | 顶层 |
| engine | `${...}` 占位符的真值（密码/ssh 档案） | 独立轴，不被覆盖 |

**合并语义**：按 tech 分组浅合并——上层只盖它点名的键，不替换整张参数表。course 盖 `shell.MODE` 不必重述 `shell.runner`。

**三条护栏**（覆盖自由不等于乱盖）：

1. **白名单**：上层只能盖 tech schema 声明过的参数；盖不存在的键报错。防拼错静默生效。
2. **runner 锁定**：用哪个执行器是 tech 的类型契约，不可覆盖。不能让 shell 跑成 jshell。
3. **秘密参数禁字面量**：tech schema 标 `secret:true` 的参数，上层覆盖时只能写 `${...}` 占位符，不能写字面值。保证"秘密只进 engine"即使覆盖时也不破。

**为什么 tech 也带默认值**：默认值就是给上层盖的。`tech:shell = {defaults:{MODE:local}}`，`course:linux` 不盖走默认 local，`course:hadoop-mr` 盖 `MODE:remote`。一个 tech 出多用法靠覆盖不靠复制。

**preset 解析流向**：

```
doc front-matter preset: hadoop-mr
  → course 装订（java:{CLASS_PATH:...} + shell:{MODE:remote, HOST:${CLUSTER_HOST}}）
  → tech schema 查 runner + 校验参数白名单
  → chapter/block override 合并（如有）
  → engine 填 ${...} 真值
  → 最终执行配置
```

任何一层缺失有明确报错（"course 引用未定义的 tech:spark" / "engine 缺 ${CLUSTER_PW}"）。

## 5. 块轴：marker 语义

老师要记的全部行内词汇：

```
形式：    (无)=run | demo
关系：    setup | file=path | job
覆盖：    override:key=val（罕见，复用 §4 的覆盖语义）
内部参数： （v1 空——见 §12）
```

**role 推导**（不是写的，是引擎算的）：

| 出现标注 | role | 行为 |
|---|---|---|
| （无） | run | 执行，进过期链 |
| `setup` | setup | 引导，会话建立时自动先跑，须幂等 |
| `demo` | demo | 仅展示，不执行 |
| `file=path` | file | 物化进章工作目录，不执行 |
| `job`（叠 run） | run + job 模式 | 异步：句柄 + 日志流 + 可终止 |
| `override:` | role 不变 | 仅覆盖环境参数 |

**冲突矩阵**（marker 组合的裁决）：

| 组合 | 结果 | 理由 |
|---|---|---|
| `demo` + `setup` | invalid | 示意块不跑、引导块要跑，互斥 |
| `file=` + 任意执行旗标 | invalid | 文件块不执行 |
| `job` + `demo`/`setup`/`file` | invalid | job 是 run 的模式修饰 |
| `override:` + 任意 | role 不变 | 仅调参 |

`invalid` 是错误态，不进用户词汇；problems 非空的块仅展示，不执行/不物化/不进重放——拼错标注宁可静默降级，不让讲义在讲台上炸。

**执行原型全靠推断**（老师零负担）：

| 原型 | 判据 |
|---|---|
| eval | lang=python/java → 常驻会话 |
| exec | lang=bash/sh，无 job，块内无 `[user@host ~]$` |
| tunnel | lang=bash，块内含 `[user@host ~]$` 提示符 |
| job | `job` 旗标 |
| query | lang=sql/hive/hql… → rows；具体 DB 由 course/preset 定 |

输出类型（表/图/文本）由 runner 自动捕获，不加 `output=` 参数。

## 6. 执行模型

**命令式，不是反应式。** 文档序 = 规范执行序（过期链）。章（h1）= 会话边界 + 重放范围 + 工作目录范围。

**为什么不要反应式（决定性）**：反应式（marimo 路线）靠静态分析每个 cell 定义/引用的全局变量建 DAG。混合语言下跨块状态走**文件**——`hdfs dfs -put out.csv` 产出文件是运行时副作用，静态分析跨语言无解；marimo 自己都承认不追踪 mutation。所以反应式 DAG 对混合语言是死路，不是取舍。mdcode2run 走命令式 + 可见性（执行日志 + stale）代替自动反应。

**跨语言状态共享 = 文件总线**（不是变量）：

```
Chapter（h1）
  ├─ session: python（eval，持久命名空间）
  ├─ session: java（eval，持久 JVM）
  ├─ session: shell（exec，逐块）
  └─ workdir: ./<doc>#<chapter>/      ← 跨语言共享
        file= 块物化到这里
        运行时副作用（hdfs -put 产物）落这里
        任意 family 从这里读
```

同语言共享会话状态（变量/JVM）；跨语言共享章工作目录（文件）。这是混合语言的唯一语言无关方案——java/bash/hive/sql 之间没有"变量"可共享。

**章工作目录**：key = `文档路径#章行号`，跨语言共享。`file=` 物化的、运行时副作用产出的、任意 family 读取的，都在此目录。跨章天然隔离（换章 = 换会话 = 换目录）。

## 7. 执行日志与复现

**执行日志 = runtime 录制的 ▶ 序列**（不声明，不进 md）。每次 ▶ 记一条：

```
执行日志（per session）
#1  block@L12 (python)  a=1
#2  block@L20 (python)  print(a) → 1
#3  block@L28 (python)  a+=1
#4  block@L20 (python)  print(a) → 2    ← 重跑同一块，新序号
```

执行序号 `#N` 是日志位置，宿主显示成 `▶ ran #4`——老师据此知道当前状态来自哪几跑，不靠猜。

**"再次运行 step2"怎么实现**：老师回到 step2 块直接点 ▶ 再跑一次。块本来在文档里，不复制代码、不留空围栏、不声明队列。重跑自然进日志。

**两种复现模式**：

| 模式 | 路径 | 用途 |
|---|---|---|
| Run All | 文档序，每块一次 | 默认；多数手册够用 |
| Replay Trace | 日志完整序列（含重跑） | 忠实复现"改后再看"的演示过程 |

重跑型手册（step3 改 a 后重跑 step2 看变化）：Run All 漏掉重跑所见的状态，Replay Trace 才忠实。

**trace 住哪：sidecar，不进 md**。md 正文始终干净。trace 存 `lec3.md.trace` 或 front-matter `exec.trace: ./lec3.trace`。老师跑通一遍→存 trace→随讲义分发；进不进 git 由老师定（进 = 复现可复核，不进 = 只当源码）。

## 8. 失效传播（stale）

改了块源码，哪些块输出可能过时？stale 标记向宿主提供可见性，**不自动重跑**（讲台要可控，改一下全本自动炸是 marimo 的麻烦，我们避掉）。

**两类依赖边**：

1. **文件依赖边**（跨语言精确）：块产出文件（`file=` 声明 + 运行时副作用捕获）→ 消费该文件的块。文件变 → 消费者 stale。
2. **会话内顺序边**（同语言保守）：同章同 family 内，块改了 → 本章该 family 后续块 stale。保守（不追踪 mutation，同 marimo 的限制），但安全。

传播规则：源码改 → 该块日志条目 stale → 沿两类边向前传播 → 宿主打 stale 角标。

`file=` 在此第二次发力：不只是物化指令，还是**产出声明**——引擎据此建文件依赖图。

## 9. 引擎/宿主契约

**引擎无头**：document/window 零引用。结果契约是唯一墙：

```
run(ctx) → { ok, kind, stdout, text, error, rows?, images?, session?, job? }
events:  started {family,line} / chunk {stream,text} / done {ok,duration,error?}
```

引擎额外输出（供宿主渲染，非契约）：
- 执行日志（序号、块、时间戳、结果引用）
- stale 状态（哪些块过时）
- 文件依赖图（产出/消费清单）

宿主负责：▶ 按钮、结果浮层、执行序号显示、stale 角标、文件依赖图可视化、cell chrome。

## 10. 配置三层 vs 六层

本文将历史"配置三层（fence meta > front-matter > engine config）"扩展为六层（§4），对齐 org-babel。原三层的语义被吸收：
- fence meta → block 层（marker + override:）
- front-matter → doc 层 + chapter 层
- engine config → engine 层（秘密）

秘密仍只进 engine 层，讲义可进 git 的前提不变。

## 11. 课程验证

六门常用课程，看每块实际用到什么 marker：

| 课程 | preset | 每块典型 marker | 用到的全部 marker |
|---|---|---|---|
| Java基础 | java-basic | （无）/ `setup` | setup |
| MapReduce | hadoop-mr | （无）/ `job` / `setup`（编译） | job, setup |
| matplotlib 可视化 | python-data | （无）/ `setup`（import） | setup |
| Python基础 | python-basic | （无）/ `demo` | demo |
| Hive数据仓库 | hive-course | （无）/ `setup`（USE DB） | setup |
| Linux基础 | linux-local / linux-remote | （无）/ `demo`（终端转写） | demo |

六门课加起来只用 setup / demo / job；file= 偶尔（数据文件）；session=/dialect=/workdir= 一门都没用上——实证它们是冗余维度，删除有据。

**preset 菜单示例**（引擎侧维护，每门课配一次）：

```
tech:java    = { runner: jshell-session, params:{JAVA_HOME, CLASS_PATH}, defaults:{} }
tech:python  = { runner: python-session,  params:{PYTHON_PATH}, defaults:{} }
tech:shell   = { runner: shell,           params:{MODE,HOST,USER,PASSWORD}, defaults:{MODE:local} }
tech:hive    = { runner: beeline,         params:{CLIENT,HOST,DB,USER,PASSWORD}, secrets:{USER,PASSWORD} }

course:java-basic   = { java: {} }
course:hadoop-mr    = { java:{CLASS_PATH:"hadoop-client/*"}, shell:{MODE:remote, HOST:"${CLUSTER_HOST}", USER:"${CLUSTER_USER}", PASSWORD:"${CLUSTER_PW}"} }
course:python-data  = { python:{PYTHON_PATH:"${ANACONDA}"} }
course:hive-course  = { hive:{DB:homework}, shell:{MODE:remote, HOST:"${CLUSTER_HOST}", ...} }
course:linux-local  = { shell:{} }                        # 走 tech 默认 MODE:local
course:linux-remote = { shell:{MODE:remote, HOST:"${LAB_HOST}", ...} }
```

tech 是 4 个 schema，course 是 6 个薄装订，engine 一份秘密。集群换 IP 只改 engine 一处，所有课程跟切。

## 12. 不做的事（宁缺毋滥）

每条都有据，不是遗漏：

| 不做 | 理由 |
|---|---|
| 反应式 DAG（marimo） | 跨语言静态分析无解（§6 决定性） |
| `:var` 值注入（org-babel） | 跨语言靠文件总线、同语言靠 session 共享，:var 冗余 |
| `:cache`（org-babel） | 比所需重；展示型 stale 不用 hash 比对 |
| `call=`/`name=` marker | 空围栏在正文里丑；重跑靠执行日志（§7） |
| `session=`/`dialect=`/`workdir=` | 现状已解析但从未接线；六门课零需求（§11） |
| 显式执行队列声明 | 用下标脆弱；用名字又冗余；日志录制即队列（§7） |
| auto-run 依赖 | 与讲台手动 ▶ 控制冲突 |
| unique 变量约束 | 无 DAG 就不需要；老师该能跨块重用变量名 |
| 内部参数（v1） | 六门课未找到一个必须在 fence 表达的内部参数；开通用 param 系统必回"参数太多"老路 |
| `<<noweb>>` 代码展开（org-babel） | 讲义块基本自包含；"共享 preamble"场景留 v2 |
| `:tangle` 提取源码（org-babel） | "实训报告→可运行项目"留 v2，与 `file=` 物化不同义 |

## 13. 与现状的差距

诚实标注 DESIGN（目标）与 v0.1 代码的差距，供重构排期：

| 项 | DESIGN | v0.1 现状 |
|---|---|---|
| `session=`/`dialect=`/`workdir=` | **已删除（2026-11-03）**：解析层移除，写它们记未知标注 problem、块安全降级 |
| preset（tech/course/doc/engine） | 六层配置 | **tech/course/doc/engine 四层已实现（2026-11-04，`preset.js`）**；chapter/block override 留位（复用同一 apply 语义） |
| chapter 层配置 | 有（h1 子树覆盖） | 无 |
| `override:` fence escape | 有 | 无 |
| 执行日志 + 序号 | 有 | **已实现（2026-11-04，`journal.js`）**：章作用域 ▶ 序列，`result.session.seq` + `engine.journalOf(chapterLine)` |
| stale 传播 | 有（文件依赖 + 会话内顺序） | **已实现 v1（2026-11-04）**：顺序边（内容指纹）+ 文件边（章工作目录快照，源码提到即消费，保守多报） |
| trace sidecar | 有 | 无（日志已就位，落盘格式待定） |
| marker `call=`/`name=` | 不做（已论证） | 无（一致） |
| sessions.js 并发/回收缺陷 | 须修 | **已修（2026-11-03）** |

重构顺序建议：~~先修 sessions.js 缺陷~~（✅ 2026-11-03）→ ~~删 session/dialect/workdir~~（✅ 2026-11-03）→ ~~加 preset 六层~~（✅ 2026-11-04，tech/course/doc/engine 四层 + 三护栏，chapter/block 留位）→ ~~执行日志/stale~~（✅ 2026-11-04，journal.js + 文件依赖边 v1）→ trace sidecar。
