# 01 · Agent Loop(核心循环)

> 本文档为原创整理,基于公开信息(官方文档、Agent SDK、工程博客)与 agent 领域通用设计模式。
> 不包含任何来自泄露/反编译源码的逐字实现。所有代码均为示意性伪代码,用于说明设计意图。

## 一句话核心

整个 agent 的本质是一个循环:**把对话历史 + 可用工具发给模型 → 模型决定调工具还是给最终答复 → 执行工具、把结果塞回对话 → 再发给模型 → 直到模型不再调工具**。

最反直觉、也最重要的一点:**不要写复杂的状态机或编排引擎去"控制"模型做什么**。编排靠模型自己的推理。你只负责忠实地执行工具、把结果喂回去。社区分析里有个很有意思的数据点——决策逻辑本身只占代码库很小一部分(约 1.6%),其余绝大多数都是围绕循环的"脚手架"(权限、上下文、工具路由、错误恢复)。**循环很容易抄,难的是周围这层 harness。**

## 最小骨架

```python
def agent_loop(user_input, tools, system_prompt):
    messages = [{"role": "user", "content": user_input}]
    while True:
        response = model.create(
            system=system_prompt,
            messages=messages,
            tools=tools,
        )
        messages.append({"role": "assistant", "content": response.content})

        tool_calls = [b for b in response.content if b.type == "tool_use"]
        if not tool_calls:
            break  # 模型不再调工具 → 任务结束

        results = []
        for call in tool_calls:
            output = execute_tool(call.name, call.input)
            results.append({
                "type": "tool_result",
                "tool_use_id": call.id,
                "content": output,
            })
        messages.append({"role": "user", "content": results})
    return response
```

这就是 ReAct 模式的 while 循环。能跑通这 30 行,你就理解了 agent 的内核。

## 工程化:把循环建模成"状态机 / 异步生成器"

最小骨架适合理解,但生产级实现通常把循环写成一个 **async generator(异步生成器)**,在循环里设置多个 **yield point**,把控制权交出去。这样做的收益:

- **每一轮变成离散、可测试的状态转移**,而非一团黑盒。
- 可以**暂停 / 恢复 / 序列化**会话状态。
- 可以处理**轮次中途的错误**。
- 压缩(compaction)、权限检查、预算追踪等横切关注点,可以作为**正式的阶段(stage)**插入,而不是事后硬塞的回调。

一个直观的"单轮"阶段划分:

```
gather_context  →  call_model  →  dispatch_tools  →  check_permissions  →  execute  →  (loop)
```

关键心智模型:**模型调用只是众多阶段中的一个**。真正的工作在编排里。

一个值得借鉴的细节:**一个循环服务所有入口**(CLI / SDK / IDE 共用同一套 loop)。不要给每个前端写一套 agent 逻辑。

## 停止条件(必须显式)

循环必须有明确的退出条件,否则会失控。常见的几个:

| 停止条件 | 含义 |
|---|---|
| 无工具调用 | 模型给出最终答复,任务完成(最常见的正常退出) |
| 达到最大轮次 | 防止无限循环 / 失控,硬上限 |
| 上下文溢出 | token 超限且无法继续压缩 |
| 用户中断 | 用户主动叫停 |
| 致命错误 | 不可恢复的异常 |

## 错误恢复(harness 的硬骨头)

把恢复能力**内建在循环里**,而不是让一次失败就让整个会话"变砖":

- **Token 升级重试**:遇到瞬时/限流错误时带退避地重试。
- **响应式压缩(reactive compaction)**:当 API 因 payload 过大而拒绝时,触发紧急压缩后重试,避免单个超大工具输出直接拖垮整个会话。
- **回退模型(fallback model)**:主模型不可用时降级到备用模型。

## 设计要点清单(动手时对照)

- [ ] 循环本身保持简单;复杂度放在工具和 harness 里。
- [ ] 用 async generator + 多 yield point,让每轮可测试、可暂停。
- [ ] 模型调用只是一个 stage,不要让它和编排逻辑纠缠。
- [ ] 显式列出所有停止条件,尤其是最大轮次硬上限。
- [ ] 错误恢复内建:重试、响应式压缩、回退模型。
- [ ] 一套 loop 服务所有入口。

## 延伸阅读(本项目内)

- [02 · 工具设计](02-tool-design.md)
- [03 · 上下文管理](03-context-management.md)
- [04 · 权限与安全](04-permissions-safety.md)
- [05 · 子 Agent 与提示词](05-subagents-and-prompts.md)
