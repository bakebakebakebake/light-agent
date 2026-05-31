# Harness-Agent

A local-first coding agent CLI with:

- interactive slash-command menus
- editable multi-line input
- session resume and rewind
- todo tracking
- shell, subagent, and MCP support

## Requirements

- Node.js `>=20`
- An API key for one of the supported providers

## Install

### From npm

```bash
npm install -g harness-agent
```

Then run:

```bash
harness-agent
```

### From a GitHub release tarball

If you want to install a specific release directly:

```bash
npm install -g https://github.com/bakebakebakebake/harness-agent/releases/download/v0.3.1/harness-agent-0.3.1.tgz
```

## First Run

On first launch, Harness-Agent walks you through provider setup and stores your profile locally.

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
harness-agent
```

Useful commands inside the app:

- `/help`
- `/profile`
- `/model`
- `/mode`
- `/resume`
- `/rewind`
- `/skill`
- `/mcp`
- `/usage`

## Release Notes

- Releases are published on GitHub under the repository Releases page.
- npm publishing is configured for public release.

## License

MIT
