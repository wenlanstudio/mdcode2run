# TODO

路线图；与 `README.md`（定位/边界）和 `ARCHITECTURE.md` 原插件版（四层）呼应。打勾即完成。

## 进行中 / 下一步

- [x] **P1b 放映执行桥接**（2026-10-25 代码完成，md2slides 侧 `host/typora/exec-bridge.js`）：
      deck 就绪后装饰 ▶/⏩（`data-md2s-activatable`；分页切片自动还原成源码整块再定位），
      点击调 `engine.run/replay`，结果浮层（流式 + 表/图 + 会话 HUD + 作业计时终止，
      Enter/Esc 关闭且不惊动播放器键盘）。jsdom + 真引擎全链路测试过。
  - [x] 引擎分发：**没用 file: 包依赖**（会拖垮 CI 的 npm ci）——改四级路径回退解析
        （EXEC_ENGINE_PATH → 部署副本 engine/ → node_modules → 生态兄弟目录），缺失静默降级
  - [x] 单引擎实例：桥内按文档路径缓存引擎，跨放映存活；壳 stop 时统一 dispose
  - [ ] Typora 实机验收走查（下条）
- [x] **code-exec 退役存档**（2026-10-25）：完整快照存于 `docs/legacy-code-exec/`
      （含说明：各部分下落）；Typora-2 旧环境保留作二级备份。**不做薄壳化**——
      编辑态执行改为 md2slides 壳的未来功能（壳内 editrender 同族），见其 TODO wishlist
- [ ] **验收走查**：wordcount 标本在 md2slides 放映里跑通实训篇重放链
      （setup → 步骤二 → 步骤三）

## 之后

- [x] **P2/P3（原"薄壳化 / marp 退役"）——方向改判，不再执行**（2026-10-25）：产品
      收敛为双引擎双宿主，code-exec 整体退役存档（见上），不保留 obgnail 框架路径；
      marp 已随 md2slides 新壳自然淘汰。编辑态执行若做，归 md2slides 壳（见其 wishlist）
- [ ] **P4 引擎内功**（按痛感排期，不阻塞宿主）：
  - [ ] 三个常驻 harness（java-session / python-session / shell 的协议部分）收敛成一个
        协议框架——JDK/anaconda 升级砸协议时只改一处；词汇参考 Jupyter message schema
  - [ ] 词汇表接线：`session=`（跨章具名会话）、`dialect=`（```sql dialect=hive）、`workdir=`
        （解析已就位，消费未接）
  - [ ] tunnel 镜像上传：会话建立时把章工作目录上传远端 `~/md-exec/<doc>/<chapter>/`
        （"在 node0 上 hdfs dfs -put"靠它成立；上集群课前需要）
- [ ] **CI**：push 已触发 offline 套件（`npm run test:quick`；java/python 两套慢测试在
      无真实环境的 runner 上自动跳过）
- [ ] **发布方式**：`mdcode2run` 名字 npm 未占用（2026-10-25 核过）——GitHub tag 起步，
      需要时再发 npm；生态内消费方：md2slides 壳、marktext 集成
- [ ] **marktext 宿主**（DESIGN 第 7 步）：muya fence 扩展 + main 进程 runner（IPC 流式）；
      引擎经 `file:` 依赖进 fork，集成代码收敛在独立子目录给上游合并留活路

## 已完成

- [x] 2026-10-25 从 Typora code-exec 提取核心：引擎门面 + 语言模块去壳 + 核心层平移，
      9 套测试全绿（真实 JDK+hadoop 标本链路、anaconda 图捕获）+ wordcount 标本 CLI 走查
- [x] 2026-10-25 修复 CLI 跑完不退出：常驻 JVM 的 stdio 管道撑住事件循环，
      一次性进程必须显式 `engine.dispose()`（已写进 README 消费方注意）
- [x] 2026-10-25 迁入 `D:/md-ecosystem`（与 md2slides、marktext 同一工作区根）
