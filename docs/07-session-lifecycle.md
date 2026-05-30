# 07 · 会话生命周期与持久化(Session Lifecycle & Persistence)

> 原创整理,基于公开信息与通用 agent 设计模式。代码为示意性伪代码。

一个真实可用的 agent 不能"开一次就忘"。它需要能记录、保存、恢复会话。这一层把 [Agent Loop](01-agent-loop.md) 从"一次性脚本"变成"可持续的工作伙伴"。

## 会话状态(Session State)是什么

把"一次会话"抽象成一个可序列化的状态对象。典型字段:

```python
@dataclass
class SessionState:
    session_id: str
    messages: list            # 完整对话历史(或其压缩后形态)
    cwd: str                  # 工作目录
    permission_mode: str      # 当前信任级别(见 04)
    tool_config: dict         # 本会话的工具集快照
    model: str                # 当前/回退模型
    token_usage: dict         # 累计消耗(见 11)
    created_at / updated_at
    parent_session_id: str | None  # 若由 fork 而来
```

关键:**这个对象要能完整地序列化和反序列化**,会话才能存盘和恢复。

## Transcript 记录(逐事件日志)

除了"当前状态",还应保留一份**append-only 的事件流(transcript)**,记录每一步发生了什么:

```
user_message → model_response → tool_call → tool_result → model_response → ...
```

格式上 **JSONL(每行一个事件)**很合适:
- **追加写入**,不必重写整个文件。
- **可流式读取**,便于回放/调试。
- **天然适合可观测性**(见 [11](11-observability-eval.md))。

Transcript(发生过什么)和 SessionState(当前是什么)是互补的:前者用于审计/回放/调试,后者用于恢复执行。

## Checkpoint 与 Resume

让会话可以"存档读档":

- **Checkpoint**:在关键节点(每轮结束、压缩前、危险操作前)保存状态快照。
- **Resume**:从某个 checkpoint 重建 SessionState,继续跑 loop。
- 恢复时要**重建运行时上下文**:工作目录、工具集、模型等。

```python
def resume(session_id):
    state = store.load(session_id)
    restore_cwd(state.cwd)
    tools = rebuild_tools(state.tool_config)
    return agent_loop_from(state, tools)   # 从已有 messages 继续
```

## 一条重要安全约束:权限不随恢复而还原

呼应 [04 · 权限与安全](04-permissions-safety.md):**恢复会话时,权限模式应回到保守默认,而不是继承上次会话的"信任级别"。** 上次授予的自动执行权限不应跨会话自动生效——这避免"陈旧授权"被误用。

## Fork / 分支会话

有时想从某个历史点"分叉"出一条新路径(试不同方案、并行探索):

- 复制到某 checkpoint 为止的状态,生成新的 `session_id`,记录 `parent_session_id`。
- 各分支独立演进,互不污染。
- 这与子 agent(见 [05](05-subagents-and-prompts.md))不同:fork 是**同一主线的时间分叉**,子 agent 是**隔离的子任务上下文**。

## 与压缩的关系(别丢了原始记录)

[03 · 上下文管理](03-context-management.md)里的压缩会改写/丢弃 messages 以省 token。但持久化层应当:

- **压缩的是"喂给模型的工作上下文"**,不是 transcript。
- **transcript 保留完整原始记录**,即使工作上下文已被压缩。
- 这样既省 token,又不丢失审计与回放能力。落盘的大工具输出也归档在此。

## 存储位置

- 会话数据放在项目本地的隐藏目录(如 `.agent/sessions/<id>/`),便于检视与清理。
- 与 [03](03-context-management.md) 的"文件化 memory"思路一致:**可读、可版本控制、可调试**。
- 注意:transcript 里可能含敏感信息(命令输出、文件内容),存储与清理策略要考虑隐私。

## 设计要点清单

- [ ] 把会话抽象成可序列化的 SessionState。
- [ ] 用 append-only 的 JSONL transcript 记录逐事件历史。
- [ ] 区分 transcript(发生过什么)与 state(当前是什么)。
- [ ] 在关键节点 checkpoint;支持从 checkpoint resume 并重建运行时。
- [ ] 恢复时权限回到保守默认,不继承上次信任级别。
- [ ] 支持 fork;与子 agent 区分清楚。
- [ ] 压缩工作上下文但保留完整 transcript。
- [ ] 本地化存储,可读可版本控制;注意敏感信息。

## 延伸阅读(本项目内)

- [01 · Agent Loop](01-agent-loop.md)
- [03 · 上下文管理](03-context-management.md)
- [04 · 权限与安全](04-permissions-safety.md)
- [11 · 可观测性、评估与验证](11-observability-eval.md)
