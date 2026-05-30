# 09 · 可扩展性(Extensibility:Hooks / Skills / Plugins / MCP)

> 原创整理,基于公开信息与通用 agent 设计模式。代码为示意性伪代码。

[02 · 工具设计](02-tool-design.md)里提过一句:给 agent 加能力的机制按成本分层。这一章把它展开——**可扩展性是 agent 的差异化重点**,当模型趋同,围绕模型的扩展生态才是护城河。

## 四种机制:按成本/侵入性分层

```
Hooks(零成本)  →  Skills(低)  →  Plugins(中)  →  MCP(高)
```

成本指 **token 开销 + 复杂度**。从低到高,能力也从"轻量定制"到"接入完整外部系统"。

| 机制 | 成本 | 本质 | 典型用途 |
|---|---|---|---|
| **Hooks** | 零 | 在生命周期节点跑确定性代码 | 自动格式化、拦截危险命令、注入上下文 |
| **Skills** | 低 | 注入当前上下文的能力包/指令 | 领域知识、专用工作流、提示词模板 |
| **Plugins** | 中 | 打包的功能扩展 | 一组工具 + 命令 + 配置 |
| **MCP** | 高 | 接入外部服务的标准协议 | 数据库、API、第三方系统 |

## 三个注入点

不论哪种机制,扩展都作用在这三个点之一:

```
1. 模型看到什么   —— 改变 system prompt / 可见的工具 schema / 注入的上下文
2. 模型能够到什么 —— 改变可达的工具/资源
3. 动作是否执行   —— 在执行闸门处拦截/改写/放行
```

理解这三个注入点,就能想清楚"我要的扩展该用哪种机制"。

## Hooks:零成本的确定性代码

Hook 是在**生命周期事件**触发时运行的你自己的代码(不消耗模型 token,因为是确定性的)。常见事件点:

```
on_session_start      会话开始(注入项目上下文)
before_tool_call      工具执行前(校验/改写输入,可阻断)
after_tool_call       工具执行后(格式化、记日志)
before_model_call     模型调用前
on_user_prompt        收到用户输入时
on_stop               agent 停止时
```

典型用途:
- **before_tool_call** 拦截危险命令(与 [04](04-permissions-safety.md) 的预执行 hook 是同一思路)。
- **after_tool_call** 自动跑 formatter/linter。
- **on_session_start** 注入项目约定。

因为是确定性的且零 token,Hooks 是"能用 hook 解决就别用模型"的首选。

## Skills:低成本的上下文注入

Skill 把领域知识 / 工作流 / 提示词模板**按需注入当前上下文**(见 [05](05-subagents-and-prompts.md) 的 Skill vs sub-agent)。特点:

- 共享当前上下文,成本低。
- 适合"教 agent 一套特定做法"(如某框架的最佳实践、某种文档格式)。
- 常配合**渐进披露**:先给简介,需要时再加载详细内容,省 token。

## Plugins:中等成本的打包扩展

Plugin 把一组相关能力打包分发:工具 + 命令 + hook + 配置。适合做可复用、可共享的功能模块。要点:

- 清晰的**安装/启用/禁用**生命周期。
- 与权限系统集成:插件带来的工具同样走 deny-first 与确认流(见 [04](04-permissions-safety.md))。

## MCP:高成本但强大的外部接入

**MCP(Model Context Protocol)**是接入外部系统的标准协议——数据库、内部 API、第三方 SaaS 等。它让 agent 不必为每个外部系统写定制集成。

要点:
- 一个 MCP server 可能暴露**很多工具(200+)**——所以几乎一定要配合 **deferred loading**(见 [02](02-tool-design.md)),否则 token 爆炸。
- MCP 工具是**外部来源**,其返回内容当**不可信数据**处理(injection 防御,见 [04](04-permissions-safety.md))。
- 成本最高(协议握手、schema 开销、网络),按需接入。

## 与安全/缓存的交叉约束

- **执行闸门统一**:无论能力来自 hook/skill/plugin/MCP,真正执行动作都要过同一套权限闸门(见 [04](04-permissions-safety.md))。别让某个扩展机制绕过安全层。
- **注意"预信任执行窗口"**:扩展不应在信任对话框出现之前就执行(见 [04](04-permissions-safety.md) 的已知弱点)。
- **缓存友好**:扩展若改动 system prompt / 工具 schema,会影响 prompt cache(见 [03](03-context-management.md));尽量在会话开始时定下来。

## 设计要点清单

- [ ] 按成本分层提供扩展:Hooks→Skills→Plugins→MCP。
- [ ] 想清楚扩展作用在哪个注入点(看到/够到/执行)。
- [ ] 能用确定性 Hook 解决的就别消耗模型 token。
- [ ] Skill 用渐进披露省 token。
- [ ] Plugin 有清晰的安装/启用生命周期,并入权限系统。
- [ ] MCP 必配 deferred loading;其返回当不可信数据。
- [ ] 所有扩展的动作统一过权限闸门,别绕过安全层。
- [ ] 留意扩展对 prompt cache 的影响。

## 延伸阅读(本项目内)

- [02 · 工具设计](02-tool-design.md)
- [04 · 权限与安全](04-permissions-safety.md)
- [05 · 子 Agent 与提示词](05-subagents-and-prompts.md)
- [10 · 执行环境与沙箱](10-execution-environment.md)
