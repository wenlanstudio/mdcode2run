# 围栏标记规则（Fence Markers）

mdcode2run 怎么对待一个代码块，**全部由围栏开启行的 info-string 决定**。这份是
`fences.js::parseFenceInfo` 的权威规则说明——文档与代码不符时，以代码为准。

> 简版见 `README.md`「块角色词汇表」；本文是详版，含语法、冲突矩阵、消费状态与示例。

## 1. 语法

围栏开启行长这样：

```
```lang  flag1 flag2  key1=val1 key2="val with space"
```

- 三个及以上反引号 `` ` `` **或**波浪号 `~`，可缩进 0–3 空格。
- **`lang` 在最前**：小写化后用于路由语言模块；空则视为不支持。
- `lang` 之后是空格 / 制表符分隔的 token，分两类：
  - **旗标**（裸词）：`demo` / `setup` / `job`
  - **键值**：`file=`
- 值可单双引号包住（路径含空格时必须加引号）：`file="my data.csv"`。
- **未知 token 一律忽略**；但未知的 `key=value` 记入 `problems`（多半是拼错标注）。
- 值大小写**原样保留**；键名与旗标小写化后识别。
- 反引号 `` ` `` 出现在 info-string 里会截断解析（取第一个 `` ` `` 之前的内容）。

> 块正文里的 ```` ``` ```` 内容、行内 `code` 都不影响解析——`parseFences` 只认开启行的 info。

## 2. 角色（role）

`role` 是单个块的最高裁决，取值之一。判定优先级见 §6。

| role     | 含义                               | 进过期链 | 可执行 | 物化 | 进重放 |
| -------- | ---------------------------------- | -------- | ------ | ---- | ------ |
| `code`   | 普通可执行块，章会话内跑           | ✓        | ✓      | —    | ✓      |
| `setup`  | 引导块，会话建立时自动先跑，须幂等 | —        | ✓      | —    | ✓      |
| `demo`   | 示意块，伪代码 / 终端转写          | —        | ✗      | —    | ✗      |
| `file`   | 文件块，物化进章工作目录，不执行   | —        | ✗      | ✓    | —      |
| `invalid`| 标注冲突，仅作展示，不参与任何流程 | —        | ✗      | ✗    | ✗      |

> 「进过期链」指按文档序纳入会话状态推进；`setup` 不进过期链（它在链之前自动跑），
> 但重放会跑它。`demo` / `file` / `invalid` 一律不进任何执行流。

唯一可执行角色集在 `index.js::RUNNABLE_ROLES = new Set(["code", "setup"])`——改这里
等于改执行资格，别在别处另判。

## 3. 旗标

### `demo` —— 示意块

````
```bash demo
$ hdfs dfs -ls /            # 这是讲台演示的转写，不真的执行
```
````

不执行、不进重放。用于「我想展示这条命令长这样但不让它跑」。

### `setup` —— 引导块

````
```python setup
import pandas as pd
DATA = "/data/lesson.csv"
```
````

会话建立时**自动先跑一次**，要求幂等（重复跑结果一致）。重放链开头也会跑它。
**与 `demo` / `file` / `job` 互斥**（见 §6）。

### `job` —— 作业模式

````
```bash job
python train.py --epochs 50
```
````

`job` 是**执行模式**不是角色——块仍是 `code`，但走异步路径：立即返回句柄
（`result.job`），日志持续外发，可终止。语义见 `runners/job.js`（树杀）。

- 与 `demo` / `setup` / `file` 互斥。
- **仅本机**：远端作业（`MODE=remote` 或块内含 `[user@host ~]$` 提示符）带 `job`
  会直接报错——杀 ssh 连接是假终止，v1 不做。
- 重放**跳过作业块**（重放须幂等安全，重启作业是手动 ▶ 的事）。

## 4. 键值标注

### `file=<相对路径>` —— 文件块

````
```csv file=data/sales.csv
date,amount
2026-01-01,100
```
````

- 物化进**章工作目录**（见 §7），跨语言共享（shell put 的文件 java 读得到）。
- 值必须是章工作目录内的**相对路径**：禁空、禁绝对（`/` 或 `C:\` 开头）、禁 `..` 逃逸。
  违反记 `problems`，块降级为 `invalid`。
- 语言标记随意（`csv` / `text` 都行）——`file=` 一旦出现，块角色就是 `file`，不看语言。

### ~~`session=<名>`~~ / ~~`dialect=<名>`~~ / ~~`workdir=<路径>`~~ —— 已移除

三个键值标注**已按 DESIGN §12 删除**（v0.1 曾解析存档但从未接线，六门课验证零需求）。
现在写它们会记 `未知标注` problem，块降级为展示块（不执行、不物化），problems
消息会点名是哪个标注——旧文档带这些标注不会炸，只是对应块不再跑。

替代写法：

| 旧意图 | 现在怎么做 |
| --- | --- |
| ` ```sql dialect=hive ` 切方言 | 直接用直标围栏 ` ```hive ` / `hql` / `hiveql` / `sparksql` |
| ` ```python session=explore ` 具名会话 | 章（h1）就是会话边界——把块放进目标章即可 |
| ` ```bash workdir=/tmp/job1 ` 换目录 | 章工作目录由「文档路径 + 章行号」派生，块内代码自己 `cd` / 用绝对路径 |

## 5. 语言标签

`lang` 小写化后路由到语言模块；每个模块有一组识别标签：

| 模块     | 默认识别标签                     | 执行原型  | 备注                                   |
| -------- | -------------------------------- | --------- | -------------------------------------- |
| python   | `python` `py`                    | eval      | 常驻解释器，同章共享命名空间           |
| java     | `jshell` `java`                  | eval      | 常驻 JShell，标本用 `java` 标注        |
| shell    | `bash` `sh` `shell`              | exec / job / tunnel | tunnel 路由靠**块内提示符**，不是 lang |
| mysql    | `sql` `mysql`                    | query     | → rows                                 |
| hive     | `hive` `hql` `hiveql` `sparksql` | query     | 走 beeline                             |

标签集可被引擎层 / 前言层配置覆盖：

```yaml
code-exec:
  java:  { LANGS: [jshell, java, scala] }   # 给 jshell 加 scala 别名
```

> 三个执行原型不是靠 lang 分的，是靠**形状**分：eval 常驻、exec 一次性、query 出行列、
> job 异步、tunnel 远端。lang 只是入口，最终路由看语言模块 + 旗标 + 块内容。

## 6. 角色冲突矩阵

`parseFenceInfo` 把所有「能定角色」的标注收集进 `roles`，再按下表裁决：

| 出现的标注                    | 结果 role        | problems                          |
| ----------------------------- | ---------------- | --------------------------------- |
| （无）                        | `code`           | —                                 |
| `demo`                        | `demo`           | —                                 |
| `setup`                       | `setup`          | —                                 |
| `file=`                       | `file`           | —                                 |
| `demo` + `setup`              | `invalid`        | `角色冲突：demo + setup`          |
| `file=` + `setup`             | `invalid`        | `角色冲突：file + setup`          |
| 任意角色 + `job`              | 见下              |                                   |
| `job` 单独（仍是 code）       | `code` + `job:true` | —                              |
| `job` + `demo`/`setup`/`file` | `invalid`        | `job 与 demo/setup/file 互斥`     |
| 未知 `key=`                   | 角色照常         | `未知标注 key=`                    |
| 重复同 `key=`                 | 用第一个         | `重复标注 key=`                    |
| `file=` 值非法                | `invalid`        | `file= 须为章工作目录内的相对路径` |

（`session=`/`dialect=`/`workdir=` 已删除——写它们命中上一行「未知 key=」规则，
记 problem、块降级展示，见 §4。）

**`problems` 非空的块不参与执行 / 物化 / 重放，只作展示。** 这是有意为之——
拼错标注宁可静默降级，也别让讲义在讲台上炸。

## 7. 章 = 会话边界

h1（`# 标题`，行首 0–3 空格）是教学单元 = 会话边界。规则：

- 同章同语言共享一个会话（共享命名空间 / JVM 状态）。
- **章工作目录**跨语言共享，key = `文档路径 # 章行号`——shell put 的文件、`file=`
  物化的文件、java 读的 class 文件都在同一个目录里。
- 跨章天然隔离：换章 = 换会话 = 换工作目录。
- 围栏**内部**的 `#` 不是标题（代码注释不算）；front-matter 里的 `#` 也不是（YAML 注释）。
- 首个 h1 之前的内容属于**隐式首章**（title 为空串），仅当其中确有围栏才保留；
  不规范文档没 h1 时整篇落进这一个隐式章，无需任何兼容分支。

（跨章具名会话、自定义工作目录属于 v2 储备，见 DESIGN §12——v1 章 = 会话是唯一规则。）

## 8. 文档级默认（front-matter `code-exec:`）

不在 info-string 里、但与围栏执行强相关——讲义自包含的配置层：

```yaml
---
code-exec:
  java:   { class-path: "D:/repo/hadoop-client-3.1.3/*", JAVA_HOME: "D:/jdk-17" }
  python: { PYTHON_PATH: "D:/anaconda3/python.exe" }
  mysql:  { HOST: db.example.com, DATABASE: homework }
  hive:   { CLIENT: "D:/hive/bin/beeline.cmd", HOST: hs2.example.com }
---
```

- 只支持映射嵌套 + 标量值，不解析 YAML 其余语法；`code-exec:` 段结束于顶层键出现。
- **秘密（密码 / ssh 档案）永远不写这里**——只放引擎层 `createEngine({ config })`。
  这是讲义能进 git / 分享的前提。
- 优先级：fence meta（块级）> front-matter `code-exec:`（文档级）> 引擎层 config。

## 9. 示例

**好**

````
# 第三章 WordCount

```bash setup
export HADOOP_HOME=/opt/hadoop
```

```java
// jshell 会话内，第三章的所有 java 块共享状态
Path p = Paths.get("/input");
```

```csv file=input.txt
hello world
hello hadoop
```

```bash
hadoop jar wc.jar WordCount input.txt output/
```

```sql
SELECT word, COUNT(*) FROM wc GROUP BY word;
```
````

**坏（会降级为 invalid，仅展示）**

````
```bash demo setup              角色冲突（demo + setup）
```csv file=/abs/path.csv       file= 用了绝对路径
```bash job setup               job 与 setup 互斥
```
````

**记 problem 降级展示（标注已删除，见 §4）**

````
```python session=exp    未知标注 session= → 块不执行
```sql dialect=hive      未知标注 dialect= → 用 hive 请直标 ```hive 围栏
```
```

## 10. 已知限制（与 `TODO.md` 对齐）

- 块正文里的 `[user@host ~]$` 提示符是 **shell 模块的 tunnel 路由判据**，不在
  info-string 里——写法见 `runners/shell.js::parsePromptTarget`。

## 附：解析函数清单（`fences.js`）

| 函数                  | 作用                                                        |
| --------------------- | ----------------------------------------------------------- |
| `parseFenceInfo`      | 解析单条 info-string → `{ lang, meta }`                      |
| `parseFences`         | 解析全文围栏 → `[{ lang, code, meta, line, end }]`          |
| `parseChapters`       | 按 h1 分章，把围栏归属到章                                  |
| `parseCodeExecFrontMatter` | 读 front-matter `code-exec:` → `{ config, problems }`  |
| `locateFence`         | 用 (lang, code) 在围栏列表里定位下标（会话/过期链的锚）     |
| `fullFenceCode`       | 放映态切片还原：用片段的连续行回源码找完整块                |
| `sourceFences`        | 读源码 + 解析，读不到返回 `[]`（调用方退回原样执行）        |
