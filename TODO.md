# TODO

路线图；与 `README.md`（定位/边界）呼应。打勾即完成。

## 已知问题（2026-11-03 仓库巡检，未修）

- [ ] **SessionManager 并发缺陷**（`sessions.js:31`）：同 key 的并发 `acquire` 在首次
      创建尚未完成时，`entry.session` 还是 `null`，取 `.alive` 直接抛 TypeError。
- [ ] **空闲回收失效**（`sessions.js:35-44`、`:75`）：`creating` 建成后从不复位，`_reap()`
      见 `creating` 就跳过 → 超过 `idleMs` 的会话永远不会被回收（常驻 JVM/解释器常驻不散）。
- [ ] **测试没兜住**（`test/sessions.test.js:10-12`）：`t()` 同步调用、不 `await` 异步用例，
      上面的失败变成未处理 rejection，套件仍显示全绿；修缺陷时一并把测试壳改成 async。


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
        beeline 的 query 族（`languages/hive.js` + `runners/hive.js`，注册进 `index.js`
        LANGUAGES）→ deck 自动给 ▶；连接由引擎配置 `hive.*` + 前言 `code-exec.hive.*` 覆盖
        （PASSWORD 仅引擎层）。测试 `test/hive.test.js`（解析+URL 夹具，真实 HS2 由
        MDX_HIVE_HOST 门控）。**尚未接线**：` ```sql dialect=hive ` 仍走 mysql（见下）。
  - [ ] 词汇表接线：`session=`（跨章具名会话）、`dialect=` 在 `sql` 围栏上消费
        （` ```sql dialect=hive ` → 改走 beeline，而非 mysql；当前 hive 只接了 `hive` 直标围栏）、
        `workdir=`（解析已就位，消费未接）
  - [ ] tunnel 镜像上传：会话建立时把章工作目录上传远端 `~/md-exec/<doc>/<chapter>/`
        （"在 node0 上 hdfs dfs -put"靠它成立；上集群课前需要）
- [ ] **CI**：仓库当前没有 `.github/workflows`（尚未接）；且 `test:quick` 仍依赖本机标本与
      绝对路径（`fences`、`session-run` 两套），需先 fixture 化再上 CI——否则 runner 上直接红
- [ ] **发布方式**：`mdcode2run` 名字 npm 未占用（2026-10-25 核过）——GitHub tag 起步，
      需要时再发 npm；生态内消费方：md2slides 壳、marktext 集成
- [ ] **marktext 宿主**（DESIGN 第 7 步）：muya fence 扩展 + main 进程 runner（IPC 流式）；
      引擎经 `file:` 依赖进 fork，集成代码收敛在独立子目录给上游合并留活路

## 已完成

- [x] 2026-10-25 从旧版编辑器插件提取核心：引擎门面 + 语言模块去壳 + 核心层平移，
      9 套测试全绿（真实 JDK+hadoop 标本链路、anaconda 图捕获）+ wordcount 标本 CLI 走查
- [x] 2026-10-25 修复 CLI 跑完不退出：常驻 JVM 的 stdio 管道撑住事件循环，
      一次性进程必须显式 `engine.dispose()`（已写进 README 消费方注意）
- [x] 2026-10-25 迁入 `D:/md-ecosystem`（与 md2slides、marktext 同一工作区根）
