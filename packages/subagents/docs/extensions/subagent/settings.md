# subagent settings

Entry: `index.ts`

Config file: `~/.pi/agent/extensions/subagent/config.json`

## Extension config

Supported keys:

- `defaultSessionDir` — base directory for child session files when a tool call does not pass `sessionDir`
- `maxSubagentDepth` — recursion limit for nested subagent calls; default is `2`
- `parallel.maxTasks` — cap for expanded top-level `tasks[]`; default is `8`
- `parallel.concurrency` — default parallel concurrency when the tool call omits `concurrency`; default is `4`

Environment overrides used internally:

- `PI_SUBAGENT_DEPTH`
- `PI_SUBAGENT_MAX_DEPTH`
- `PI_SUBAGENT_INHERIT_PROJECT_CONTEXT`
- `PI_SUBAGENT_INHERIT_SKILLS`

## Tool-call controls

Per call, the `subagent` tool also accepts:

- execution mode: `agent` + `task` or `tasks[]`
- `concurrency`
- `context` (`fresh` or `fork`)
- `cwd`
- `agentScope` (`user`, `project`, `both`)
- `artifacts`
- `includeProgress`
- `share`
- `sessionDir`
- `output` (single-run only)
- `skill`
- `model`

## Agent discovery

User agents:

- `~/.agents`
- `~/.pi/agent/agents`

Project agents:

- `.pi/agents`
- legacy `.agents`

Project agents override user agents by name.

## Supported agent frontmatter

Common frontmatter keys consumed from agent markdown files:

- required: `name`, `description`
- model/prompt: `model`, `fallbackModels`, `thinking`, `systemPromptMode`
- inheritance: `inheritProjectContext`, `inheritSkills`
- tooling: `tools`, `extensions`
- skills: `skill` or `skills`
- execution defaults: `output`, `defaultReads`, `defaultProgress`, `maxSubagentDepth`
- control: `disabled`

## Not supported in this trimmed package

Removed features are intentionally absent:

- chain execution
- async/background runs
- agent CRUD / templates / manager UI
- slash commands
- worktree isolation
- intercom / prompt-template bridge
