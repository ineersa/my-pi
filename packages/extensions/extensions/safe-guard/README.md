# safe-guard

Permission gate for pi — blocks dangerous operations and asks before destructive ones.

## Rules

| Axis | Rule |
|------|------|
| **sudo** | Hard-blocked (never allowlisted, never asked) |
| **Destructive commands** | `rm`, `rmdir`, `git clean`, `git reset --hard`, `push --force`, etc. → ask |
| **Writes outside CWD** | `write`/`edit` tool targeting paths outside project → ask |
| **Sensitive reads** | `.env.*.local`, `auth.json`, `.bashrc`, `.ssh/id_*`, cloud creds, `*.pem` → ask |
| **Env exposure** | `env`, `printenv` commands → ask |
| **Unknown intent** | Fail-safe → ask |

## Confirmation UI

Every prompt offers three choices:

- ❌ **Block** — deny the operation
- ✅ **Allow once** — let it through this time
- 📌 **Always allow** — persist to policy file, never ask again

No session-level grants — only forever allowlists.

## Policy file

`.pi/safe-guard.json` — persisted allowlists survive restarts.

```json
{
  "allowCommandPatterns": ["rm -rf node_modules"],
  "allowWriteOutsideCwd": ["/etc/hosts"],
  "allowDestructiveInPaths": [],
  "protectedReadPatterns": [],
  "dangerousCommandPatterns": []
}
```

Built-in defaults (protected reads, destructive patterns) are always active. The policy file adds extras on top.

## Protected read patterns (defaults)

`.env.local`, `.env.*.local`, `auth.json`, `credentials.json`, `.netrc`, `.npmrc`,
`.bashrc`, `.zshrc`, `.bash_profile`, `.zprofile`, `.profile`, `.bash_history`,
`.ssh/id_*`, `.ssh/config`, `.aws/credentials`, `.kube/config`, `.gcp/`, `.azure/`,
`*.pem`, `*.p12`, `*.pfx`, `service-account*`

## Commands

| Command | Description |
|---------|-------------|
| `/safe-guard` | Show current policy and all lists |
| `/safe-guard-allow-command <pattern>` | Allowlist a command pattern forever |
| `/safe-guard-allow-path <path>` | Allowlist a path for writes outside CWD |
| `/safe-guard-protect-read <pattern>` | Add a filename/path to protected reads |
| `/safe-guard-unprotect-read <pattern>` | Remove a pattern from protected reads |

## Related extensions

- **[scheduler](../../scheduler/README.md)** — recurring checks, one-time reminders, and `schedule_prompt` tool
- **[session-status](../session-status.ts)** — footer status indicator
