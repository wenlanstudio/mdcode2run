# Development Rules

This file provides guidance to AI agents when working with code in this repository.

## 人机协作开发协议

- 用户与AI：
  - 双方共同遵循
    - 名正言顺（名正方能言顺：概念正确，理论才正确；命名规范，代码逻辑才能顺畅）
    - 名副其实（名实相符：文档与代码相符、概念与理论相符、变量与代码逻辑相符等）
  - 用户：不断提出新的需求，推动项目演进
  - AI：
    - AI需要拥有独立自主的思想，实事求是、客观中立
    - 不向用户的不合理需求妥协
    - 根据用户需求，捕捉用户的精神状态，如用户词不达意，提醒用户头脑清醒后再下达指令
- AI与文档：用户的文档可能不准确，请仔细甄别，可修改优化文档；
- 文档与设计：名副其实，文档和设计相匹配
  - 文档：
    - 采用合适的结构进行思想陈述
    - 文档言简意赅
  - 设计：
    - 追求规范的项目架构设计
    - 可考虑配以合适的图表
- 设计与开发：
  - 边开发边修改设计
  - 边设计边进行项目重构
- 开发与Bug：不能为了快速修复bug、省事、省时而不断地打补丁；
- Bug与测试：复现 → 根因分析 → 修复 → 回归测试 → 关闭
- 周而复始，直至项目成熟完善

## Project Overview

mdcode2run 是 Markdown 代码执行引擎：**块角色标注 + 章会话 + file= 物化 + 过期链 + 重放 + 作业**。
无头核心——**引擎不知道 DOM 的存在**，结果只经结果契约 + 事件流交付，呈现归宿主
（姊妹项目 [md2slides](https://github.com/wenlanstudio/md2slides) 放映器或任意自定义宿主）。

- **Version**: see `package.json`
- **License**: MIT
- **Repository**: <https://github.com/wenlanstudio/mdcode2run>
- **路线图与已知问题**: `TODO.md`（动手前必读；`README.md` 的「已知边界」同读）

## Tech Stack

| Layer       | Technology                                        |
| ----------- | ------------------------------------------------- |
| Language    | JavaScript（CommonJS，零框架、零转译）            |
| Runtime     | Node.js >= 16.6（CI 跑 Node 20）                  |
| Dependencies | 仅 `ssh2`（远端 shell / tunnel）                 |
| Tests       | 零依赖 `assert` 脚本，`test/run-all.js` 逐个 spawn |
| CI          | GitHub Actions — `test:quick` × ubuntu + windows  |
| Package manager | npm（无 workspace、无 monorepo）              |

刻意不引入的东西：TypeScript、打包器、测试框架、lint 配置。风格靠约定（见 Code Style），
测试靠门控跳过（见 Testing）。加依赖前先问：这个能力纯 Node 真写不出来吗？

## Directory Structure

```
<repo-root>/
  index.js               引擎门面（createEngine / contractFail）——对外唯一入口，
                         require("mdcode2run") 只拿到这两个
  bin/mdcode2run.js      CLI：list / run / replay（--json 走结果契约）
  fences.js              块解析：info-string 词汇表 / 分章 / front-matter 子集（纯函数，可单测）
  front-matter.js        前言配置读取（code-exec.<段>.<键> → 顶层旧写法）
  sessions.js            会话注册表（懒建立 / 并发共享创建 / 死会话重建 / 空闲回收）
  chapter.js             章计划：setup/file/blocks 清单、内容指纹、file= 物化
  session-run.js         会话编排：物化 → 引导 → 过期链 → 运行/重放（语言无关）
  events.js              事件流（started / chunk / done，EventEmitter）
  languages/             五个语言模块：认语言、查环境、给选项、路由 runner
  runners/               八个执行器（纯 Node）：python(.session) / java(.session) /
                         shell / query / hive(beeline) / job
  test/                  测试套件（run-all.js 自动纳管新文件）+ fixtures/ 测试标本
  sample/                可运行讲义样本（老师参照用）：python/java 基础，
                         真跑验证过；specimen 命名沿用
  sample/mrjob/           实验原型：一文档一 MapReduce 作业（独立于主引擎，
                         npm run test:mrjob，不在 run-all 批里）
```

## Development Workflow

```bash
npm install               # 只有 ssh2 一个依赖

# CLI（无头调试的基本手段；执行流式输出走 stderr，最终报告走 stdout）
node bin/mdcode2run.js list   讲义.md            # 盘点：哪些块可跑、什么角色
node bin/mdcode2run.js run    讲义.md --at 128   # 跑第 128 行所在块（行号 1 基）
node bin/mdcode2run.js replay 讲义.md --at 360   # 从本章第一个可跑块连跑到这里
# 可选：--replay / --timeout <ms> / --json / --config <file.json>
```

作为库消费（宿主接入的标准形状，详见 README 快速开始）：

```js
const { createEngine } = require("mdcode2run")
const engine = createEngine({ config, documentPath, documentDir })
const parsed = engine.parse(md)          // → { blocks, chapters, fm, fences }
const ctx = engine.locate(md, { line })  // 不可执行 / 不支持的语言 → null
const result = await engine.run(ctx, { onChunk })  // 结果契约
engine.resetSession(ctx)                 // ⟳ 销毁会话
engine.dispose()                         // 宿主关文档时回收全部常驻会话
```

## Testing

```bash
npm test          # 全量：真实 JDK / anaconda / mysql / Hive 按 MDX_* 门控，缺环境自动跳过
npm run test:quick    # 跳过 java-session / python-session 两套（CI 就跑这个）
npm run test:mrjob    # sample/mrjob 原型，独立于主引擎
node test/fences.test.js   # 单套直接跑（每套都是独立进程、零依赖）
```

门控环境变量：`MDX_HIVE_HOST/USER/PASSWORD`、`MDX_MYSQL_HOST/USER/PASSWORD` 等；
对应段在环境缺失时**打印跳过说明并计入通过**，不是失败。测试标本在 `test/fixtures/`
随仓库分发（教学样本另见 `sample/`，二者分开：fixtures 面向 CI 走查，sample 面向老师参照）；
「环境可跳过 + 标本入库」是 CI（ubuntu + windows）全绿的前提。

**测试壳铁律**：每套测试自己实现 `t(name, fn)` 微壳。**异步用例必须被 await 到
process.exit 之前落定**——`t()` 同步调用 async fn、末尾直接 `process.exit()`，会让
全部用例变成空壳还显示全绿（`test/sessions.test.js` 犯过此错）。正确写法见
`test/session-run.test.js`（`await Promise.all(pending)`）与 `test/job.test.js`
（`await fn()`）。写新测试前先看这两个文件的壳。

## Code Style

无 lint 工具强制，风格靠约定（与 wenlan-studio 系出同门，但这里是 CJS 纯 Node）：

- 2-space 缩进
- **不加行尾分号**
- **一律双引号**（历史决定，全仓库统一；新文件不要引入单引号风格）
- 命名：内部约定带 `_` 前缀（`this._entries`）；对外 API 不带
- 每个核心模块文件头有一段「职责边界」注释（见 sessions.js / index.js 顶部）——
  改模块先读懂它，改完让它继续属实

### Comments

沿用 wenlan-studio 的注释纪律：注释必须写代码本身看不出来的东西——理由、单位、
不变量、归属、调用方需要的抽象；不复述代码、不重复名字里已有的词。收尾前把
新增/触碰过的注释过一遍，只复述代码的删掉。优先自解释的命名；确需注释时写短、
写完整、贴在被描述的代码旁边。

## Architecture: 无头四层模型

```
④ 门面      index.js              parse / locate / run / replay / resetSession / events
③ 编排      fences / front-matter / sessions / chapter / session-run（语言无关）
② 语言模块   languages/            认语言、查环境（checkRuntime）、给选项、路由 runner
① Runner    runners/              纯 Node 执行器，产出结果契约
─────────────────────────────────────────────────────────────
宿主（不进引擎）  md2slides 放映器 / marktext / 任意自定义宿主渲染结果契约
```

架构铁律（改代码前默背）：

1. **引擎不知道 DOM 的存在**——document/window 零引用；呈现 = 消费者渲染结果契约。
2. **结果契约是唯一的墙**：`{ ok, kind, stdout, text, error }` 上扩展 `rows`（query）、
   `images`（图捕获）、`session`（章会话 HUD）、`job`（作业句柄）。上面三层不认识具体语言。
3. **章 = 会话边界**（h1）：同章同语言共享解释器状态，章工作目录跨语言共享
   （shell put 的文件 java 读得到）；跨章天然隔离。会话 key = 文档路径 + 章行号 + 语言族。
4. **重放只有最后一块进流**——重放的意义是恢复状态，中间块的输出只会淹没观众。
5. **重放跳过作业块**——重放必须幂等安全，重启作业是手动 ▶ 的事。
6. **可执行角色只有 code 与 setup**；demo / file / invalid 不参与执行（index.js 的
   RUNNABLE_ROLES 是唯一裁决处）。

## Conventions

- **配置三层**（优先级从高到低）：fence meta（块级）> front-matter `code-exec:`
  （文档级）> `createEngine` config（引擎层）。**秘密（密码 / ssh 档案）只放引擎层**
  ——前言层无权携带，这是讲义能进 git / 分享的前提。别在新代码里给前言层加秘密通道。
- **块角色词汇表**（fence info-string）：`demo` / `setup` / `file=<路径>` /
  `session=<名>` / `dialect=<名>` / `workdir=<路径>` / `job`。词汇解析在 fences.js；
  「解析了」不等于「被消费了」——接词汇时以 README 词汇表的状态列为准，别信记忆。
- **执行原型**（不是按语言分类，是按形状）：eval（常驻解释器）/ exec（一次性）/
  query（SQL → rows）/ job（异步长任务）/ tunnel（ssh 提示符路由）。新语言先想清楚
  归哪个原型，再决定 languages/ 与 runners/ 各加什么。
- **CLI 的会话不跨进程**：每条命令是新进程、新会话（章工作目录在 tmp 稳定复用）。
  跨块状态链路用 `replay`（一个进程内 setup → … → 目标块）。

## Important Notes

- **常驻会话会撑住事件循环**：JVM / 解释器的 stdio 管道不让 Node 退出。长驻宿主可以
  一直留着（空闲自动回收）；CLI / 构建脚本干完活必须显式 `engine.dispose()`——
  等 `process.on("exit")` 是等不到的。
- **jshell 首建会话有秒级预热**（大 classpath）；`--timeout` 管单请求上限，超时会话
  作废、下次重建。写 java 相关测试/基准时把这个预热算进去。
- **beeline 在 Windows 不能直接 spawn**：`hive.CLIENT` 需指向可执行的 wrapper
  （beeline 由 Hive 发行版提供，Hadoop 发行版不含）。
- **`sessions.js` 曾有并发/回收缺陷**（2026-11-03 已修，留作护栏）：并发 acquire 时
  `entry.session` 为 null 抛 TypeError；`entry.creating` 从不复位导致空闲回收失效。
  修复要点：判 `entry.session` 存在性而非直接取 `.alive`；factory resolve 后
  `entry.creating = null` 复位。同期 `test/sessions.test.js` 的同步测试壳被改成
  pending + `await Promise.all(pending)`——原壳让 async 用例全空壳、CI 假绿掩盖
  上述两条 bug。动 sessions 逻辑前先看 `test/session-run.test.js` 的壳写法。
- **fences.js 是纯函数**：解析逻辑（词汇表 / 分章 / 前言）全部保持可单测、无 IO；
  发现解析与执行耦合时先解耦再改。
- **新增 runner**：跑在子进程里的东西注意 stdio 编码（Windows 下 GBK 坑）与僵尸
  进程（树杀走 `runners/job.js` 的路径，不要裸 kill 单进程）。

## Contribution

- 直接在 `master` 提交（个人驱动仓库，无 develop 分支）；PR 须过 CI（ubuntu + windows 的 test:quick）。
- 提交信息用中文、动词开头、注明模块域（参考 `git log` 现有风格：`feat(hive): …`、`ci: …`）。
- 改行为必须连带测试：修 bug 先写复现用例（复现 → 根因 → 修复 → 回归），新能力补对应套件。
- 改 README/TODO 断言前先核实代码——文档与代码不符时，以代码为准修文档。
- 不把运行产物、标本输出、含真实密码的配置提交进仓库；秘密只存在于引擎层 config。
