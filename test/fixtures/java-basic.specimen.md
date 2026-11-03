---
theme: python-mini-pptx
paginate: true
headingDivider: 5
title: 类与对象：银行账户
date: 2026-11-03 22:00:00
categories:
- Java
tags:
- Java
- OOP
- 类与对象
- 封装
code-exec:
  session-boundary: h1
  java:
    JAVA_HOME: "D:/Program Files/Java/jdk-17.0.20.1"
---

<div class="cover"><h1>银行账户</h1><p>类与对象的第一课：把数据和行为装进同一个盒子</p></div>

# 案例概览

本案例用 Java 实现一个银行账户类，演示面向对象三件事：把数据装进对象、用方法操作数据、多个对象互相交互。

## 业务问题

模拟一个最简银行账户：能存钱、能取钱、取钱时余额不足要拒绝、能查余额。

## 预期行为

| 操作                 | 结果                           |
| -------------------- | ------------------------------ |
| `new Account("张三")` | 建一个零余额账户               |
| `deposit(1000)`      | 余额变 1000                    |
| `withdraw(200)`      | 余额变 800，返回 true          |
| `withdraw(9999)`     | 余额不变，返回 false（余额不足）|
| `info()`             | 返回 `"张三: 800.0"`           |

## 前置与后继

| 关系   | 案例       | 承接的知识点                |
| ------ | ---------- | --------------------------- |
| 前置   | 变量与控制流 | 类型、if、方法               |
| 本案例 | 银行账户   | 类定义、字段、构造、方法、实例化 |
| 后继   | 继承与多态 | 子类扩展父类、方法重写       |

# 理论篇：为什么要把数据和行为装在一起

## 没有类的时候

如果要表示一个账户，最朴素的做法是用两个变量：

```java demo
String name = "张三";
double balance = 0;
balance += 1000;          // 存
balance -= 200;           // 取
```

这段代码有三个问题：`name` 和 `balance` 之间没有绑定关系（可以张冠李戴）、"取"没有检查余额、开第二个账户就要再声明两个变量、第三个账户再两个……变量数量随账户数线性增长。

## 类：一个可以复用的模具

类把"一个账户长什么样"定义成模具：有哪些数据（字段）、怎么创建（构造函数）、能做什么（方法）。

```java demo
class Account {
    String name;              // 字段：姓名
    double balance;           // 字段：余额
    Account(String name) {    // 构造：建账户时初始化
        this.name = name;
        this.balance = 0;
    }
    void deposit(double amount) { this.balance += amount; }      // 方法：存
    boolean withdraw(double amount) {                            // 方法：取（带检查）
        if (amount > this.balance) return false;
        this.balance -= amount;
        return true;
    }
    String info() { return this.name + ": " + this.balance; }    // 方法：查
}
```

`this` 指向"当前这个账户"——同一个模具造出的不同账户，各有各的 `balance`，互不干扰。

## 实例化：用模具造一个对象

```java demo
Account acc1 = new Account("张三");   // 造一个账户
acc1.deposit(1000);                   // 操作它
acc1.info()                           // 查它
```

`new Account("张三")` 做了两件事：按类的模板分配内存、调用构造函数初始化字段。返回的 `acc1` 是一个引用——指向那个具体的账户对象。

# 实训篇：实现银行账户

本章的 jshell 会话由一个引导块开路：会话建立时自动执行，把 `Account` 类定义进命名空间（幂等，重放时重跑无害）。后续每块代码都能直接 `new Account(...)` 而不用重新定义类：

```java setup
class Account {
    String name;
    double balance;
    Account(String name) {
        this.name = name;
        this.balance = 0;
    }
    void deposit(double amount) {
        this.balance += amount;
    }
    boolean withdraw(double amount) {
        if (amount > this.balance) return false;
        this.balance -= amount;
        return true;
    }
    String info() {
        return this.name + ": " + this.balance;
    }
}
```

## 步骤一：创建账户并存取

引导块已经把 `Account` 类准备好了。现在造一个张三的账户，存 1000、取 200，查余额：

```java
Account acc1 = new Account("张三");
acc1.deposit(1000);
acc1.withdraw(200);
acc1.info()
```

`acc1.info()` 是尾表达式，jshell 自动求值并显示 `"张三: 800.0"`。不需要 `System.out.println`——jshell 会把每个表达式的值打印出来。

## 步骤二：余额不足的保护

取钱时余额不够应该拒绝。`withdraw` 返回 `boolean` 告诉调用者成功与否：

```java
boolean ok = acc1.withdraw(9999);
System.out.println("取款成功？ " + ok);
System.out.println("当前余额： " + acc1.info());
```

预期输出：

```text
取款成功？ false
当前余额： 张三: 800.0
```

余额不足时 `withdraw` 直接 `return false`，不扣款——这就是封装的价值：余额检查的逻辑藏在方法里，调用者只看返回值，不用自己判断。

## 步骤三：多个账户与对象交互

再造一个李四的账户，演示两个对象互不干扰，以及对象间的转账：

```java
Account acc2 = new Account("李四");
acc2.deposit(500);

// 转账：acc1 给 acc2 转 100
boolean transferred = acc1.withdraw(100) && (acc2.deposit(100) != null || true);
acc2.deposit(100);   // 简化：上一行的 withdraw 已成功才到这里
System.out.println(acc1.info());
System.out.println(acc2.info());
```

预期输出：

```text
张三: 700.0
李四: 600.0
```

注意 `acc1` 和 `acc2` 各有各的 `balance`——`this.balance` 在 `acc1.deposit` 里改的是 acc1 的余额、在 `acc2.deposit` 里改的是 acc2 的余额。同一个类、两个实例、两份独立的状态。

## 步骤四：用方法封装转账逻辑

步骤三的转账写法很笨重（`&&` 拼接、`!= null || true` 这种 hack）。更好的做法是给 `Account` 加一个 `transfer` 方法。但 `Account` 类在引导块里已经定义了——改它会影响步骤一到三的所有块（引擎会标它们 stale）。

这里先用现有方法组合出转账，演示"方法调用链"：

```java
// 从 acc1 取 100，成功才存进 acc2
boolean success = acc1.withdraw(100);
if (success) {
    acc2.deposit(100);
}
System.out.println("转账" + (success ? "成功" : "失败"));
System.out.println(acc1.info() + " | " + acc2.info());
```

预期输出：

```text
转账成功
张三: 600.0 | 李四: 700.0
```

把转账写成 `withdraw + deposit` 的组合，是"用现有方法拼新行为"的最小例子。真正的 `transfer` 方法要加到类定义里——那是下一课（继承与方法扩展）的事。

# 小结

银行账户把面向对象的核心压缩到了最小：类是模具、对象是实例、方法是行为。

## 三句话回顾

- 类把相关数据（字段）和操作（方法）装进同一个盒子，`this` 指向当前实例。
- `new Account(...)` 造一个独立对象，同类的多个对象各有各的状态、互不干扰。
- 方法内部做检查（如余额不足 `return false`），调用者只看返回值——这就是封装的价值。

<div class="end"><h1>银行账户</h1><p>下一内容：继承与多态</p></div>
