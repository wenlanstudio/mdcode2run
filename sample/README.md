# sample —— 可运行讲义样本

给课程老师的参照：一份 Markdown 就是一份可运行讲义。这里的每份样本
都真跑验证过（本机 anaconda + JDK），复制改内容就是你的第一份讲义。

## 样本清单

| 文件 | 课程 | 语言 | 覆盖能力 |
| --- | --- | --- | --- |
| `python-basic.specimen.md` | Python 基础 / 数据可视化 | python | file= 物化 CSV → pandas 读取 → DataFrame 渲染成表（kind=table）→ matplotlib 图捕获（kind=figure） |
| `java-basic.specimen.md` | Java 基础 / OOP 入门 | java | setup 定义类 → 后续块复用 → jshell 会话共享状态 → 表达式求值 |

`test/fixtures/4-1-1-Hadoop_MapReduce.specimen.md` 是测试专用标本
（依赖 Hadoop classpath，不适合直接参照），演示 tunnel/job 等进阶形态。

## 怎么跑

```bash
# 看一份讲义里有哪些可执行块（行号从 1 开始）
node bin/mdcode2run.js list sample/python-basic.specimen.md

# 跑某一个块（先物化 file= 数据、再自动执行 setup 引导块）
node bin/mdcode2run.js run sample/python-basic.specimen.md --at 126

# 后面的块依赖前面的状态时，从章首连跑到目标块
node bin/mdcode2run.js replay sample/python-basic.specimen.md --at 139
```

环境要求写在每份样本的 front-matter `code-exec:` 段（PYTHON_PATH / JAVA_HOME），
按你的机器改路径即可。

## 标注速查（详见 FENCE.md）

| 标注 | 语义 |
| --- | --- |
| （无） | 可执行块：跑它，进过期链 |
| `demo` | 只展示不跑（语法演示、终端转写） |
| `setup` | 引导块：会话建立时自动先跑（幂等） |
| `file=路径` | 物化：块内容写进章工作目录，供后续块读取 |
