# 13 · 当前交互与搜索工作流

> 这页只讲当前版本里别人实际怎么用。

## 1. `/` 命令菜单

- `/` 仍然支持模糊搜索,但排序已经换成更符合直觉的一套:
  - exact 命中最高
  - prefix 命中高于普通模糊命中
  - 命令名命中高于描述命中
  - 危险命令如 `/exit`、`/clear` 默认降权
- 回车会**直接执行当前选项**,不会先把命令回填到输入框里。
- picker 现在会明确显示 `Search:` 搜索行,不用再猜这里能不能搜。
- 列表滚动提示固定为:
  - 顶部 `↑ N earlier`
  - 底部 `↓ M more`
- 单独按 `Esc` 会立刻退出菜单。

## 2. Skill 的使用方式

最顺手的方式是直接在输入框里打:

```text
#obsidian
```

- 输入 `#` 会直接打开 skill picker。
- 选中 skill 后:
  - skill 会挂到**当前这条正在编辑的消息**
  - 不会自动发送
  - 输入框里会显示 `skills: ...`
  - 你可以继续写正文
- `#` 内联选择和 `/skill` 选择现在走同一条挂载链路,所以 badge 会立刻刷新。
- 当输入框为空时,按 `Backspace` 会按加入顺序的反向逐个移除已挂载项。
  当前这套回退同时覆盖:
  - skill
  - `/mcp use <server>` 挂上的 MCP server hint
- 如果输入框里已经写了很多正文:
  - 按 `↑` 会先进入已挂载项区域,不会立刻跳历史
  - 会先落在 `skills:` 行,再往上是 `mcp:` 行
  - `←` / `→` 可在当前行的已挂载项之间切换
  - `Backspace` 会移除当前高亮的那一项
  - `↓` 会按相反方向回到正文输入区
- 这批 skill 只作用于**下一条消息**。发出去后会自动消费掉。

`/skill` 也仍然可用:

```text
/skill
/skill review
/skill remove review
/skill list
/skill disable review
/skill enable review
/skill clear
```

- `/skill` 无参会直接打开“可用 skills”选择器:
  - 选中后立刻挂到下一条消息
  - 不再先进入一个 `Manage skills...` 的中间层
  - 已挂载 skill 的移除更适合直接在输入框里用附件导航完成

当前 skill 会显示这些元数据:

- scope:`global` 或 `project`
- enabled / disabled
- 估算上下文占用:`~123 tok`

repo 级控制文件:

```text
<workdir>/.agents/light-agent.json
```

其中 `disabledSkills` 会让对应 skill:

- 不进 always-on skill catalog
- 不参与自动 skill 检索
- 不出现在 `#` 和 `/skill` 的可选列表里

## 3. `/diff`

当前 `/diff` 不会再直接把整个 repo 的 unified diff 一股脑打印出来。

常见用法:

```text
/diff
/diff --staged
/diff --unstaged
/diff --name-only
/diff lineEditor
```

- `/diff`
  - 先列出 changed files
  - 在 TTY 模式下会先显示一个 diff overview
  - 再选文件看 patch
  - 看完一个 patch 后,可以直接选择回到文件列表或退出 `/diff`
- `/diff --staged`
  - 只看 staged changes
- `/diff --unstaged`
  - 只看未暂存改动
- `/diff --name-only`
  - 只看文件列表
- `/diff <path-fragment>`
  - 先按路径片段过滤,再进入文件列表 / patch

当前重点还是“文件级浏览 + patch drill-down”,还没有做 side-by-side。

## 4. 图片附件

当前图片输入已经挂进同一条输入链路了。

最常见的几种方式:

```text
/image
/image add ./docs/diagram.png
/image paste
```

- `/image add <path>`
  - 把本地图片挂到下一条消息
- `/image paste`
  - 从 macOS 剪贴板导入图片
  - 截图到剪贴板后,也走这条路径
- Finder 拖拽图片到输入框时:
  - 如果终端插入的是图片路径
  - Light-Agent 会直接把它识别成图片附件
  - 不再把这段路径留在正文里

挂载后输入框会显示:

```text
images: a.png, b.png
```

图片和 skill / MCP 一样:

- 只作用于下一条消息
- 发出去后自动清空
- 空输入时 `Backspace` 可逐个回删
- 有正文时可先按 `↑` 进入附件区,再高亮删除

## 5. `/search`

```text
/search light-agent github
/search openai responses api tools
/search latest anthropic release notes
```

当前行为:

1. 有 `TAVILY_API_KEY` 时优先走 Tavily
2. 否则自动降级到 Bing
3. 本地再做一轮重排
4. 输出标题、来源、backend、URL、摘要、日期
5. 在 TTY 模式下可以继续选一个结果,直接抓页面正文

如果你主要使用 npm 安装版,更适合直接配全局搜索设置,而不是每个项目都写
一份 `.env`。

当前优先级:

1. shell env
2. `<workdir>/.env`
3. `~/.light-agent/env`
   - legacy `~/.harness-agent/env` 也会被读取,并在后续写入时迁到 `.light-agent`

可直接通过命令配置:

```text
/config
/config search
/config search backend auto
/config search backend tavily
/config search tavily-key
/config search clear-tavily-key
```

- `/config` 和 `/config search` 在 TTY 模式下都支持 picker:
  - 可以直接选 runtime config 或 search config
  - search config 里可以直接选 backend / set key / clear key

补充一点:

- DeepSeek V4 走官方 thinking 语义时,CLI 的 `thinking high` 会映射到
  DeepSeek 的最高档 `reasoning_effort=max`
- `thinking low/medium` 会映射到 DeepSeek 的 `high`
- 某些第三方 OpenAI 兼容网关如果不接受这些字段,会自动回退到不带
  DeepSeek thinking 扩展字段的请求,避免直接 400

排序倾向:

- 技术类 query 会更偏向官方文档、主仓库、维护者来源
- “latest / today / recent” 这类 query 会更偏向新结果
- 输出默认保留来源和 backend,方便人工判断可信度

如果你在切换模型后怀疑“模型名能选上,但实际不可用”,现在可以直接跑:

```text
/model test
/model test gpt-5-mini
```

它现在不只检查“目录 + 一次 stream”,而是会产出一份结构化兼容报告,重点看:

1. 你的 profile 当前更偏向哪条协议
2. 实际跑通的是 `anthropic` 还是 `openai`
3. 实际命中的 `chatURL` / `catalogURL`
4. catalog / stream / tools / reasoning / vision 这些能力大致是否可用
5. 失败时属于哪类问题,例如:
   - `provider_mismatch`
   - `empty_stream`
   - `html_instead_of_api`
   - `unauthorized_client`
   - `model_not_found`

这对排查“代理站看起来能连,但其实协议不对 / 路径不对 / 客户端被拒绝”很有用。

现在在 onboarding 和 `/profile new`、`/profile edit` 里,只要你先填好了 provider、API key、baseURL 并选定模型,Light-Agent 就会做一次双链路兼容探测:

- TTY 下优先走 picker 选择
- 仍然保留 `Enter custom model`
- 非 TTY 或抓取失败时,继续回退到手工输入
- 如果用户选的 provider 不能真正跑通,但另一条链路能跑通,会自动纠正并把结果写回 profile

对于兼容层,现在有两种自动恢复:

1. URL 形态恢复
   - 如果你填的是站点根地址,例如 `https://example.com`
   - OpenAI 兼容端点会自动尝试标准 `/v1/...`
   - Anthropic 兼容端点也会在 root 和 `/v1` 形态之间做纠正

2. 运行时恢复
   - 如果真实请求因为 reasoning / tools 这类可选参数被上游拒绝
   - Light-Agent 会先降级成更轻的最小请求再试一次
   - 如果当前协议明显不对,还会自动探测另一条协议并重试

所以像某些代理站“官网地址可打开,真正 API 在 `/v1` 下”,或者“同一个 URL 只支持其中一种协议”这种情况,现在不需要你先手工改 profile 才能测出来。`/model test` 会把实际命中的链路和 endpoint 打出来,方便确认到底是哪条路径在工作。

这里有一个明确边界:

- 如果上游返回 `unauthorized_client`
- 说明它在站点层面拒绝了当前客户端
- Light-Agent 不会伪装成别的产品去绕过这个限制

模型工具层也同步有:

- `web_search`
- `web_fetch`

## 6. 终端 resize 与表格重排

当前 TTY 在收到终端窗口变化后,不会再继续依赖旧的屏幕行去“补丁式修复”。

现在的处理方式更接近 Codex 这类 CLI:

1. 输入区或流式输出区收到 `SIGWINCH`
2. 清掉当前可视区域
3. 从当前 transcript/source 重新组装可见内容
4. 按新的终端宽度重新渲染 markdown、表格和输入框
5. 再把当前输入区画回去

这意味着:

- markdown 表格会按**当前宽度**重新分列 / 截断 / 对齐
- 输入框的换行会按**当前宽度**重新计算
- 回到会话或正在 streaming 时,resize 后更不容易出现旧框线残留

这套机制当前优先保证两类场景:

- 正在输入时的 redraw
- 正在流式输出时的 redraw

当前实现还有一条明确约束:

- **输入态**只由 line editor 接管 resize
- **streaming 态**只由 renderer 接管 resize

这样可以避免两边同时响应同一次 `SIGWINCH`,把清屏和重绘顺序打乱。

另外,`/` 菜单和 picker 在仅仅是上下移动选中项时,现在优先走增量刷新:

- 单纯选择变化时,只重画受影响的几行
- 菜单数量、搜索框、footer、frame 结构变化时,才走整块重绘

这能明显减轻“按上下时菜单闪一下”的感觉。

现在的重绘链路固定为:

1. 清掉当前可视区域
2. 重放 banner / transcript tail / status 这些 source-backed 内容
3. 按当前宽度重新渲染 markdown 和表格
4. 最后重画输入框或当前 streaming turn

这意味着 resize 后不再依赖“旧终端里还残留了哪些行”。

如果你想验证这条链路,最直接的方式是:

1. 先让模型输出一段带 markdown table 的内容
2. 左右拉伸终端窗口
3. 看表格和输入框是否按新宽度重排

## 7. `/mcp` 与 `/protect`

`/mcp` 现在会显示:

- server 名称
- `connected` / `idle`
- 当前已加载 tool 数
- command / args / scope / description
- `/mcp` 无参时会进入 picker,可以直接把某个 server 挂到**下一条消息**
- `/mcp use <server>` 也可以显式挂载
- 挂载后输入框会显示 `mcp: ...`
- 和 skill 一样,发出去后会自动消费掉

`/protect` 用来保护模型动作:

```text
/protect
/protect list
/protect add command rm -rf
/protect rm command rm -rf
/protect add path .env
/protect rm path .env
```

这套规则只拦**模型调用**:

- `bash`
- `shell`
- `edit`
- `write`

你自己手打的 `!` 命令不受它影响。

另外,`!` 现在会临时释放 raw stdin,把真实前台 TTY 交给子进程,并改成
前台非 interactive shell + 显式加载 rc 文件的方式执行,所以
`npm run dev` 这类长期运行命令更不容易再出现 `suspended (tty input)`
或 `suspended (tty output)`。

## 7. `/schedule` 与 `/gui`

这两块是新增能力:

```text
/schedule
/schedule add
/schedule status
/gui
/gui doctor
```

- `/schedule`
  - 管理本机后台任务
  - 第一版支持 `once`、`daily`、`weekly`
  - 状态、pid、log 都落在 `~/.light-agent/scheduler/`
  - `/schedule status` 会显示 effective poll interval、pid、log path、最近错误
  - `/schedule add` / `/schedule show` 会显示该任务当前命中的权限摘要

后台任务权限现在单独受 repo 配置控制:

```json
{
  "scheduler": {
    "allowedTools": ["bash", "write"],
    "allowedCommandPatterns": ["npm test", "npm run lint"],
    "pollIntervalSeconds": 20,
    "logRotationBytes": 500000,
    "logRotationFiles": 4
  }
}
```

规则是:

- `low` 风险工具默认可用
- `medium/high` 需要命中 `allowedTools`
- `bash` / `shell` 还需要命中 `allowedCommandPatterns`
- repo protect 规则仍然生效
- `/gui`
  - 列出当前已接通的 macOS GUI action
  - `doctor` 会检查 `osascript` / `System Events` 权限状态

如果只是想先了解怎么用,更详细的说明在:

- `docs/14-multimodal-and-image-input.md`
- `docs/15-scheduler-and-gui-automation.md`

## 8. `/debug` 与日志

```text
/debug on
/debug off
```

- 打开后会把结构化日志写到:

```text
~/.light-agent/logs/light-agent.log
```

- 当前重点记录:
  - slash 菜单排序结果
  - 输入框菜单打开/关闭
  - `/diff` 文件计数
  - `/skill` 挂载状态
  - `/search` 结果和抓取 URL
  - 顶层异常与未处理错误

## 9. CI

仓库已接入 GitHub Actions:

- push 到 `main`
- pull request
- `v*` tag

## 10. `/compact` 与长会话

`/compact` 现在和自动 compact 共用同一套多层实现:

- `verbatim tail`
  - 最近几轮原文保留
- `working summary`
  - 较近历史的高保真摘要
- `archival summary`
  - 更早历史的短摘要

自动触发规则:

- 约 `70%` 上下文占用: `soft`
- 约 `85%` 上下文占用: `strong`
- provider 报 `context overflow`: `emergency`

紧急压缩触发后,当前问题会回填到输入框,这样你可以直接重发而不用重打一遍。

都会跑:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## 10. 当前实现结构

- `src/commands/registry.ts`
  - 负责 slash 菜单召回、排序、dispatch
- `src/commands/interactionCommands.ts`
  - 负责 `/diff`、`/search`、`/skill`、`/image`、`/debug`
- `src/commands/scheduleCommands.ts`
  - 负责 `/schedule`
- `src/commands/guiCommands.ts`
  - 负责 `/gui`
- `src/ui/lineEditor.ts`
  - 负责编辑器状态机、history、rewind、interrupt、菜单开关
- `src/ui/editorRender.ts`
  - 负责输入框视图拼装、换行、badge 展示、redraw 判断
- `src/ui/keys.ts`
  - 直接解析 raw stdin,这样单独 `Esc` 可以立刻生效
- `src/util/web.ts`
  - 负责 Tavily/Bing 搜索后端、重排和页面抓取
- `src/util/images.ts`
  - 负责图片校验、拖拽路径识别、剪贴板桥接、visionMode 本地拦截
- `src/scheduler/`
  - 负责 jobs.json、runner、run log、后台执行
- `src/gui/macos.ts`
  - 负责 Finder / Notes / Safari / System Events 的脚本白名单桥接
- `src/ext/repoConfig.ts`
  - 负责 repo 级 `disabledSkills`、`blockedCommands`、`protectedPaths`
