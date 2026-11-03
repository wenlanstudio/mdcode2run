# mrjob — 一文档一作业（原型试验场）

「一份讲义 = 一个 MapReduce 作业」的协议原型：front-matter 声明作业骨架（类名、各阶段
类型、combiner 策略、输入输出），正文只写每个阶段的**方法体片段**。引擎负责校验、
织入成完整 Java 工程、编译、本地提交——外层类、方法签名、泛型、import、驱动 `main`
全部由骨架生成，不写在正文里。

这是主引擎（`../../`）之外的**实验分支**：不碰主引擎测试，验证「文档原型」这条路
走得通之后，再决定收敛方式（词汇进 `fences.js` / 织入进 `chapter.js`，或独立成模块）。

## 快速开始

```bash
node cli.js wordcount.md parse   # 盘点：骨架 + 块清单 + problems
node cli.js wordcount.md weave   # 织入：打印生成的 .java（--write 落盘 .mdjob/src）
node cli.js wordcount.md check   # 物化 + 织入 + javac + jar（不上集群）
node cli.js wordcount.md run     # 全管线：本地提交，输出 part-r-00000
node test.js                     # 全量测试（MDX_MRRUN=1 附带真实提交）
```

环境约定（全部可用环境变量覆盖，与本机已验证组合一致）：

| 角色 | 解析 | 本机值 |
|---|---|---|
| 编译/运行 JDK | `MDX_JDK_HOME` → `JAVA_HOME` | `D:\Program Files\Java\jdk1.8.0_471` |
| 客户端 jar | `MDX_HADOOP_HOME`（须含 `share/hadoop`） | `D:\bigdata\hadoop\hadoop-3.1.3` |
| 原生层（winutils/hadoop.dll） | `MDX_WINUTILS_HOME` → `HADOOP_HOME` | `D:\bigdata\hadoop\hadoop-3.1.0` |

jar 与原生层是**两个目录**：课程机常见组合就是「3.1.0 的 winutils 工具包 + 3.1.3 的
发行版 jar」。注意 3.1.3 发行版自带的那颗 hadoop.dll 在本机不可用（原生 access 探针
失败），原生层必须用 3.1.0 的——引擎按 winutils 存在性自动解析。

## 协议

### front-matter `mr-job:` 段（词汇封闭，未知键 = problem）

```yaml
mr-job:
  name: WordCount            # 必需。派生类名：WordCountMapper / WordCountReducer / …
  types:                     # 必需。三个槽位，各为“两个 Writable 类型，逗号分隔”
    in: LongWritable, Text       # map 输入（行偏移, 一行文本）
    map-out: Text, IntWritable   # map 输出 = reduce/combiner 输入（一致性由构造保证）
    out: Text, IntWritable       # 最终输出
  combine: reduce            # 可选。reduce = 复用 Reducer 类；独立片段则不写此键
  input: data/bigdata.txt    # 必需。相对路径，基准 = 作业工作目录
  output: out/wordcount      # 必需。相对路径；引擎提交前自动清除
  jar: wc.jar                # 可选。缺省 <name 小写>.jar
  imports: [java.util.StringTokenizer]   # 可选。进全部生成文件
  classpath: "…;dir/*"       # 可选。覆盖默认的发行版 jar 全集
```

### fence 词汇

| 标注 | 名义 | 语义 |
|---|---|---|
| ` ```java map ` | map 片段 | 方法体；形参协议 `key / value / context` |
| ` ```java reduce ` | reduce 片段 | 方法体；形参 `key / values / context` |
| ` ```java combine ` | 独立 combiner | 同 reduce；与 `combine: reduce` 互斥 |
| ` ```java partition ` | 分区器 | 方法体；形参 `key / value / numPartitions`，**不声明受检异常** |
| ` ```java driver ` | 覆盖驱动 | 教驱动本身的课：骨架只供类壳与 main 签名 |
| ` ```file=<相对路径> ` | 数据块 | 物化进作业工作目录 |
| ` ```bash job ` | 提交块 | 预留（集群后端消费） |
| ` ```java demo ` | 示意块 | 不参与织入 |

map/reduce 片段必需且唯一；combine/partition/driver 可选；未知标注、角色冲突、重复
片段、类型形状不对 → problems → **拒绝执行**（无歧义是引擎保证的性质，不是作者自觉）。

### 织入与回映

```
wordcount.md ──parse──> fm + blocks ──weave──> WordCountMapper/Reducer/Main.java
                                                   │  每行带来源（gen | 片段名:行号）
                                                   ▼
                              javac 报错 WordCountMapper.java:13
                                                   │ remap
                                                   ▼
                              “map 片段第 2 行：cannot find symbol”
```

类型一致性靠构造不靠检查：map 输出与 reduce 输入读的是同一份 `types.map-out`。

## 本地提交的三个坑（Windows 课程机）

1. **无盘符路径过不了原生层**：默认 `/tmp`、`/tmp/hadoop/mapred/staging` 在
   winutils/hadoop.dll 上 mkdirs 直接失败（errno 0）。引擎生成 `.mdjob/conf/core-site.xml`
   把 tmp/staging/local 全钉进作业工作目录（带盘符），前置进 classpath——
   `-D` 系统属性对 Hadoop 配置键无效，必须走 XML。
2. **hadoop.cmd 不能用**：发行版脚本对带空格的 JDK 路径有多处裸展开。本地后端 =
   IDEA 式直接启动主类（`java -cp conf;classes;jars 主类 in out`），这也是讲义
   步骤五教学生的跑法。
3. **`hadoop jar` 的 RunJar 3.1.x 只认 manifest 主类**（显式主类参数 3.3+ 才有）——
   jar 仍产出（`jar cfe` 写 manifest），供教学与将来的集群后端。

## 文件

```
wordcount.md   理想标本（贴真实讲义风格：正文讲原理，片段只写方法体）
parse.js       文档 → { fm, blocks, problems }（纯函数）
weave.js       校验 + 织入 + 行号映射 + javac 诊断回映（纯函数）
run.js         物化 → 织入 → javac → jar → 提交（唯一碰进程/文件的一层）
cli.js         parse / weave / check / run，--json 走契约
test.js        全链路测试；编译段按 JDK+hadoop 存在性门控，MDX_MRRUN=1 附真实提交
.mdjob/        作业工作目录（每次运行重建）：src/classes/data/conf/{jar,out,…}
```

## 与主引擎的关系

- `slot` 词汇、织入产物走 file= 物化通道、job/tunnel 原型承接集群提交——这些结论
  将来收敛回主引擎；本目录保留为协议演进的试验场。
- 后续案例（分组汇总 / Combiner / Partitioner / 排序 / Join）多数是「换 types +
  换片段」即可表达；自定义 Writable / 多阶段链等超纲形态走 file= 全量文件通道，
  协议管八成标准作业，file= 兜底两成。
