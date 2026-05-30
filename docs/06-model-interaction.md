# 06 · 模型交互层(Model Interaction Layer)

> 原创整理,基于公开信息与通用 agent 设计模式。代码为示意性伪代码。

这是夹在 [Agent Loop](01-agent-loop.md) 和底层 Messages API 之间的一层。Loop 章里"调用模型"只是一行 `model.create(...)`,但这一行背后藏着不少工程。

## 请求装配(Request Assembly)

每次调用模型,要把这些东西拼成一个请求:

```
system prompt  +  messages(对话历史)  +  tools(schema)  +  采样参数
```

要点:
- **顺序与稳定性影响缓存**。system prompt、tools schema 放在前缀且保持稳定,以保护 prompt cache(见 [03](03-context-management.md))。
- **采样参数**(temperature、max_tokens 等)按场景设定;需要确定性的步骤用低 temperature。
- **messages 在发送前**经过上下文管理层(可能已被压缩/落盘)。

## 流式输出(Streaming)

生产级 agent 几乎都用**流式**而非一次性返回:

- **降低感知延迟**:文字边生成边显示。
- **可提前调度工具**:`tool_use` block 一旦解析完整,可以不等整段响应结束就开始执行(见 [02](02-tool-design.md) 的流式执行)。
- **可中断**:用户可在生成中途叫停(见 [08](08-user-interaction-ux.md))。

流式响应是一串增量事件,需要一个**累加器**把分片重组成完整的 content block:

```python
def consume_stream(stream):
    blocks = {}  # index -> 正在累积的 block
    for event in stream:
        if event.type == "content_block_start":
            blocks[event.index] = init_block(event)
        elif event.type == "content_block_delta":
            apply_delta(blocks[event.index], event.delta)  # 文本/JSON 分片
        elif event.type == "content_block_stop":
            finalize(blocks[event.index])
        elif event.type == "message_stop":
            break
    return assemble(blocks)
```

## tool_use 解析(关键易错点)

工具调用的参数是**以 JSON 分片流式到达**的,要拼接完整再解析:

- 累积 `input_json_delta` 直到该 block 结束,再 `json.parse`。
- **解析失败要当作可恢复错误**:把"JSON 无效"作为信息丰富的错误回传给模型,让它重试,而不是直接崩(呼应 [02](02-tool-design.md) 的错误反馈原则)。
- 注意区分 `stop_reason`:`tool_use`(要调工具)vs `end_turn`(正常结束)vs `max_tokens`(被截断,需处理)。

## Token 预算(Token Budget)

主动管理 token,而不是等 API 报错:

- **调用前预估**:输入 token + 预留输出 token,与模型上限比较。
- **接近上限 → 触发压缩**(主动式,见 [03](03-context-management.md) 的分级压缩)。
- **超限被拒 → 紧急压缩后重试**(响应式,见 [01](01-agent-loop.md) 错误恢复)。
- 记录每轮 token 消耗,用于成本追踪(见 [11](11-observability-eval.md))。

## 重试与退避(Retry & Backoff)

模型 API 会有瞬时失败,需稳健重试:

| 错误类型 | 处理 |
|---|---|
| 429 限流 | 指数退避 + 抖动重试;尊重 `retry-after` |
| 5xx 服务端 | 指数退避重试,设最大次数 |
| 超时 | 重试;多次失败考虑回退模型 |
| 400 请求错误(如超长) | 不要盲目重试;先修复(压缩)再重试 |
| 上下文溢出 | 触发紧急压缩,而非单纯重试 |

```python
def call_with_retry(req, max_attempts=5):
    for attempt in range(max_attempts):
        try:
            return model.create(**req)
        except RateLimitError as e:
            sleep(backoff(attempt) + jitter())
        except OverloadedError:
            sleep(backoff(attempt) + jitter())
        except ContextOverflowError:
            req = emergency_compact(req)  # 修复而非干等
    return fallback_model_call(req)       # 多次失败 → 回退模型
```

## 模型路由与回退(Routing & Fallback)

- **路由**:不同任务用不同模型。重活/推理用强模型,轻量分类/总结用快而便宜的小模型(子 agent、压缩总结常用小模型)。
- **回退**:主模型不可用或持续失败时,降级到备用模型,保证会话不中断。
- **抽象掉 provider**:把模型调用包在一个接口后面,便于切换 provider / 版本。

## 设计要点清单

- [ ] 请求装配保持前缀稳定以保护缓存。
- [ ] 默认流式;用累加器重组 content block。
- [ ] tool_use 的 JSON 分片拼完再解析;解析失败当可恢复错误回传。
- [ ] 区分 stop_reason(tool_use / end_turn / max_tokens)。
- [ ] 主动管理 token 预算:调用前预估、接近上限即压缩。
- [ ] 稳健重试:按错误类型区别处理,带退避与抖动。
- [ ] 支持模型路由(按任务选模型)与回退(保证不中断)。
- [ ] 把模型调用抽象在接口后,解耦 provider/版本。

## 延伸阅读(本项目内)

- [01 · Agent Loop](01-agent-loop.md)
- [03 · 上下文管理](03-context-management.md)
- [11 · 可观测性、评估与验证](11-observability-eval.md)
