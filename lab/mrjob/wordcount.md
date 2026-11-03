---
title: 词频统计 WordCount（可执行标本）
code-exec:
  java:
    JAVA_HOME: "D:/Program Files/Java/jdk-17.0.20.1"
    class-path: "D:/repo/hadoop-client-3.1.3/*"
mr-job:
  name: WordCount
  types:
    in: LongWritable, Text
    map-out: Text, IntWritable
    out: Text, IntWritable
  combine: reduce
  input: data/bigdata.txt
  output: out/wordcount
---

# 案例概览

给定任意文本，回答"每个单词出现了几次"。它是所有"分组 + 累加"类需求的原型——后面的案例
都是把 `<word, 1>` 换成别的 key/value，骨架不变。

本文档是一份**可执行的作业**：front-matter 里的 `mr-job:` 段声明了作业的全部骨架
（类名、各阶段类型、combiner 策略、输入输出路径），正文只保留每个阶段的**方法体片段**。
引擎负责把它们织入成完整的 Java 工程——外层类、方法签名、驱动 `main`、import 清单
全部由骨架生成，不写在正文里。

# 数据流

```text
(LongWritable, Text)  --map-->  (Text, IntWritable)  --reduce-->  (Text, IntWritable)
     行偏移, 一行文本        单词, 计数 1            单词, 总次数
```

四个泛型按固定顺序规定 `map` 的入参和出参。`LongWritable` 是输入行的字节偏移量，
本案例用不到它——它只是 TextInputFormat 规定必须带的位置标记。

# 步骤一：Mapper

每行调用一次 `map`，把行切成单词，每个单词发一个 `<word, 1>`。写法只需要填方法体，形参固定是 `key`（行偏移）、`value`（一行文本）、`context`（输出通道）：

```java map
String[] wordArray = value.toString().split(" ");

IntWritable one = new IntWritable(1);

for (String word : wordArray) {
    context.write(new Text(word), one);
}
```

引擎生成的骨架长这样（示意，不可执行；真实生成物见「织入与全貌」一节）：

```java demo
public class WordCountMapper extends Mapper<LongWritable, Text, Text, IntWritable> {
    @Override
    protected void map(LongWritable key, Text value, Context context) {
        // 只填这里：一行文本怎么变成若干 <key, value>
    }
}
```

分工很清楚：**框架负责什么时候调用你、在哪台机器上调用、数据从哪来；开发者只填中间那一小段转换逻辑**。`map` 每行调用一次，但这个类是框架只 new 一次的——方法体里才是每次调用独立的世界。

`1` 是一个"占位计数"。后续案例把它换成工资、金额等真实数值，但"map 发计数、reduce 做加法"的结构不变。

# 步骤二：Reducer

遍历同一单词的 value 列表，累加后输出一次：

```java reduce
int count = 0;
for (IntWritable value : values) {
    count += value.get();
}
context.write(key, new IntWritable(count));
```

`context.write` 在循环**外面**——每个单词只输出一行。如果误写进循环，会退化成"逐条原样输出"。形参固定是 `key`（单词）、`values`（该词的全部计数）、`context`。

# 步骤三：Combiner

本作业声明了 `combine: reduce`——map 端先做一次本地预聚合，减少 Shuffle 传输量。对"求和"这类满足结合律的聚合，直接复用 Reducer 类即可，引擎会在驱动里生成对应的`setCombinerClass`。换算成金额求平均这类**不可直接复用**的聚合，就要写独立的
combine 片段（`java combine`）——那是后面案例的事。

# 输入数据

```file=data/bigdata.txt
a
a b
a b c
```

纯文本，无需表头、无需特殊处理。`file=` 块在运行前物化进作业工作目录，`mr-job.input` 的相对路径以它为基准。

# 步骤四：提交作业

驱动类 `WordCountMain`、import 清单、作业配置（步骤四的十行 `job.setXxx`）全部由骨架生成，正文不写。一条命令：

```bash job
hadoop jar wc.jar WordCountMain data/bigdata.txt out/wordcount
```

输出目录必须不存在（MapReduce 的规矩：防止覆盖上次结果）。引擎在提交前会自动清除上次输出并提示。

# 查看结果

```bash
cat out/wordcount/part-r-00000
```

预期输出 3 行，按单词升序：

| 单词 | 次数 |
| ---- | ---- |
| a    | 3    |
| b    | 2    |
| c    | 1    |

核对关：行数 = 不同单词数；每行第二个数是该词出现次数。

# 织入与全貌

这份文档织入后是一个标准工程，三个源文件：

| 生成文件            | 内容                                   | 来源                     |
| ------------------- | -------------------------------------- | ------------------------ |
| `WordCountMapper.java`  | Mapper 骨架 + map 方法体           | `java map` 片段          |
| `WordCountReducer.java` | Reducer 骨架 + reduce 方法体       | `java reduce` 片段       |
| `WordCountMain.java`    | 驱动：作业配置 + `main` 方法       | front-matter 骨架        |

外层类、方法签名、泛型、import 全部来自 front-matter；正文片段永远不写它们。编译报错会**映射回片段行号**——`WordCountMapper.java:13` 会告诉你"map 片段第 2 行"。

把本文档放进 IDEA 或交给 `mvn package`，它就是一份普通的 Java 工程——织入产物没有任何私有魔法，这就是"文档即作业"的边界：**约定消除的是样板，不是标准**。
