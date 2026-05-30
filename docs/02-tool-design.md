# 02 · 工具设计(Tool Design)

> 原创整理,基于公开信息与通用 agent 设计模式。代码为示意性伪代码。

## 设计哲学

工具是 agent 真正"动手"的地方。好的工具集应当**正交**——每个工具职责单一,组合起来覆盖所有场景,不重叠、不冗余。一个典型的核心工具集:

| 工具 | 职责 |
|---|---|
| Read | 读文件(支持分页/偏移) |
| Write | 写新文件 / 整体覆盖 |
| Edit | 精确字符串替换式编辑 |
| Glob | 按文件名模式查找文件 |
| Grep | 按内容搜索 |
| Bash | 执行 shell 命令 |
| Agent | 派生子 agent 处理独立子任务 |
| Todo | 任务规划与进度追踪 |

## 三条核心原则

### 1. 编辑用"精确字符串替换",不要用行号

`Edit` 工具的设计要点:让模型提供 `old_string` 和 `new_string`,做精确匹配替换。**不要用行号定位**——行号在文件变化后极易错位,而精确字符串匹配天然抗漂移。

为保证安全,通常要求 `old_string` 在文件中**唯一**;不唯一时要么报错要求更多上下文,要么提供"替换全部"的显式选项。

### 2. 工具失败要返回"信息丰富的错误"

模型靠工具的返回来自我纠错。失败时**不要只返回 "error"**,要返回足够模型理解并修正的信息:

```python
# 反例
return "Error"

# 正例
return ("Edit failed: old_string not found in src/app.py. "
        "The file may have changed. Re-read the file and retry "
        "with an exact substring including surrounding context.")
```

把错误当成给模型的"反馈通道",而不是单纯的失败信号。

### 3. 优先专用工具,而非让模型拼裸 shell

能用专用工具(Read/Edit/Grep)就别让模型用 `cat`/`sed`/`grep`。专用工具:
- **可控**:参数 schema 明确,行为可预测。
- **可审计**:对用户透明,易于权限管控。
- **可拦截**:可以在执行前做权限检查、输入改写。

## 工具池的组装(Tool Pool Assembly)

工具集不是写死的常量,而是每次会话开始时**动态组装**出来的。典型流程:

```
enumerate(枚举所有候选)
  → mode_filter(按当前模式过滤,如 plan 模式禁写)
  → deny_prefilter(按 deny 规则预过滤)
  → mcp_integration(并入 MCP 提供的外部工具)
  → dedup(去重)
```

## Deferred Loading(延迟加载)——工具多了的必备模式

当连接的工具很多(MCP server 可能暴露 200+ 个工具),**每次调用都把所有工具 schema 发给模型会浪费大量 token**,还可能干扰模型选择。

解决模式叫 **deferred loading / 按需加载**:

1. 大部分工具默认**隐藏**在一个开关后面,不进入初始 schema。
2. 模型通过一个**元工具(meta search tool)**做模糊匹配,描述它想要什么能力。
3. 系统只把**匹配到的少数工具 schema** 按需注入。

这样可用能力从"几个核心工具"扩展到"几百个",却没有前期 token 成本。经验法则:**当工具超过约 20 个,deferred loading 基本是必需的**。

## 工具执行:并发 vs 互斥

为降低延迟,可以对工具调用并行化,但要区分:

- **并发安全(concurrent-safe)**:只读、无副作用,如 Read / Grep / Glob → 可并行执行。
- **互斥(exclusive)**:有副作用、会改状态,如 Edit / Write / Bash → 串行执行,避免竞态。

一个进阶做法是**流式执行**:工具调用一边到达一边开始跑,进一步降延迟;退化情况下回落到"并发/互斥分类"策略。

## 可扩展性:按成本分层

给 agent 加能力有多种机制,按"成本/侵入性"从低到高分层(成本指 token 与复杂度):

```
Hooks(零成本)  →  Skills(低)  →  Plugins(中)  →  MCP(高)
```

注入发生在三个点:**模型看到什么(schema)**、**模型能够到什么(可达性)**、**动作是否真的执行(执行闸门)**。

## 设计要点清单

- [ ] 工具正交,职责单一,组合覆盖全场景。
- [ ] Edit 用精确字符串替换,不用行号;要求 old_string 唯一。
- [ ] 失败返回信息丰富的错误,作为模型的自纠反馈通道。
- [ ] 优先专用工具,而非裸 shell。
- [ ] 工具池动态组装(枚举→过滤→MCP→去重)。
- [ ] 工具 > 20 个时上 deferred loading + 元搜索工具。
- [ ] 区分并发安全/互斥工具,只读并行、有副作用串行。

## 延伸阅读(本项目内)

- [01 · Agent Loop](01-agent-loop.md)
- [03 · 上下文管理](03-context-management.md)
- [04 · 权限与安全](04-permissions-safety.md)
