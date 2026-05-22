# prompt-channels maintenance

Entry: `extensions/prompt-channels/prompt-channels.ts`

## Architecture

The extension moves bulky prompt resources out of the system prompt while keeping
small meta-hints in the system prompt about where those resources now appear.

It hooks four lifecycle events:

| Event | Purpose |
| --- | --- |
| `session_start` | Detect resume/fork and skip initial injection if conversation already has a prompt-channels message |
| `before_agent_start` | Strip project-context and skills from the system prompt, add tiny channel hints, and inject user-level custom context |
| `context` | Reorder outbound LLM messages so `prompt-channels` appears before the corresponding user prompt |
| `session_compact` | Mark the channels for reinjection on the next turn |

## Channel behavior

### System prompt

The extension removes:

- the `# Project Context` block emitted by pi
- the full skills section, including the introductory prose and the `<available_skills>` registry

It then inserts a tiny stable hint block:

```md
## Context Channels
- Project/repository instructions may appear in tagged user-context messages with `<INSTRUCTIONS>` blocks.
- Available skills may appear in tagged reminder messages with `<available_skills>`; use them instead of guessing.
```

### User-level injected message

A single custom message with `customType: "prompt-channels"` is injected when needed.
At provider serialization time, pi turns custom messages into normal `user` messages.

Because pi stores `before_agent_start` messages after the current user message in session history,
the extension also uses the `context` hook to reorder the outbound provider message list so the
`prompt-channels` message is sent before the corresponding user prompt.

Important limitation: this fixes **LLM payload order**, but not the persisted transcript order.
In the saved session/UI, pi still stores the injected custom message after the user message unless
pi core itself changes that write order.

Format:

```md
# AGENTS.md instructions for /cwd/path

<INSTRUCTIONS>
## /path/to/AGENTS.md
...
</INSTRUCTIONS>

---

<skills_instructions>
The following skills provide specialized instructions for specific tasks.
...
<available_skills>
  <skill>...</skill>
</available_skills>
</skills_instructions>
```

## Source of truth

The extension supports two runtime modes:

1. **Preferred**: if `event.systemPromptOptions` exists, use its `contextFiles` and `skills`
2. **Fallback**: if running on older pi builds (such as `@mariozechner/pi-coding-agent@0.67.1`), parse the assembled system prompt string directly

This keeps the extension compatible with current my-pi installs while automatically
becoming more robust on newer pi versions.

## Extraction and stripping anchors

Fallback parsing uses pi's current prompt assembly format:

- project context anchor:
  `# Project Context\n\nProject-specific instructions and guidelines:\n\n`
- skills anchor:
  the full introductory paragraph beginning with
  `The following skills provide specialized instructions for specific tasks.`
  and ending at `</available_skills>`

If upstream pi changes those prompt shapes, fallback parsing may stop matching.
When that happens, prefer upgrading to a pi build that exposes `systemPromptOptions`.

## Reinjection triggers

| Trigger | Behavior |
| --- | --- |
| First turn | Inject |
| `session_start` with reason `resume`/`fork` | Skip injection; save hashes for future change detection |
| `session_compact` | Inject on next turn |
| Context hash changed | Inject |
| Skills hash changed | Inject |
| CWD changed | Inject |
| No changes | Strip-only, no reinjection |

## State

The extension keeps per-session in-memory state:

| Field | Purpose |
| --- | --- |
| `lastContextHash` | Detect AGENTS/project-context changes |
| `lastSkillsHash` | Detect skills-registry changes |
| `lastCwd` | Rebuild the header when session cwd changes |
| `pendingReinject` | Force reinjection after compaction |
| `skipInitialInject` | Prevent duplicate injection on resume/fork |

## Subagent / fork inheritance

- **Forks**: fork children run as ordinary `pi` processes and load registered extensions from settings, so prompt-channels is inherited automatically.
- **Subagents**: when an agent does **not** set explicit `extensions: [...]`, the child still loads settings-based extensions, so prompt-channels is inherited automatically.
- **Subagent edge case**: if an agent sets explicit `extensions: [...]`, subagent adds `--no-extensions` and only those listed paths load. In that case, include prompt-channels explicitly in the agent's `extensions` list.

## Validation checklist

Run:

```bash
npm run typecheck
npm run install:local
```

Then verify manually in pi:

1. system prompt no longer contains `# Project Context`
2. system prompt no longer contains the skills registry
3. system prompt still contains the tiny `## Context Channels` hint block
4. a `prompt-channels` custom message appears with `<INSTRUCTIONS>` and `<skills_instructions>`
5. provider payload shows `prompt-channels` before the matching user prompt
6. `/compact` causes reinjection on the next turn
