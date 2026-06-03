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
- `/mode`
- `/diff`
- `/resume`
- `/rewind`
- `/skill`
- `/debug`
- `/mcp`
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
- When the draft is empty, `Backspace` now removes attached next-turn items one
  by one in reverse order, across both queued skills and queued MCP server
  hints.
- If the draft already has text, `↑` now steps into the attached `skills:` and
  `mcp:` rows before history recall. Inside those rows, `←` / `→` moves across
  attached items and `Backspace` removes the highlighted one.
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
  `LIGHT_AGENT_SEARCH_BACKEND` into the global env file under
  `~/.light-agent/env`.
- `/config` and `/config search` both support picker flows in TTY mode, so you
  can choose search backend / key actions without memorizing every subcommand.
- `!` commands now run in the real foreground TTY through your login +
  interactive shell, so aliases such as `ll` work more like your local
  terminal. Foreground execution now avoids the job-control path that could
  suspend commands with `tty input` or `tty output`.
- `/mcp` shows configured servers plus live connection / loaded-tool state, and
  `/mcp` or `/mcp use <server>` attaches that server to the next message with a
  visible `mcp:` badge.
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
  "protectedPaths": ["src/secret", ".env"]
}
```

Notes:

- `disabledSkills` removes a skill from the prompt catalog and from `#` / `/skill`.
- `blockedCommands` only applies to model-driven `bash` / `shell` actions.
- `protectedPaths` blocks model-driven `edit` / `write`, and also blocks shell
  commands that obviously target those paths.
- User-typed `!` commands are not blocked by `/protect`.

## Search Config

For web search, Light-Agent checks config in this order:

1. shell env
2. project env file: `<workdir>/.env`
3. global env file: `~/.light-agent/env`

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

## License

MIT
