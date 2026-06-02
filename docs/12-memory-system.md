# 12 · 原生记忆系统(Native Memory System)

## 目标

Light-Agent 的原生记忆系统要解决两件事:

1. 跨会话记住**项目约定、流程、限制、决策**
2. 跨会话记住**用户偏好与协作风格**

第一版坚持三个取向:

- **本地优先**
- **文件可追溯**
- **上下文友好**
- **检索可解释**

## 三层结构

### 1. Transcript Evidence

每个会话会把新增消息追加到:

`~/.light-agent/memory/transcripts/<session-id>.jsonl`

这是证据层。它负责回答“这条记忆从哪来”，不直接注入 prompt。

### 2. Memory Cards

长期记忆以 Markdown card 存放:

- project: `<workdir>/.agents/memory/project/*.md`
- user: `~/.light-agent/memory/user/*.md`

每张 card 带 frontmatter，包含:

- `scope`
- `kind`
- `summary`
- `status`
- `sourceSessionId`
- `sourceTurnRefs`

Markdown 是长期真相源，便于人读、diff、手工检查。

### 3. SQLite Index

`~/.light-agent/memory/index.sqlite`

SQLite 不是最终真相源，它做三件事:

- 检索加速
- FTS 查询
- 访问统计

索引丢了可以通过 `/memory rebuild` 从 Markdown 重建。

### 4. Core Digest

每个项目工作目录都会派生一个小型 digest:

`~/.light-agent/memory/digests/<hash>.md`

它不是新的真相源，只是从 active memory cards 里挑出最值得常驻的一小批内容。

当前 digest 会参考:

- `tier`
- `scope`
- `kind`
- `importance`
- `trust`
- `accessCount`
- `lastAccessedAt`

这意味着“经常被命中、最近还在用”的记忆，会更容易留在常驻摘要里。

## 写入路径

当前记忆写入有两类入口:

- 显式写入: `/remember`、`memory_write`
- 自动提炼: turn transcript 达到 cadence 后，提炼 durable candidate

第一版自动提炼很保守，只提这些内容:

- 用户偏好
- 项目约定
- 流程型经验
- 明确限制
- 稳定事实

当前提炼规则已经同时覆盖英文和常见中文表述，例如:

- “Prefer concise answers”
- “我希望回答尽量简洁”
- “Always run typecheck before tests”
- “这个项目必须先跑 typecheck 再跑测试”

临时任务状态、一次性聊天、大段工具输出不会直接入长期记忆。

## 检索与注入

每轮用户输入前，系统会:

1. 判断 query 更像 procedural / preference / factual / historical / constraint-aware
2. 先带上 core digest，再优先检索对应 scope 的 memory cards
3. procedural query 额外联动 skills catalog
4. 按预算只注入少量高价值结果

一旦某条 memory card 真正被检索到或被人工查看，系统会刷新:

- `accessCount`
- `lastAccessedAt`

这样检索热度会反过来影响后续的 digest 排序。

这里刻意不改 `updatedAt`，因为它表示内容变化时间，不表示“被看过一次”。

如果同一条 durable memory 在后续会话里再次被确认:

- 不会新建一堆重复卡片
- 会走 refresh
- 会合并新的 `sourceTurnRefs`

这样证据链会随着使用持续变厚，而不是只保留第一次写入时的来源。

当前诊断信息还会额外给出:

- `quality`
- `freshness`
- rerank `reasons`
- supersede / superseded-by 关系

这样一条记忆“为什么被选中”“为什么被压下去”“它和旧记忆是什么关系”，都可以直接检查。

注入格式是结构化的 `<memory_context>` block，不会写回永久 history。

## 命令与工具

Slash commands:

- `/memory`
- `/memory list`
- `/memory search <query>`
- `/memory show <id>`
- `/memory rebuild`
- `/memory compact`
- `/memory diagnose <query>`
- `/remember [project|user] <text>`
- `/forget <id>`

其中在 TTY 里:

- `/memory` 无参会先弹出动作选择
- `/memory show` 无参会直接让你选 memory card
- `/remember` 无参会先选 `project` 或 `user`
- `/forget` 无参会直接让你选要忘掉的 memory card

Model tools:

- `memory_search`
- `memory_write`
- `memory_update`
- `memory_forget`
- `memory_drill`

其中:

- `/memory compact` 用来重建并查看当前 core digest
- `/memory diagnose <query>` 用来解释一次 query 的 intent、preferred scope、候选 card 和相关 skills
- `/memory show <id>` 现在会补 evidence preview、访问统计和 supersede 关系概览
- `memory_drill` 会把 card 本体、关系链和 transcript evidence 一起返回

## 如何使用: 一个完整例子

先记住一句话:

- `/remember` 不是“往某一行后面追加文字”
- `/remember` 是“新建一条长期记忆”

### 1. 手动记住一条用户偏好

```bash
/remember user 回答尽量简洁，先给结论再解释
```

这表示:

- `user` 是用户级记忆
- 后面的整句话会被保存成一条长期记忆卡

### 2. 手动记住一条项目约定

```bash
/remember project 这个项目里先跑 typecheck，再跑 test
```

这表示:

- `project` 是当前项目的长期约定
- 之后只要任务和这个项目相关，系统就更容易把这条规则自动带进来

### 3. 之后它会怎么影响行为

如果后面你再问:

```text
帮我改一下这个仓库里的问题
```

系统会在每轮对话前自动检索相关记忆。

效果上通常会体现为:

- 回答更简洁
- 更倾向先给结论
- 在项目操作里主动先提 `typecheck`

### 4. user 和 project 的区别

```bash
/remember user 我喜欢回答有条理，但别太长
/remember project 这个仓库统一用 vitest
```

可以这样理解:

- `user` 管“怎么和你协作”
- `project` 管“这个仓库应该怎么做”

### 5. 自动提炼也会工作

不是只有 `/remember` 才能记住。

如果你在对话里多次明确说:

```text
我希望回答尽量简洁
这个项目必须先跑 typecheck 再跑测试
```

系统也可能把它自动提炼成长期记忆。

目前自动提炼已经支持:

- 英文规则
- 常见中文偏好 / 流程 / 约束表达

但这些通常不会被写入长期记忆:

- 临时任务状态
- 一次性闲聊
- “回头再说”
- 大段工具输出

### 6. 怎么看已经记住了什么

总览:

```bash
/memory
```

列表:

```bash
/memory list
```

搜索:

```bash
/memory search typecheck
```

### 7. `/memory show` 看什么

```bash
/memory show <id>
```

这个命令会展示:

- 这条记忆的基本信息
- 访问次数
- evidence preview
- 是否 supersede 了旧记忆
- 是否被新的记忆 supersede

它适合用来看“这条记忆现在长什么样”。

### 8. `/memory diagnose` 看什么

```bash
/memory diagnose 我该怎么跑这个项目的测试
```

这个命令会解释:

- intent
- preferred scope
- 候选记忆
- `quality`
- `freshness`
- rerank `reasons`
- supersede / superseded-by 关系
- 相关 skills

它适合排查:

- 为什么系统想起了这条记忆
- 为什么另一条没排上来
- 新旧规则之间有没有冲突

### 9. supersede 是什么

假设旧规则是:

```bash
/remember project 先跑 test，再跑 typecheck
```

后来规则变了:

```bash
/remember project 先跑 typecheck，再跑 test
```

系统后续可能形成这样的关系:

- 旧记忆变成 `superseded`
- 新记忆保持 `active`
- 新记忆 `supersedes` 旧记忆

这样就不会把两条互相冲突的规则同时当成当前事实。

### 10. evidence 是什么

evidence 就是“这条记忆来自哪句话、哪一轮会话”。

比如你说过:

```text
这个项目必须先跑 typecheck 再跑测试
```

系统会把这条原始发言保留成证据引用。

你可以通过:

- `/memory show <id>`
- `memory_drill`

来检查来源。

### 11. 重复说同一件事会怎样

如果你后面又明确确认了一次同样的规则，系统通常不会新建一堆重复卡。

更常见的是:

- 刷新已有记忆
- 合并新的 `sourceTurnRefs`
- 让证据链更厚

### 12. `updatedAt` 和 `lastAccessedAt` 的区别

系统现在刻意区分两种时间:

- `updatedAt`: 内容什么时候变了
- `lastAccessedAt`: 最近什么时候被检索或查看了

所以“被看过一次”不会等于“内容被修改过一次”。

### 13. core digest 是什么

```bash
/memory compact
```

这个命令会重建核心摘要层。

可以把它理解成:

- 从很多记忆里挑少量最值得常驻的内容
- 避免每轮都把全部记忆塞进上下文

它会参考:

- importance
- trust
- accessCount
- lastAccessedAt

### 14. 如果想让系统忘掉一条记忆

```bash
/forget <id>
```

这是软忘记。

效果是:

- 默认不再把它当有效记忆参与返回
- 但不会粗暴抹掉所有证据

### 15. 如果索引坏了

```bash
/memory rebuild
```

会从磁盘上的 Markdown memory cards 重新建立索引。

### 16. 你最常用的 6 条命令

```bash
/remember user ...
/remember project ...
/memory
/memory search <query>
/memory show <id>
/memory diagnose <query>
```

只用这几条，已经足够把整个记忆系统日常用起来。

## 当前边界

这一版还没有做:

- embeddings
- graph memory
- 更细的 memory 质量评估
- 更激进的自动演化

但“可写、可查、可回溯、可注入、可解释、会按使用热度自我调整”这条链路已经打通，足够作为后续增强的稳定底座。
