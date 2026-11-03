---
theme: python-mini-pptx
paginate: true
headingDivider: 5
title: 学生成绩统计与可视化
date: 2026-11-03 22:00:00
categories:
- Python
tags:
- Python
- pandas
- matplotlib
- 数据可视化
code-exec:
  session-boundary: h1
  python:
    PYTHON_PATH: "D:/ProgramData/anaconda3/python.exe"
---

<div class="cover"><h1>学生成绩统计</h1><p>pandas 读数据、matplotlib 画图的第一课</p></div>

# 案例概览

本案例统计一个班级的考试成绩，并用柱状图与饼图展示分布。是数据分析"读数据 → 算统计量 → 画图"三步的最小完整形态。

## 业务问题

给定一份 CSV 成绩单，回答三件事：每人多少分、全班整体如何、分数段分布怎样。

## 输入数据与预期输出

输入 `scores.csv`，8 名学生：

| 姓名 | 成绩 |
| ---- | ---- |
| 张三 | 85   |
| 李四 | 92   |
| 王五 | 78   |
| 赵六 | 65   |
| 孙七 | 88   |
| 周八 | 95   |
| 吴九 | 72   |
| 郑十 | 83   |

预期产出两张图：学生成绩柱状图、等级分布饼图。

## 前置与后继

| 关系   | 案例         | 承接的知识点              |
| ------ | ------------ | ------------------------- |
| 前置   | Python 基础  | 变量、列表、字典、循环    |
| 本案例 | 成绩统计可视化 | pandas 读表 + matplotlib 画图 |
| 后继   | 多源数据合并 | 多个 DataFrame 的 concat/merge |

# 理论篇：数据分析的三步

## 读数据、算统计、画图

数据分析的任务可以压缩成三步：把数据读进来、算出要看的数、画成图给人看。

| 阶段   | 做什么           | pandas / matplotlib 的工具       |
| ------ | ---------------- | -------------------------------- |
| 读数据 | CSV → 内存表     | `pd.read_csv("文件名")`          |
| 算统计 | 均值、最大、分段 | `df["列"].mean()`、`pd.cut()`    |
| 画图   | 柱状图、饼图     | `plt.bar()`、`plt.pie()`         |

三步互相独立又顺序依赖——读完才能算、算完才能画。

## DataFrame：一张内存里的表

pandas 的核心数据结构是 `DataFrame`——你可以把它想成一张 Excel 表：有列名、有行索引、每一格有值。

```python demo
df = pd.read_csv("scores.csv")   # 读 CSV，得到 DataFrame
df.head()                        # 看前 5 行
df["成绩"]                       # 取一列（Series）
df["成绩"].mean()                # 这一列的均值
```

这三行分别对应"看全表、取一列、算一个数"。后续的画图都建立在 `df` 这张表上。

## matplotlib：图是 plt 对象的副作用

matplotlib 画图不是"函数返回一张图"，而是往当前的 figure 对象上叠加图层——`plt.bar()` 画柱子、`plt.title()` 加标题、最后 `plt.show()` 触发渲染。

```python demo
plt.figure(figsize=(8, 4))       # 新建一张画布
plt.bar(df["姓名"], df["成绩"])  # 画柱状图
plt.title("标题")                # 加标题
plt.show()                       # 渲染（讲义里由引擎捕获）
```

# 实训篇：学生成绩统计与可视化

本章的 Python 会话由一个引导块开路：会话建立时自动执行，把后续每块都要用的 `pandas` 与 `matplotlib` 导入命名空间、设好中文字体（幂等，重放时重跑无害）：

```python setup
import pandas as pd
import matplotlib.pyplot as plt
plt.rcParams["font.sans-serif"] = ["Microsoft YaHei", "SimHei", "sans-serif"]
plt.rcParams["axes.unicode_minus"] = False
```

## 步骤一：准备数据

先把成绩单物化到本章工作目录，后续 `pd.read_csv` 才找得到它：

```text file=scores.csv
姓名,成绩
张三,85
李四,92
王五,78
赵六,65
孙七,88
周八,95
吴九,72
郑十,83
```

输入是标准 CSV：第一行表头、逗号分隔、无特殊编码。

## 步骤二：读取与基本统计

读 CSV 得到 DataFrame，用 `describe()` 一眼看完整张表的统计概貌：

```python
df = pd.read_csv("scores.csv")
df.describe()
```

`describe()` 返回一张表：count（人数）、mean（均值）、std（标准差）、min、max、四分位数。DataFrame 作为尾表达式，引擎自动渲染成表格——不需要 `print`。

全班 8 人，均值约 82.25，最高 95（周八），最低 65（赵六）。

## 步骤三：成绩分布柱状图

把每个人的成绩画成柱状图，一眼看出谁高谁低：

```python
plt.figure(figsize=(8, 4))
plt.bar(df["姓名"], df["成绩"], color="#4C9AFF")
plt.title("学生成绩分布")
plt.xlabel("姓名")
plt.ylabel("成绩")
plt.axhline(y=60, color="red", linestyle="--", linewidth=1, label="及格线")
plt.legend()
plt.tight_layout()
plt.show()
```

`plt.axhline` 画一条水平参考线——及格线 60 分，低于它的柱子一目了然。`plt.tight_layout()` 自动调边距，防止标签被裁掉。

## 步骤四：分数段饼图

按区间把成绩分等级，统计各等级人数，画成饼图看分布结构：

```python
bins = [0, 60, 70, 80, 90, 100]
labels = ["不及格", "及格", "中等", "良好", "优秀"]
df["等级"] = pd.cut(df["成绩"], bins=bins, labels=labels)
counts = df["等级"].value_counts()
counts
```

`pd.cut` 按区间把数值切成分类：`[0,60)` 不及格、`[60,70)` 及格、`[70,80)` 中等、`[80,90)` 良好、`[90,100]` 优秀。`value_counts()` 统计每类几人。Series 作为尾表达式渲染成表。

预期 8 人分布：不及格 0、及格 1（赵六）、中等 2（王五、吴九）、良好 3（张三、孙七、郑十）、优秀 2（李四、周八）。

```python
plt.figure(figsize=(6, 6))
plt.pie(counts, labels=counts.index, autopct="%1.1f%%", startangle=90)
plt.title("成绩等级分布")
plt.tight_layout()
plt.show()
```

`autopct` 自动标百分比、`startangle=90` 从 12 点方向开始画。饼图适合看"各部分占整体多少"，柱状图适合看"每个个体的值"——同一份数据、不同图表回答不同问题。

# 小结

成绩统计把数据分析的三步压缩到了最小：`read_csv` 读、`describe/cut` 算、`bar/pie` 画。

## 三句话回顾

- pandas 的 DataFrame 就是一张内存表，`read_csv` 一行读进来。
- matplotlib 往 figure 上叠加图层，`show()` 触发渲染——讲义里引擎自动捕获落盘。
- 同一份数据，柱状图看个体、饼图看结构，图表选择取决于要回答的问题。

<div class="end"><h1>学生成绩统计</h1><p>下一内容：多源数据合并</p></div>
