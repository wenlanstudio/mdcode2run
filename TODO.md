# TODO

路线图；与 `README.md`（定位/边界）、`DESIGN.md`（设计规范）呼应。打勾即完成。
DESIGN.md 是设计权威——本文件记录"做到哪了"与"下一步"，不重复设计叙事。

## 已知问题

（无未修缺陷。SessionManager 并发/回收/测试壳三条已于 2026-11-03 修复并补回归用例，
详见下方「已完成」段。）


## 进行中 / 下一步

- [x] **历史插件快照已移除**（2026-11-03）：原 code-exec 插件快照（含编辑器宿主适配与
      第三方框架依赖）已从仓库与全部历史中删除，不再维护，也不提供安装/恢复指引。

## 之后

- [x] **P2/P3（原"薄壳化 / marp 退役"）——方向改判，不再执行**（2026-10-25）：产品
      收敛为双引擎双宿主，旧插件整体退役（见上），不保留第三方框架路径；
      marp 已随 md2slides 新壳自然淘汰。编辑态执行若做，归 md2slides 壳（见其 wishlist）
- [ ] **P4 引擎内功**（按痛感排期，不阻塞宿主）：
  - [ ] 三个常驻 harness（java-session / python-session / shell 的协议部分）收敛成一个
        协议框架——JDK/anaconda 升级砸协议时只改一处；词汇参考 Jupyter message schema
  - [x] **hive 方言族落地**（2026-10-27）：` ```hive `/`hql`/`hiveql`/`sparksql` 围栏接成走
        beeline 的 query 族（`lib/languages/hive.js` + `lib/runners/hive.js`，注册进 `lib/index.js`
        LANGUAGES）→ deck 自动给 ▶；连接由引擎配置 `hive.*` + 前言 `code-exec.hive.*` 覆盖
        （PASSWORD 仅引擎层）。测试 `test/hive.test.js`（解析+URL 夹具，真实 HS2 由
        MDX_HIVE_HOST 门控）。（原记「` ```sql dialect=hive ` 尚未接线」已随词汇表
        瘦身作废——`dialect=` 删除，SQL 方言一律直标围栏。）
  - [x] **词汇表瘦身**（2026-11-03，DESIGN §12 裁决落地）：`session=`/`dialect=`/
        `workdir=` 三个冗余标注已从解析层删除（fences.js META_KEYS 只留 `file=`）。
        写它们记 `未知标注` problem、块安全降级为展示（旧文档不炸，只是对应块不跑）。
        SQL 方言用直标围栏 ` ```hive ` 等；跨章具名会话与自定义工作目录属 v2 储备。
  - [ ] tunnel 镜像上传：会话建立时把章工作目录上传远端 `~/md-exec/<doc>/<chapter>/`
        （"在 node0 上 hdfs dfs -put"靠它成立；上集群课前需要）
- [x] **CI**：`.github/workflows/ci.yml` 已接（node20 × ubuntu/windows，2026-11-03 起
      全绿；`fences`/`session-run` 等纯逻辑套件 CI 直跑，真实 JDK/anaconda 段自动门控跳过）
- [ ] **发布方式**：`mdcode2run` 名字 npm 未占用（2026-10-25 核过）——GitHub tag 起步，
      需要时再发 npm；生态内消费方：wenlan-studio（编辑态，方向已定）
- [ ] **宿主集成**（DESIGN 第 7 步，方向已定 wenlan-studio 编辑态先行，2026-11-03）：
      main 进程 execService（单例引擎 + IPC 流式）→ muya fence ▶ 角标 + cell 状态面板
      （▶/序号/stale 角标）→ 放映态桥另议。md2slides 零改动；引擎经 `file:` 依赖进消费方

## 已完成

- [x] 2026-10-25 从旧版编辑器插件提取核心：引擎门面 + 语言模块去壳 + 核心层平移，
      9 套测试全绿（真实 JDK+hadoop 标本链路、anaconda 图捕获）+ wordcount 标本 CLI 走查
- [x] 2026-10-25 修复 CLI 跑完不退出：常驻 JVM 的 stdio 管道撑住事件循环，
      一次性进程必须显式 `engine.dispose()`（已写进 README 消费方注意）
- [x] 2026-10-25 迁入 `D:/md-ecosystem`（与 md2slides、marktext 同一工作区根）
- [x] 2026-11-03 **修 SessionManager 三条缺陷**：
  - 并发 acquire 抛 TypeError（`entry.session` 为 null 时取 `.alive`）→ 改判
    `entry.session` 存在性，建立期共享同一次 creating。
  - 空闲回收失效（`entry.creating` 从不复位 → `_reap()` 永远 continue）→
    factory resolve 后复位 `entry.creating = null`。
  - `test/sessions.test.js` 测试壳同步调 async 用例 + 末尾 `process.exit()`，
    6 项全空壳（"通过 6 项"假绿，前两条 bug 因此被 CI 漏过）→ 改 pending +
    `await Promise.all(pending)` 壳（照 `session-run.test.js` 写法），并补一条
    确定性命中并发 race 的用例。修复后 sessions 7/7 真跑通过，全套 8/8 套无回归。
