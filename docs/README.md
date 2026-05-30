# Agent 架构设计参考

> 一份用于构建自有 Agent 项目的**架构设计参考文档**。

## 这份文档是什么

这是一份**原创的架构设计笔记**,系统整理了"Claude Code 式编码 agent"的核心设计思路,供本项目(Harness-Agent)日后构建时查找学习。

内容来源:
- 官方公开文档、官方开源的 Agent SDK、官方工程博客
- Agent 领域的**通用设计模式**
- 社区里**合法的分析/评论类**资料(架构博客、学术性系统分析、行为观测工具)

## 重要声明(请认真读)

- 本文档**不包含**任何来自泄露/反编译源码的逐字实现、变量名或真实 system prompt 原文。
- 2026 年 3 月曾发生 Claude Code 因 source map 打包失误导致的源码泄露事件,Anthropic 随后发出 DMCA 下架了大量重新分发该源码的仓库。**重新分发或直接参考那批专有源码存在版权风险**,本项目刻意避开。
- 这里的所有代码片段都是**示意性伪代码**,用于说明设计意图,不是任何产品的真实实现。
- 文档讲的是**思路与模式**(怎么想、为什么这样设计),而非"逐行抄"。这对构建自己的项目其实更有价值。

## 章节导航

文档按三层组织:**内核**(agent 的思想核心)→ **运行时**(让它跑起来、用起来)→ **生产化**(让它可靠、可扩展、可上线)。

### 内核(Core)

| 章节 | 主题 | 一句话 |
|---|---|---|
| [01 · Agent Loop](01-agent-loop.md) | 核心循环 | ReAct while 循环;循环易抄,harness 难;建模成状态机/异步生成器 |
| [02 · 工具设计](02-tool-design.md) | 工具层 | 正交工具、精确编辑、信息丰富的错误、deferred loading、并发分类 |
| [03 · 上下文管理](03-context-management.md) | 上下文/记忆 | 分级压缩、大输出落盘、文件化 memory、保护 prompt cache |
| [04 · 权限与安全](04-permissions-safety.md) | 安全模型 | deny-first 纵深防御、按可逆性分级、denial tracking、injection 防御 |
| [05 · 子 Agent 与提示词](05-subagents-and-prompts.md) | 编排/提示词 | 子 agent 隔离上下文、Skill vs agent、提示词驱动行为 |

### 运行时(Runtime)

| 章节 | 主题 | 一句话 |
|---|---|---|
| [06 · 模型交互层](06-model-interaction.md) | loop↔API 之间 | 流式、tool_use 解析、token 预算、重试退避、模型路由/回退 |
| [07 · 会话生命周期与持久化](07-session-lifecycle.md) | 状态/存档 | SessionState、JSONL transcript、checkpoint/resume、fork |
| [08 · 用户交互与 UX](08-user-interaction-ux.md) | 人机交互 | 流式渲染、中断、确认流+diff、plan 模式、克制的叙述 |

### 生产化(Production)

| 章节 | 主题 | 一句话 |
|---|---|---|
| [09 · 可扩展性](09-extensibility.md) | 扩展生态 | Hooks→Skills→Plugins→MCP 按成本分层、三个注入点 |
| [10 · 执行环境与沙箱](10-execution-environment.md) | 隔离机制 | 文件/网络边界、Bash 笼子、参数化防注入、隔离强度分层 |
| [11 · 可观测性、评估与验证](11-observability-eval.md) | 可靠性 | 结构化日志/成本追踪、eval 数据集/回归、改完跑 build/test |

## 五条最值得记住的总原则

1. **循环很简单,harness 很难。** Agent 的心脏是个朴素的 while 循环;真正的工程量在权限、上下文、工具路由、错误恢复这些横切关注点上。

2. **让模型做编排。** 不要写复杂状态机去"控制"模型——把工具给它、把结果喂回去,用它的推理当编排引擎。

3. **把上下文当稀缺资源。** 分级降解,由轻到重,最晚才动用破坏性手段;大输出落盘。

4. **默认从严。** Deny-first,按可逆性与影响范围分级;一切外部内容当不可信数据。

5. **提示词驱动,而非硬编码。** 行为/工具/安全规则写进 system prompt,可调、可审计;同一循环 + 不同提示词 = 不同 agent。

## 建议的下一步(动手)

读文档不如写一遍。推荐路径,由内核向外逐层加:
1. 用 ~80 行写一个最小 agent loop(Read / Edit / Bash 三个工具),验证 [01](01-agent-loop.md)。
2. 把模型调用换成流式 + tool_use 解析 + 重试,验证 [06](06-model-interaction.md)。
3. 加权限确认层 + diff 预览,验证 [04](04-permissions-safety.md) 与 [08](08-user-interaction-ux.md)。
4. 加大输出落盘 + 简单压缩,验证 [03](03-context-management.md)。
5. 加会话存档/恢复(JSONL transcript),验证 [07](07-session-lifecycle.md)。
6. 加子 agent 派生,验证 [05](05-subagents-and-prompts.md)。
7. 把 Bash 关进受控环境,验证 [10](10-execution-environment.md)。
8. 接一个 hook + 一个 MCP server,验证 [09](09-extensibility.md)。
9. 加结构化日志 + 几个 eval case + "改完跑 test",验证 [11](11-observability-eval.md)。

合法的一手学习资源:
- **官方 Claude Agent SDK**(完全开源,可逐行读):`claude-agent-sdk`(Python)/ `@anthropic-ai/claude-agent-sdk`(TS)
- **Anthropic Messages API + 工具调用文档**(设计理念一手来源)
- **行为观测类工具**(观察真实交互,不碰源码)
