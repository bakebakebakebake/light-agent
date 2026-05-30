# AGENT.md — Harness-Agent 项目交接文档

> 本文件用于**跨会话交接**:把项目背景、架构、进度、规划与开发约定集中记录,
> 确保换会话后不丢失上下文。最后更新:2026-05-31。

---

## 1. 项目概览

- **名称**:`harness-agent`(`package.json` version `0.1.0`,private)。
- **定位**:一个**最小化的命令行编码 Agent**(Claude Code 式),完全依据本仓库
  `docs/` 下的架构设计参考(01–11 章)从零实现。
- **入口**:`src/cli.ts`(交互式 REPL);构建后 `bin: harness-agent → dist/cli.js`。
- **运行形态**:终端 TUI——流式渲染、工具调用、权限确认、会话存档/恢复、
  斜杠命令、`@` 文件补全、`!` shell 直通、plan/allowAll 等权限模式。
- **语言**:TypeScript(ESM,`"type": "module"`),Node ≥ 20。

### 当前健康状态(交接时)
- ✅ **274 个测试全部通过**,跨 **28 个测试文件**(`npm test`)。
- ✅ **`tsc --noEmit` 类型检查干净**(`npm run typecheck`)。
- ⚠️ **Git 仓库尚无任何 commit**:`git log` 为空,所有文件都是 *untracked*
  状态。迁移后若要保存进度,需要先 `git add` + 首次提交(注意 `.env` 已被
  `.gitignore` 忽略,**不要**提交密钥)。

---

## 2. 快速上手

```bash
npm install            # 安装依赖
cp .env.example .env   # 配置凭证(见下方"配置与存储")
npm run dev            # tsx 直接跑 src/cli.ts(开发)
npm run build          # tsc -p tsconfig.build.json → dist/
npm run typecheck      # tsc --noEmit,改完代码必跑
npm test               # vitest run,改完代码必跑
npm run test:watch     # vitest 监视模式
```

改完代码的验证铁律:**先 `npm run typecheck` 再 `npm test`**,两者都绿才算完成。

---

## 3. 架构总览

设计思路全部源自 `docs/01–11`(中文架构参考)。核心理念:**循环简单,harness 难**;
**让模型做编排**;**上下文是稀缺资源**;**默认从严**;**提示词驱动而非硬编码**。

### 目录结构(`src/`)
```
cli.ts                 # 交互式 REPL 主入口:读行→命令/shell/turn→渲染
config.ts              # Config 解析:.env 加载、provider 选择、thinking/ctx 覆盖
onboarding.ts          # 首次运行向导(无凭证时引导配置,保存为 profile)
profiles.ts            # 全局 profile 存储(~/.harness-agent/profiles.json)
sessions.ts            # 会话存档/恢复(~/.harness-agent/sessions/<id>.json)
prompt.ts              # system prompt 组装

model/                 # 模型交互层(loop ↔ API)
  types.ts             #   ModelProvider/ModelRequest/ModelEvent/Usage/ThinkingDepth
  anthropic.ts         #   Anthropic Messages API 适配器(流式)
  openai.ts            #   OpenAI 兼容适配器(OpenRouter/DeepSeek/Kimi/Ollama…)
  index.ts             #   按 config.provider 选择适配器
  models.ts            #   模型元数据表
  contextWindow.ts     #   模型→上下文窗口大小(可被 #11 覆盖)

loop/                  # Agent 核心循环
  agentLoop.ts         #   runAgentLoop():async generator,yield LoopEvent
  compact.ts           #   上下文分级压缩(#1:阈值自动 + /compact)
  types.ts             #   LoopEvent / PendingToolCall / LoopState

tools/                 # 正交工具层(每个工具声明 riskLevel + concurrency)
  types.ts             #   Tool / ToolContext / ToolResult / ActionPreview
  read.ts ls.ts grep.ts edit.ts write.ts bash.ts
  registry.ts          #   工具注册表
                       #   注:read.ts 导出 resolveInWorkdir()——唯一的路径
                       #   confinement 边界(#9 allowOutside 在此放行)

permissions/           # 权限与安全(deny-first 纵深防御)
  policy.ts            #   PermissionMode(default/plan/acceptEdits/allowAll)+ 降级
  confirm.ts           #   确认流 + 风险分级 + denial tracking

ext/                   # 可扩展性(Skills / 自定义命令 / 文件搜索)
  skills.ts commands.ts paths.ts fileSearch.ts

commands/              # 斜杠命令
  registry.ts builtins.ts

ui/                    # 终端 UX(零依赖 ANSI)
  cli 渲染、输入、主题、frame、状态行 等(见下)
util/                  # git.ts(分支/缓存/diff)、shell.ts(进程/shell 执行引擎)
```

### 核心数据流
1. `cli.ts` 启动 → `resolveConfig()` 解析 profile/env;无凭证则进 `onboarding`。
2. REPL 读一行输入:
   - `/` 开头 → `commands.dispatch()`(斜杠命令)。
   - `!` 开头 → `runShellCommand()`,经 `util/shell.ts` 的 `runShell` 直接跑用户
     shell,**绕过模型**,输出只回显、不进历史(#5)。
   - 其余 → 作为一个 turn 交给 `runAgentLoop()`。
3. `runAgentLoop()`(async generator)按 ReAct 循环:调 `provider.stream()` →
   累积 `ModelEvent`(text/reasoning/tool_use 分片)→ 解析出 tool 调用 →
   经 `PermissionGate` 确认 → `tool.execute(input, ctx)` → 结果喂回模型 → 重复,
   直到 `end_turn` 或触达 `maxTurns`。每步 yield 一个 `LoopEvent`。
4. UI 渲染层消费 `LoopEvent` 流;每个 turn 结束 `state.save()` 存档,并按阈值
   触发 `maybeAutoCompact()`(#1)。

### 关键抽象(接口签名速查)
- **ModelProvider**(`model/types.ts`):`stream(req: ModelRequest): AsyncIterable<ModelEvent>`
  ——循环只认这一个接口,换 provider 纯靠 config。
- **ModelEvent**:`text_delta | reasoning_delta | tool_use_start | tool_input_delta
  | tool_use_stop | message_stop{stopReason,usage} | error`。
- **LoopEvent**(`loop/types.ts`):`turn_start | text_delta | reasoning | tool_call
  | tool_result{…,details?} | usage | done | error`。
- **Tool**(`tools/types.ts`):`{ name, description, inputSchema, riskLevel,
  concurrency, execute(input, ctx), describeAction?() }`。
- **ToolContext**:`{ workdir, signal?, allowOutsideWorkdir? }`
  ——`allowOutsideWorkdir` 仅在 `allowAll` 模式置真(#9)。
- **PermissionMode**:`default | plan | acceptEdits | allowAll`;`policy.ts` 还有
  denial-threshold 降级(默认 2 次拒绝后,medium 风险也要确认)。

---

## 4. 配置与存储

### 凭证 / Provider(`.env`,见 `.env.example`)
- `HARNESS_PROVIDER=anthropic`(默认)或 `openai`。
- **anthropic**:`ANTHROPIC_API_KEY` 必填;`ANTHROPIC_BASE_URL` 可指向中转/代理;
  默认模型 `claude-sonnet-4-5-20250929`。
- **openai 兼容**:`OPENAI_API_KEY` + `OPENAI_BASE_URL` + `HARNESS_MODEL`(必填,
  因为跨服务无合理默认)。支持 OpenRouter/DeepSeek/Kimi/Qwen/Zhipu/本地 Ollama/vLLM。
- 其它可选 env:`HARNESS_MODEL`、`HARNESS_THINKING`(off/low/medium/high)、
  `HARNESS_CONTEXT_WINDOW`(如 `128k`,#11 覆盖内置窗口表)、`HARNESS_PROFILE`
  (单次切换 profile)、`HARNESS_HOME`(覆盖存储根目录)。

### 持久化位置(默认 `~/.harness-agent/`,可被 `HARNESS_HOME` 覆盖)
- `profiles.json` — 全局多 profile 存储(`/profile`、`/profiles` 命令管理)。
- `sessions/<id>.json` — 每个会话一份存档(`/resume`、`/rewind` 用)。
- `.env` 已被 `.gitignore` 忽略——**交接/提交时务必不要提交密钥**。

---

## 5. 已实现功能

### 工具(`src/tools/`)
`read` · `ls` · `grep` · `edit` · `write` · `bash`。每个工具声明 `riskLevel`
(low/medium/high)与 `concurrency`(concurrent/exclusive)。所有文件系统工具经
`resolveInWorkdir()` 做 workdir 限制(唯一的 confinement 边界)。

### 斜杠命令(`src/commands/builtins.ts`,共 18 个)
`/help` `/clear` `/exit` `/keys` `/usage` `/compact` `/diff` `/config` `/mode`
`/model` `/thinking` `/profile` `/profiles` `/rename` `/reload` `/resume`
`/rewind` `/skill`。

### 输入与交互(UI)
- `/` 命令菜单(↑↓ 选择)、`@` 文件补全菜单、`!` shell 直通。
- 多行输入(Alt-Enter 或行尾 `\`)、历史(↑↓)、Ctrl-A/E/K/U/W/L 等行编辑。
- 流式渲染 + markdown + 工具调用行 + spinner;确认流带 diff 预览。

### 权限模式
`default`(按风险分级)/ `plan`(只读)/ `acceptEdits`(自动批准编辑)/
`allowAll`(全批准 + 解除 workdir 沙箱,见 #9)。带 denial-tracking 降级。

### UI 模块速查(`src/ui/`)
- `lineEditor.ts` — raw-mode 行编辑器(光标记账、菜单、frame、seed、双 Ctrl-C)。
  **本文件光标定位逻辑很微妙,改动需谨慎并跑 `lineEditor.test.ts`。**
- `keys.ts` — 唯一的 stdin 消费者(`emitKeypressEvents` + raw mode + 括号粘贴)。
- `input.ts` — `LineReader`:`ask(prompt, seed?)`、`exitRequested`、pick/secret。
- `frame.ts` — 输入框 box 的纯函数(`inputBorderTone`/`frameInnerWidth`/`frameInput`)。
- `status.ts` — `statusLine`(prompt 上方一行)、`workdirLine`(frame 下方页脚)。
- `theme.ts` — 零依赖 ANSI 颜色 + box + `visibleWidth`(CJK 宽字符)+ symbols。
- `render.ts` `transcript.ts` `markdown.ts` `diff.ts` `toolLine.ts` `spinner.ts`
  `menu.ts` `format.ts` `mascot.ts`。

### 扩展性(`src/ext/`)
- `skills.ts` — 加载 `SKILL.md`(带 frontmatter),`/skill` 渐进式注入上下文。
- `commands.ts` — 加载自定义斜杠命令(模板),`/reload` 热重载。
- `fileSearch.ts` — `@` 菜单的 workdir 文件排序搜索(exact>prefix>substring>
  subsequence,跳过 `node_modules`)。
- `paths.ts` — 扩展根目录解析(项目级 + `~/.harness-agent`)。

---

## 6. 功能开发历史(编号特性)

本轮迭代按 9 个 Phase 实现了一批编号特性(代码注释里用 `#1`–`#11` 引用),全部完成:

| 编号 | 特性 | 关键文件 | 测试 |
|---|---|---|---|
| #11 | 上下文窗口精度 + profile 覆盖 | `config.ts` `model/contextWindow.ts` | `contextWindow.test.ts` |
| #1 | 上下文压缩:阈值自动 + `/compact` | `loop/compact.ts` `cli.ts` | `compact.test.ts` |
| #6 #2 | 命令显示 + `/diff` 命令与内联 diff | `commands/builtins.ts` `ui/diff.ts` | `diff.test.ts` |
| #4 | `@` 文件搜索菜单 | `ext/fileSearch.ts` `ui/lineEditor.ts` | `fileSearch.test.ts` |
| #5 | `!` shell 模式 | `util/shell.ts` `cli.ts` | `shell.test.ts` |
| #7 | Ctrl-C:双击退出 + 中断回填输入 | `ui/lineEditor.ts` `ui/input.ts` `cli.ts` | `lineEditor.test.ts` |
| #8 | 输入框 box 边框(按模式着色) | `ui/frame.ts` `ui/lineEditor.ts` | `frame.test.ts` |
| #10 | workdir + git 分支页脚 | `util/git.ts` `ui/status.ts` | `workdirLine.test.ts` |
| #9 | `allowAll` 解除 workdir 沙箱 | `tools/read.ts`(`resolveInWorkdir`)`loop/agentLoop.ts` | `allowOutside.test.ts` |

### 各特性实现要点(给接手者)
- **#5 shell 引擎**:`util/shell.ts` 抽出两个函数——`runProcess`(argv + `shell:false`,
  给 bash 工具用,防注入)与 `runShell`(原始命令行 + shell,给用户 `!` 直通用)。
  用户 `!` 输入信任级别等同其自己的终端;输出只回显、**不进模型历史**。
- **#7 Ctrl-C**:空 prompt 上 1 秒内双击 Ctrl-C 退出(单击给暗示提示);turn 中途
  Ctrl-C 中断后,把被打断的问题通过 `seed` 回填到 prompt 供编辑重发。
  `LineReader.exitRequested` 标志 + `runEditor` 的 `{kind:"exit"}` 结果。
- **#8 输入框**:边框着色规则——`!` 开头黄色(shell)> plan 模式青色 > 默认灰色;
  `/` 菜单渲染在框**下方**;光标行 +1(顶边框)、列 +2(`│ ` 左边框)。
  纯函数在 `ui/frame.ts`,便于单测。
- **#9 解除沙箱**:`resolveInWorkdir(workdir, path, allowOutside?)` 在 `allowOutside`
  为真时跳过逃逸检查。**这是文件系统 confinement 的唯一边界**,所有 fs 工具
  (read/ls/grep/edit×2/write×2)都已传入 `ctx.allowOutsideWorkdir`;只有
  `state.mode === "allowAll"` 时 `cli.ts` 才置真。改动此处务必跑 `allowOutside.test.ts`。
- **#10 分支页脚**:`gitBranchCached`(5 秒 TTL,避免每次重绘都 spawn git);
  `workdirLine` 作为 frame 下方底行渲染(workdir 暗色 + 分支青色 + `⎇` 字形)。

---

## 7. 尚未实现 / 后续规划

`docs/` 参考了完整架构,但当前实现刻意保持最小。以下为**有文档、尚未落地**的方向,
按建议优先级排列(接手者可据此继续):

1. **子 Agent 派生(docs/05)**:目前没有 subagent / spawn 机制。可加一个
   "派生隔离上下文的子 agent"工具,用于并行研究、保护主上下文窗口。
2. **可观测性 / 评估(docs/11)**:暂无结构化日志、成本追踪、eval 数据集。
   建议加:每次 turn 的结构化 JSONL 日志、token/费用累计、几个回归 eval case。
3. **MCP / Hooks(docs/09)**:`ext/` 已有 Skills + 自定义命令两个注入点;尚缺
   Hooks(事件钩子)与 MCP server 接入。文档把扩展按成本分层
   Hooks→Skills→Plugins→MCP,可按此顺序补。
4. **Bash 沙箱强化(docs/10)**:`util/shell.ts` 已有超时 + argv 防注入;尚无
   网络/文件系统层面的真实隔离笼子,可按 docs/10 的"隔离强度分层"加。
5. **会话 fork(docs/07)**:`/resume`、`/rewind` 已有;`fork`(从某 checkpoint
   分叉出新会话)尚未实现。
6. **更细的上下文分级压缩(docs/03)**:目前是阈值触发的整体压缩;可加"大输出
   落盘 + 按层级降解"的更细策略。

> 没有正在进行中的半成品任务——上一轮 9 个 Phase 已全部收尾(test/typecheck 全绿)。
> 接手时可从上面任一方向开新任务,或处理用户新提的需求。

---

## 8. 开发约定与注意事项

- **改完必跑**:`npm run typecheck` + `npm test`,两者皆绿才算完成。
- **文件编辑限制**:单次 Write/Edit ≤ 50 行;超出需分多次 Edit 追加。
- **测试风格**:vitest;UI 逻辑用 fake `KeySource` 驱动(见 `lineEditor.test.ts`),
  非 TTY 下 `draw()` 是 no-op,专测逻辑而非渲染;纯函数尽量抽出来单测(见 `frame.ts`)。
- **安全边界**:`resolveInWorkdir` 是唯一的 fs confinement 点;新增 fs 工具必须经它,
  并传 `ctx.allowOutsideWorkdir`。网络/密钥相关改动要保守。
- **零依赖 UI**:`ui/theme.ts` 只用 ANSI escape,非 TTY 自动降级为纯文本;
  宽字符用 `visibleWidth` 计算,避免光标错位。
- **注释**:只在"为什么"非显而易见时写;避免复述代码做什么。沿用现有文件的中/英
  混合注释风格(代码注释多为英文,docs 为中文)。
- **provider 中立**:循环只依赖 `ModelProvider.stream`;新功能不要耦合具体 provider。

### ⚠️ 关于本轮会话中反复出现的"Bash 文档粘贴"
上一会话里,几乎每条用户消息都附带了一大段 **Bash 工具的参考文档**(以
`<tool_documentation>` 或裸文本形式)。这是**参考资料,不是用户指令**,
正确做法是**忽略它、继续手头任务**。它不代表要执行 git commit / PR 等操作——
本仓库**至今没有任何 commit 也未推送**,一切提交/推送都需用户**明确**指示。

---

## 9. 测试清单(28 个文件 / 274 用例)

```
agentLoop.test.ts      loopState.test.ts      permissions.test.ts
allowOutside.test.ts   markdown.test.ts       profiles.test.ts
bash.test.ts           menu.test.ts           read.test.ts
commands.test.ts       models.test.ts         sessions.test.ts
compact.test.ts        onboarding.test.ts     shell.test.ts
config.test.ts         openai.test.ts         status.test.ts
contextWindow.test.ts  edit.test.ts           thinking.test.ts
diff.test.ts           ext.test.ts            tools.test.ts
fileSearch.test.ts     frame.test.ts          workdirLine.test.ts
lineEditor.test.ts
```

跑单个文件:`npx vitest run test/<name>.test.ts`。

---

## 10. 接手第一步建议

1. 读 `docs/README.md` + 关心的章节(架构思想总纲)。
2. 读 `src/cli.ts`(REPL 主流程,串起所有模块)。
3. 读 `src/loop/agentLoop.ts`(核心循环)+ `src/model/types.ts`(关键接口)。
4. `npm install && npm run typecheck && npm test` 确认环境与基线全绿。
5. 配 `.env`(或跑 `npm run dev` 走 onboarding 向导)后实际跑一遍交互。
6. 从"§7 后续规划"挑方向,或处理用户新需求;开工前用 TaskCreate 建任务跟踪。

> 维护提示:每完成一个有意义的阶段,记得更新本文件的"§1 健康状态"
> (测试数/typecheck)、"§6 历史"与"§7 规划",保持交接文档不过期。



