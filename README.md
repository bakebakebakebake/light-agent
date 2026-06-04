# Light-Agent

A local-first coding agent CLI with:

- interactive slash-command menus
- smarter slash ranking for exact and prefix matches
- editable multi-line input
- session resume and rewind
- native project/user memory
- todo tracking
- shell, subagent, MCP, and web search support
- inline `#skill` attach, repo protection rules, and Tavily-first search
- multimodal image input from files, drag-drop paths, and clipboard paste
- local scheduled jobs and macOS GUI automation hooks
- source-backed TUI resize replay so transcript tables and input layout reflow at the new terminal width
- layered context compaction for long sessions with soft, strong, and emergency modes

## Requirements

- Node.js `>=20`
- An API key for one of the supported providers

## Install

### From npm

```bash
npm install -g light-agent-cli
```

Then run:

```bash
light-agent
```

Or run without installing first:

```bash
npx light-agent-cli
```

### From a GitHub release tarball

If you want to install a specific release directly, use that release's tarball:

```bash
npm install -g https://github.com/bakebakebakebake/light-agent/releases/download/<tag>/light-agent-cli-<version>.tgz
```

## First Run

On first launch, Light-Agent walks you through provider setup and stores your profile locally.

Supported providers in the current build:

- Anthropic
- OpenAI-compatible endpoints

You can also prepare config from the included example:

```bash
cp .env.example .env
```

## Usage

Start the CLI:

```bash
light-agent
```

Useful commands inside the app:

- `/help`
- `/search <query>`
- `/memory`
- `/remember`
- `/forget`
- `/profile`
- `/model`
- `/model test`
- `/mode`
- `/diff`
- `/resume`
- `/rewind`
- `/skill`
- `/image`
- `/debug`
- `/mcp`
- `/schedule`
- `/gui`
- `/usage`
- `/protect`
- `/config search`

## Interaction Highlights

- `/` menus now rank exact and prefix hits above loose fuzzy matches, so `/mode`
  lands on `/mode` instead of unrelated commands.
- `#` now opens an inline skill picker directly inside the input box. Pick a
  skill, keep typing, and the current draft keeps a visible `skills:` badge.
  Inline `#skill` picks and `/skill` picks now share the same badge path, so
  both appear immediately in the current draft.
- `/image add <path>` attaches a local image to the next message, `/image paste`
  imports the current macOS clipboard image, `cmd+v` can attach an image-only
  clipboard directly, and Finder drag-drop paths are recognized as image
  attachments instead of plain text. Direct image paths inside a prompt are
  also extracted before submit, so a message like
  `"/Users/me/Pictures/demo.png what is in this image?"` sends the image plus
  the remaining text together. Attached images appear in the draft as an
  `images:` badge and can be removed with the same empty `Backspace` /
  attachment-focus flow as skills and MCP hints.
- `/image` without arguments now opens a picker with paste / list / remove /
  clear actions plus detected project images, so you usually do not need to
  remember subcommands first.
- TTY resize replay now rebuilds the visible transcript from source data instead
  of trusting stale terminal rows. That gives markdown tables and wrapped input
  a chance to reflow against the current terminal width after `SIGWINCH`.
- `/compact` and auto-compaction now share the same layered pipeline:
  recent turns stay verbatim, nearby history becomes a working summary, and
  older summaries are folded into a shorter archival layer. Auto-compaction
  starts around `70%` context use, gets stronger around `85%`, and switches to
  emergency compaction when a provider reports context overflow.
- When the draft is empty, `Backspace` now removes attached next-turn items one
  by one in reverse order, across queued images, skills, and MCP server hints.
- If the draft already has text, `↑` now steps into the attached `skills:` and
  `mcp:` rows before history recall. Image attachments join the same inline
  navigation flow. Inside those rows, `←` / `→` moves across attached items and
  `Backspace` removes the highlighted one.
- `/skill` opens the same searchable picker, and also supports
  `/skill list`, `/skill enable <name>`, `/skill disable <name>`, and
  `/skill clear`. The no-arg picker now goes straight to available skills and
  attaches the one you choose without an extra management step.
- Disabled skills stay out of the always-on skill catalog, out of automatic
  retrieval, and out of the inline picker until you re-enable them.
- `/diff` now starts from changed files, then lets you inspect a patch for the
  file you choose instead of dumping the whole repo diff at once. The diff view
  now has a clearer overview header, richer per-file stats, and an explicit
  action step to jump back to the file list or leave `/diff`.
- `/search <query>` now uses Tavily first when `TAVILY_API_KEY` is present, then
  falls back to Bing. Results keep source, backend, URL, and dates so they stay
  easy to verify.
- If you mainly use the npm-installed CLI, you do not need a repo-local `.env`
  for search config. Use `/config search` to store `TAVILY_API_KEY` and
  `LIGHT_AGENT_SEARCH_BACKEND` into the global env file. On fresh installs this
  is usually `~/.light-agent/env`. Existing `~/.harness-agent` installs are now
  treated as legacy and will migrate forward to `.light-agent`.
- `/config` and `/config search` both support picker flows in TTY mode, so you
  can choose search backend / key actions without memorizing every subcommand.
- `/model test` runs a quick smoke test against the current OpenAI/Anthropic
  config: it checks model catalog discovery and then asks the configured model
  to reply with a tiny fixed answer. This is the fastest way to tell whether a
  model/baseURL pair is really usable.
- For OpenAI-compatible setups, if `baseURL` points at a website root such as
  `https://host.example` and that root returns HTML, Light-Agent now retries
  the standard `/v1/...` API path automatically for both model discovery and
  streaming. `/model test` shows the resolved catalog URL so this recovery is
  visible.
- `!` commands now run in the real foreground TTY through your login +
  interactive shell, so aliases such as `ll` work more like your local
  terminal. Foreground execution now avoids the job-control path that could
  suspend commands with `tty input` or `tty output`.
- `/mcp` shows configured servers plus live connection / loaded-tool state, and
  `/mcp` or `/mcp use <server>` attaches that server to the next message with a
  visible `mcp:` badge.
- `/schedule` manages local background jobs. First version supports `once`,
  `daily`, and `weekly` schedules, persists jobs under `~/.light-agent`, and
  runs them through a detached local runner.
- `/schedule` without arguments now opens a picker-first flow: add a job, check
  runner status, or pick an existing job and choose `show / run-now / pause /
  resume / remove`.
- `/gui` lists the supported macOS GUI actions, and the `macos_gui` tool gives
  the model a structured Finder / Notes / Safari / System Events bridge behind
  the usual confirmation gate.
- `/gui` without arguments also starts from a picker, so you can jump to action
  list, app list, or doctor output directly.
- `/protect` lets you block risky model-side command patterns and protect repo
  paths from accidental edits or destructive shell calls.
- `/debug on` writes structured logs to `~/.light-agent/logs/light-agent.log`
  so UI and provider issues are easier to diagnose.

## Repo Config

Light-Agent reads repo-local config from:

- `<workdir>/.agents/light-agent.json`
- `<workdir>/.agent/light-agent.json` as a compatibility fallback

Current keys:

```json
{
  "disabledSkills": ["review"],
  "blockedCommands": ["rm -rf", "git reset --hard"],
  "protectedPaths": ["src/secret", ".env"],
  "scheduler": {
    "allowedTools": ["bash", "write"],
    "allowedCommandPatterns": ["npm test", "npm run lint"],
    "pollIntervalSeconds": 20,
    "logRotationBytes": 500000,
    "logRotationFiles": 4
  }
}
```

Notes:

- `disabledSkills` removes a skill from the prompt catalog and from `#` / `/skill`.
- `blockedCommands` only applies to model-driven `bash` / `shell` actions.
- `protectedPaths` blocks model-driven `edit` / `write`, and also blocks shell
  commands that obviously target those paths.
- `scheduler.allowedTools` allows selected medium/high-risk tools in detached
  background jobs; low-risk tools stay allowed by default.
- `scheduler.allowedCommandPatterns` further restricts scheduler `bash` /
  `shell` calls to matching command substrings.
- `scheduler.pollIntervalSeconds` and `scheduler.logRotation*` tune the shared
  runner across all local jobs.
- User-typed `!` commands are not blocked by `/protect`.

## Search Config

For web search, Light-Agent checks config in this order:

1. shell env
2. project env file: `<workdir>/.env`
3. global env file: `~/.light-agent/env`
   legacy `~/.harness-agent/env` is still read and migrated forward

Useful commands:

```text
/config
/config search
/config search backend auto
/config search backend tavily
/config search tavily-key
/config search clear-tavily-key
```

The actual search key name is still:

```text
TAVILY_API_KEY
```

## Images, Scheduler, and GUI

Image input supports four entry points:

- `/image add <path>`
- `/image paste`
- Finder drag-drop of local image paths into the prompt
- image-only turns, as long as at least one image is attached

Notes:

- Clipboard import currently uses a macOS clipboard bridge and writes temporary
  PNG files under `~/.light-agent/tmp/images/`.
- The active profile can control image sending with `visionMode=auto|on|off`.
- In `auto`, the CLI blocks image sends when the selected model does not look
  vision-capable.

Scheduler commands:

- `/schedule`
- `/schedule add`
- `/schedule list`
- `/schedule show <id>`
- `/schedule remove <id>`
- `/schedule pause <id>`
- `/schedule resume <id>`
- `/schedule run-now <id>`
- `/schedule status`
- `/schedule stop-runner`

GUI commands:

- `/gui`
- `/gui list`
- `/gui apps`
- `/gui doctor`

The scheduler stores jobs, logs, and pid state under the active global home,
which is now `~/.light-agent/scheduler/`. Legacy `~/.harness-agent/` data is
read and migrated forward.
Each job also reads repo-local scheduler policy from `.agents/light-agent.json`,
and `/schedule add`, `/schedule show`, and `/schedule status` surface the
effective permissions and runner settings.

## Memory

Light-Agent now includes a native memory system with:

- file-backed memory cards
- session transcript evidence
- a local SQLite index for retrieval
- a derived core digest that stays small enough for stable injection
- automatic pre-turn memory injection
- access tracking so frequently used memories rise into the digest over time
- conservative durable-memory extraction for both English and common Chinese instructions

Storage layout:

- project memory: `<workdir>/.agents/memory/project/*.md`
- user memory: `~/.light-agent/memory/user/*.md`
- index: `~/.light-agent/memory/index.sqlite`
- transcripts: `~/.light-agent/memory/transcripts/<session-id>.jsonl`
- digests: `~/.light-agent/memory/digests/<hash>.md`

Useful memory commands:

- `/memory`
- `/memory list`
- `/memory search <query>`
- `/memory show <id>` for evidence preview and relationship overview
- `/memory rebuild`
- `/memory compact`
- `/memory diagnose <query>`
- `/remember [project|user] <text>`
- `/forget <id>`

In TTY mode, `/memory`, `/remember`, and `/forget` also support picker-driven flows so you usually do not need to type the full subcommand or memory id by hand.

If you want a full example-driven walkthrough, see:

- [docs/12-memory-system.md](docs/12-memory-system.md)

## Release Notes

- Releases are published on GitHub under the repository Releases page.
- npm publishing is configured for public release. The unscoped `light-agent`
  package name is already taken on npm, so the CLI package is now
  `light-agent-cli` while the command itself is `light-agent`.
- GitHub Actions now runs `npm run typecheck`, `npm test`, and `npm run build`
  on pushes, pull requests, and release tags.

## More Docs

- [docs/12-memory-system.md](docs/12-memory-system.md)
- [docs/13-interaction-and-search.md](docs/13-interaction-and-search.md)
- [docs/14-multimodal-and-image-input.md](docs/14-multimodal-and-image-input.md)
- [docs/15-scheduler-and-gui-automation.md](docs/15-scheduler-and-gui-automation.md)

## License

MIT
