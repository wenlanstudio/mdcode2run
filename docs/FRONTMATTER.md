# mdcode2run front-matter 配置（本仓库权威参考）

> 依据源码逐项核实（2026-11-04）：`front-matter.js`（读取层）、`fences.js`
> （`parseCodeExecFrontMatter`，code-exec 段解析）。键有增删先改代码，再同步本文件。
> 块级 fence 标注（`demo` / `file=` / `job`…）不属 front-matter，见 `../FENCE.md`。

## 0. 解析规则（front-matter.js）

- 配置三层的前言层：**fence meta（块级）> front-matter（本文档）> 引擎配置（秘密层）**。
- 查找顺序：`code-exec.<section>.<key>`（新，文档级默认）→ 顶层 `<key>`（旧写法，仍认）。
- 键名**大小写不敏感**（`find()` 归一比较）。
- 只解析缩进映射 + 标量：不碰列表 / 嵌套深层 / 含空格的长文本值
  （那些属于 title / tags 这类展示性元数据，不是配置）。
- **密码不在此列**——秘密只放引擎配置（宿主偏好），前言层无权读取。

## 1. `code-exec:` 段（文档级执行默认）

| 键 | 语言 | 值 | 说明 |
|---|---|---|---|
| `code-exec.java.JAVA_HOME` | java | JDK 根目录或 bin 目录 | 每次运行现取（换文档换 JDK） |
| `code-exec.java.class-path` | java | `;` 分隔字符串或数组 | `dir/*` 展开为该目录全部 jar；相对路径基于文档目录 |
| `code-exec.python.PYTHON_PATH` | python | 解释器路径 | 相对路径按 cwd 解析 |
| `code-exec.mysql.HOST` | mysql | 标量 | 连接覆盖；`PORT` / `USER` / `DATABASE` 同理 |
| `code-exec.mysql.PASSWORD` | — | **禁止** | 秘密只在引擎层（分享讲义的前提） |

段名（java / python / mysql…）即语言段；同一段内键大小写不敏感。

## 2. 顶层旧写法（仍认，优先级低于 `code-exec:` 段）

| 键 | 别名 | 说明 |
|---|---|---|
| `host` | `hostname` `ssh_host` `remote_host` | 远端主机（配合块内 `[user@host]$` 提示符或壳配置 MODE=remote） |
| `user` | `username` `ssh_user` `remote_user` | 远端用户名 |
| （其余顶层标量键） | — | **凭据表**：键=用户名、值=密码；`sudo` 自动改写 `sudo -S` 喂密码 |
| `JAVA_HOME` / `class-path` | — | java 旧顶层写法（`code-exec.java.*` 优先） |

## 3. 优先级链

```
java  JAVA_HOME : code-exec.java.JAVA_HOME → 顶层 JAVA_HOME → 引擎 java.JAVA_HOME → 环境变量 JAVA_HOME
java  class-path: code-exec.java.class-path → 顶层 class-path → 引擎 java.CLASS_PATH
python 解释器    : code-exec.python.PYTHON_PATH → 引擎 python.PYTHON_PATH
mysql 连接四键   : code-exec.mysql.* → 引擎 mysql.*（password 只在引擎层）
shell 目标       : 块内提示符 [user@host] > 顶层 host/user > 引擎 shell.HOST/USER
```
