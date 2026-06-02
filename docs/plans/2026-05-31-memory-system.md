# Light-Agent 原生记忆系统实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 Light-Agent 内实现一套原生内建、文件可追溯、可检索、可注入的记忆系统，先把项目记忆和用户偏好记牢，再逐步补自动提炼和长期演化。

**Architecture:** 以 Markdown 记忆卡为真相源，SQLite 只做索引和检索加速；L0 transcript 只存证据，不直接进 prompt。v1 先把“写入、查询、回溯、注入”跑通，再补自动提炼和冲突处理。和当前 skills 策略协同：流程型 query 同时看 memory 和 skills catalog，但不把整套记忆系统做成重图谱。

**Tech Stack:** Node 20, TypeScript, Markdown, SQLite CLI, Vitest.

---

## Scope Adjustment

这版相对先前草案做了收紧，避免首发过重：

- 先做 `project + user` 两个 scope。
- 先做 `memory card + transcript + SQLite index`。
- 先做 `search / write / update / forget / drill` 和 `/memory` 命令。
- 先做预算感知检索与注入。
- 自动提炼、冲突推理、core digest 作为第二阶段收尾，不抢首发。
- 不先上 embeddings、scene graph、外部服务。

---

### Task 1: Memory 基础骨架与配置

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/paths.ts`
- Create: `src/memory/index.ts`
- Modify: `src/config.ts`
- Test: `test/memory-paths.test.ts`
- Test: `test/config-memory.test.ts`

**Step 1: Write the failing tests**

```ts
// test/memory-paths.test.ts
it("resolves project and user memory roots predictably", () => { /* ... */ });
it("keeps transcript and cards in separate directories", () => { /* ... */ });
```

**Step 2: Run the focused tests**

Run: `npm test -- test/memory-paths.test.ts test/config-memory.test.ts -v`

Expected: fail because the new module and config flags do not exist yet.

**Step 3: Write the minimal implementation**

- 定义 `MemoryCard`, `MemoryDraft`, `MemorySearchHit`, `MemoryContextPacket`, `RawTurn`。
- 定义固定目录规则：
  - `<workdir>/.agents/memory/project/`
  - `~/.light-agent/memory/user/`
  - `~/.light-agent/memory/index.sqlite`
  - `~/.light-agent/memory/transcripts/`
- 在 `config.ts` 里补 memory 开关和预算相关配置，但先只读 env，不扩 profile schema。

**Step 4: Run the focused tests again**

Run: `npm test -- test/memory-paths.test.ts test/config-memory.test.ts -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/memory test/config-memory.test.ts test/memory-paths.test.ts src/config.ts
git commit -m "feat(memory): add memory config and path scaffold"
```

---

### Task 2: Transcript + Markdown 卡片 + SQLite 索引

**Files:**
- Create: `src/memory/transcript.ts`
- Create: `src/memory/store.ts`
- Create: `src/memory/sqlite.ts`
- Modify: `src/sessions.ts`
- Test: `test/memory-store.test.ts`

**Step 1: Write the failing tests**

```ts
it("appends transcript evidence without mutating history", () => { /* ... */ });
it("round-trips a memory card through markdown", () => { /* ... */ });
it("rebuilds sqlite index from markdown cards", () => { /* ... */ });
```

**Step 2: Run the focused tests**

Run: `npm test -- test/memory-store.test.ts -v`

Expected: fail because the store layer is missing.

**Step 3: Write the minimal implementation**

- transcript 只做 append-only JSONL。
- memory card 以 Markdown + frontmatter 落盘，Markdown 是真相源。
- SQLite 只存索引、FTS、排序分数、访问统计。
- `src/sessions.ts` 只保留会话本身，不把长期 memory 混进 session JSON。
- 证据链字段要能从 card 回到 transcript turn。

**Step 4: Run the focused tests again**

Run: `npm test -- test/memory-store.test.ts -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/memory src/sessions.ts test/memory-store.test.ts
git commit -m "feat(memory): add transcript and card storage"
```

---

### Task 3: 手动记忆工具与命令

**Files:**
- Create: `src/tools/memory.ts`
- Modify: `src/tools/registry.ts`
- Modify: `src/commands/builtins.ts`
- Test: `test/memory-tools.test.ts`
- Test: `test/memory-commands.test.ts`

**Step 1: Write the failing tests**

```ts
it("registers memory_search and memory_write in the default tool pool", () => { /* ... */ });
it("/memory lists current cards and stats", () => { /* ... */ });
it("/remember writes a card with the expected scope and kind", () => { /* ... */ });
```

**Step 2: Run the focused tests**

Run: `npm test -- test/memory-tools.test.ts test/memory-commands.test.ts -v`

Expected: fail because tools/commands are not registered yet.

**Step 3: Write the minimal implementation**

- 注册 `memory_search`、`memory_write`、`memory_update`、`memory_forget`、`memory_drill`。
- `/memory` 支持概览、list、search、show、rebuild、compact。
- `/remember` 走显式写入。
- `/forget` 只做 soft forget，不直接删除证据。
- 命令输出里明确区分“已加载元数据”和“实际注入上下文”。

**Step 4: Run the focused tests again**

Run: `npm test -- test/memory-tools.test.ts test/memory-commands.test.ts -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/tools/memory.ts src/tools/registry.ts src/commands/builtins.ts test/memory-tools.test.ts test/memory-commands.test.ts
git commit -m "feat(memory): add memory tools and commands"
```

---

### Task 4: 检索、注入与 skills 协同

**Files:**
- Create: `src/memory/retrieve.ts`
- Modify: `src/prompt.ts`
- Modify: `src/cli.ts`
- Modify: `src/ext/skills.ts`
- Test: `test/memory-retrieve.test.ts`
- Test: `test/prompt-memory.test.ts`

**Step 1: Write the failing tests**

```ts
it("returns top hits within the requested budget", () => { /* ... */ });
it("prefers project memories for project queries", () => { /* ... */ });
it("includes skills catalog for procedural queries", () => { /* ... */ });
```

**Step 2: Run the focused tests**

Run: `npm test -- test/memory-retrieve.test.ts test/prompt-memory.test.ts -v`

Expected: fail because retrieval and injection hooks are absent.

**Step 3: Write the minimal implementation**

- 每轮前先做 query 分类，再做 FTS + tag/entity + recency rerank。
- 只注入小量 top-k 结果，保留严格预算上限。
- project query 先 project，用户偏好 query 先 user。
- procedural/workflow query 同时看 memory 和 skills catalog。
- 记忆注入不要污染永久 history，只作为本轮 prompt 的一段结构化块。

**Step 4: Run the focused tests again**

Run: `npm test -- test/memory-retrieve.test.ts test/prompt-memory.test.ts -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/memory src/prompt.ts src/cli.ts src/ext/skills.ts test/memory-retrieve.test.ts test/prompt-memory.test.ts
git commit -m "feat(memory): add retrieval and prompt injection"
```

---

### Task 5: 自动提炼、冲突处理与回溯

**Files:**
- Create: `src/memory/extract.ts`
- Modify: `src/cli.ts`
- Modify: `src/commands/builtins.ts`
- Test: `test/memory-extract.test.ts`
- Test: `test/memory-lifecycle.test.ts`

**Step 1: Write the failing tests**

```ts
it("extracts only durable candidates from transcript evidence", () => { /* ... */ });
it("refreshes duplicates instead of creating noisy copies", () => { /* ... */ });
it("marks superseded and forgotten memories correctly", () => { /* ... */ });
```

**Step 2: Run the focused tests**

Run: `npm test -- test/memory-extract.test.ts test/memory-lifecycle.test.ts -v`

Expected: fail because extraction and lifecycle logic do not exist yet.

**Step 3: Write the minimal implementation**

- 先只允许稳定偏好、项目约定、流程决策、明确约束、可验证事实入库。
- 自动候选提炼只从 transcript 中挑 durable candidates。
- 去重策略只做 `insert / refresh / supersede / ignore` 四类。
- `forget` 走 soft forget，保留证据但默认不再返回。
- `memory_drill` 能回到对应 transcript 片段。

**Step 4: Run the focused tests again**

Run: `npm test -- test/memory-extract.test.ts test/memory-lifecycle.test.ts -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/memory src/cli.ts src/commands/builtins.ts test/memory-extract.test.ts test/memory-lifecycle.test.ts
git commit -m "feat(memory): add extraction and lifecycle handling"
```

---

### Task 6: 文档同步与整体验证

**Files:**
- Create: `docs/12-memory-system.md`
- Modify: `README.md`
- Modify: `AGENT.md`
- Modify: `docs/README.md`
- Modify: `docs/03-context-management.md`
- Test: `test/docs-memory.test.ts` (optional smoke)

**Step 1: Write the failing docs smoke test**

```ts
it("documents memory commands and the file-backed design", () => { /* ... */ });
```

**Step 2: Run the focused test**

Run: `npm test -- test/docs-memory.test.ts -v`

Expected: fail until the docs are updated.

**Step 3: Write the minimal documentation**

- README 写清楚 memory 能做什么、怎么开、怎么查。
- AGENT.md 写清楚 memory 的目录、命令、证据链。
- docs/README.md 加入 memory 章节入口。
- docs/03-context-management.md 补记忆分层和注入位置。
- 新增 `docs/12-memory-system.md` 作为完整设计说明。

**Step 4: Run the repo-wide checks**

Run: `npm run typecheck && npm test`

Expected: all green.

**Step 5: Commit**

```bash
git add docs README.md AGENT.md test/docs-memory.test.ts
git commit -m "docs(memory): add native memory system docs"
```

---

## Deferred Enhancements

以下内容先不进首发，但可以留作后续版本：

- embeddings 作为可选语义检索增强。
- scene / cluster / persona 这类更重的派生层。
- 更强的时间失效模型和多轮冲突解释。
- 跨项目的全局 memory 共享策略。
- 记忆自动压缩和冷热分层的可视化面板。

---

## Acceptance Criteria

- `npm run typecheck`
- `npm test`
- 手动可写、可查、可回溯。
- 项目记忆和用户记忆分层清楚。
- 记忆检索能和 skills 协同，但不会把 prompt 撑爆。
- 每个阶段完成后文档都同步更新。
