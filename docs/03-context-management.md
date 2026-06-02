# 03 · 上下文管理(Context Management)

> 原创整理,基于公开信息与通用 agent 设计模式。代码为示意性伪代码。

## 核心理念:把上下文当作稀缺资源,分级降解

Context window 是有限且昂贵的资源。处理它的关键不是"一刀切截断",而是**graduated degradation(分级降解)**——准备好多种由轻到重的手段,按需逐级触发,尽量晚地动用"破坏性最强"的那一招。

社区分析里一句话点得很准:**"context management is harder than it looks"(上下文管理比看上去难得多)**,即使在大规模工程里也仍是未完全解决的问题。**手段的粒度(granularity)比拥有某个单一机制更重要。**

## 分级压缩:由便宜到昂贵

在每次模型调用前,按"成本最低优先"的顺序考虑这几层。只在前一层不够用时才升级到下一层:

| 层级 | 手段 | 特点 |
|---|---|---|
| 1 | **快速剪枝旧消息** | 最便宜,腾出 headroom,有损 |
| 2 | **针对大工具输出** | 把超大 tool result 落盘,上下文里只留摘要 + 引用 |
| 3 | **渐进压缩旧片段** | 压缩较早的对话段,保持近期上下文清晰 |
| 4 | **全量总结** | 到达 token 阈值时,把整段对话总结成摘要 |
| 5 | **紧急压缩** | API 因 payload 过大拒绝时触发,防止单条输出"变砖" |

第 5 层尤其关键:**一个超大的工具输出不应该能够直接"brick"掉整个会话**。把紧急压缩当成安全网。

### 大工具输出落盘(很实用的一招)

`Bash`/`Read` 等工具有时会吐出巨量文本。与其塞进上下文,不如:

```
1. 把完整输出写到磁盘(如 .agent/outputs/<id>.txt)
2. 上下文里只放:摘要 + 文件引用 + 提示"需要细节可读取此文件"
```

好处:上下文保持精简,同时模型仍可在需要时按需取回完整内容。这也对 prompt cache 友好(见下)。

## 内存(Memory):刻意用"文件化",不用向量库

一个值得借鉴的取舍:**memory 用基于文件的方式,而非 vector database**。

- **可检视(inspectable)**:就是人能读的文件,不是不透明的嵌入向量。
- **可版本控制(version-controllable)**:进 git,可 diff、可回溯。
- **选择方式**:相关 memory 文件靠 **LLM 扫描文件头/标题**来挑选,而不是靠 embedding 相似度。

这套思路的精神是:**让上下文与记忆对人透明、可调试**。调试一个 agent 的"它为什么记得/忘了某件事"时,可读的文件远比向量检索好排查。

### 当前 Light-Agent 的落地做法

在 Light-Agent 当前实现里,这个思路已经进一步具体化为三层:

- **transcript 证据层**:`~/.light-agent/memory/transcripts/<session-id>.jsonl`
- **Markdown 记忆卡**:`<workdir>/.agents/memory/project/*.md` 与 `~/.light-agent/memory/user/*.md`
- **SQLite 索引层**:`~/.light-agent/memory/index.sqlite`

其中:

- Markdown card 是长期真相源
- SQLite 负责 FTS 与访问统计,可随时重建
- core digest 是派生摘要文件,按 importance/trust/访问热度维持一个小而稳的常驻层
- 每轮只注入少量相关 memory block,避免把长期记忆直接塞满上下文
- procedural query 还会和 skills catalog 协同,让 agent 同时知道“以前怎么做过”和“现在有哪些能力能做”

## 分层指令:CLAUDE.md 式的层级

项目级指令放在一个**层级化的指令文件**体系里(如各级目录的 `CLAUDE.md`):

```
~/.../CLAUDE.md          (用户全局)
  project/CLAUDE.md       (项目级)
    project/sub/CLAUDE.md (子目录级,更具体)
```

越靠近具体工作目录的指令越具体、优先级语义越强。加载时按相关性选取,而非一股脑全塞进去。

## 与 Prompt Cache 的关系(成本工程)

上下文的稳定性直接影响 **prompt cache 命中率**,而缓存命中率直接影响成本和延迟。几条原则:

- **工具 schema 在会话开始时组装一次,之后保持稳定**——中途变动会让缓存前缀失效。
- **大工具结果落盘**,让缓存前缀保持完整。
- **feature flag 用 "sticky latch"**:会话中途切换模式不改动 system prompt,从而不破坏缓存。
- 留意所有可能让缓存失效的字段:system prompt、工具 schema、模型、headers 等。

这些优化单看不起眼,**在规模上会显著复利**。

## 设计要点清单

- [ ] 把上下文当稀缺资源,准备由轻到重的多级手段。
- [ ] 每次模型调用前按"最便宜优先"逐级触发压缩。
- [ ] 大工具输出落盘 + 摘要引用,别直接塞进上下文。
- [ ] 设紧急压缩兜底,防止单条超大输出拖垮会话。
- [ ] memory 用文件化方案:可读、可版本控制、靠 LLM 选取。
- [ ] 分层指令文件(CLAUDE.md 式),越近越具体。
- [ ] 保持 system prompt 与工具 schema 稳定,保护 prompt cache。

## 延伸阅读(本项目内)

- [01 · Agent Loop](01-agent-loop.md)
- [02 · 工具设计](02-tool-design.md)
- [05 · 子 Agent 与提示词](05-subagents-and-prompts.md)
- [12 · 原生记忆系统](12-memory-system.md)
