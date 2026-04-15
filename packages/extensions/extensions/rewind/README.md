# rewind

Exact file-state checkpoints and restoration for pi sessions. Rewind records git worktree snapshots at every prompt boundary and lets you restore files when forking or navigating the session tree.

## Quick start

```
You: refactor the auth module to use JWT
Agent: [makes changes you don't like]

You: /fork
→ Select "refactor the auth module to use JWT"
→ Select "Code only (restore files, keep conversation)"

Result: Files restored, conversation intact. Try a different approach.
```

## Usage

### Via `/fork`

1. Type `/fork` in pi
2. Select a message to branch from
3. Choose a restore option:

| Option | Files | Conversation |
|--------|-------|-------------|
| **Conversation only (keep current files)** | Unchanged | Reset to that point |
| **Restore all (files + conversation)** | Restored | Reset to that point |
| **Code only (restore files, keep conversation)** | Restored | Unchanged |
| **Undo last file rewind** | Restored to before last rewind | Unchanged |

`Restore all`, `Code only`, and `Undo last file rewind` only appear when a rewind point or undo snapshot is available for the selected message.

### Via `/tree`

1. Press `Tab` to open the session tree
2. Navigate to a different node
3. Choose a restore option:

| Option | Files | Conversation |
|--------|-------|-------------|
| **Keep current files** | Unchanged | Navigated to that point |
| **Restore files to that point** | Restored | Navigated to that point |
| **Undo last file rewind** | Restored to before last rewind | Navigated to that point |

---

## How it works

Rewind is a **git-based file time machine** for your pi sessions. It silently takes snapshots of your working directory at every meaningful boundary, then lets you restore any of those snapshots when you `/fork` or navigate the session tree.

### Two storage layers

| Layer | What | Where |
|-------|------|-------|
| **Session ledger** | `rewind-turn`, `rewind-op`, `rewind-fork-pending` entries | Hidden `custom` entries in the session JSONL file |
| **Git objects** | Snapshot commits (tree → commit → keepalive chain) | `refs/pi-rewind/store` ref in the repo |

The session ledger is **authoritative** — it maps session entry IDs to git commit SHAs. The git ref just keeps those commits reachable so `git gc` doesn't delete them.

### Snapshot lifecycle (a single prompt cycle)

```
┌─────────────────────────────────────────────────────┐
│ before_agent_start  →  store prompt text             │
│                                                     │
│ turn_start (index 0)                                │
│   └─ capture worktree tree SHA                      │
│      └─ if same tree as last snapshot → reuse       │
│      └─ else → git commit-tree → append to store    │
│      └─ bind this commit to the USER entry          │
│                                                     │
│ ...agent runs, edits files...                       │
│                                                     │
│ turn_end (assistant)                                │
│   └─ capture worktree tree SHA again                │
│      └─ bind this commit to the ASSISTANT entry     │
│                                                     │
│ agent_end                                           │
│   └─ write rewind-turn entry to session             │
│      { v:2, snapshots:[sha1,sha2],                  │
│        bindings:[[userId,0],[asstId,1]] }            │
│   └─ reconstruct state, update footer status        │
│   └─ maybe run retention sweep (every 50 snapshots) │
└─────────────────────────────────────────────────────┘
```

Snapshots are only captured at visible boundaries — the user pre-prompt and each assistant turn end. Rewind does **not** create per-tool snapshots.

### How snapshots are taken

`captureWorktreeTree()` works like this:

1. Creates a **temp git index** (so your real staging area is untouched)
2. Runs `git add -A` against the temp index
3. Runs `git write-tree` → gets a tree SHA
4. Returns the tree SHA (no commit yet)

Then `ensureSnapshotForTree(treeSha)`:

1. If the tree SHA matches the last snapshot → **deduplicate, reuse the commit**
2. Otherwise → `git commit-tree <treeSha> -m "pi rewind snapshot"` → commit SHA
3. Appends the commit to the `refs/pi-rewind/store` keepalive chain
4. The keepalive chain is a linked list of empty-tree commits, each with the snapshot commit as a parent — this keeps all snapshots reachable from a **single ref**

### The keepalive store ref

```
refs/pi-rewind/store
        │
        ▼  (empty-tree keepalive commit)
        ├─ p ── snapshot commit A (tree of files at turn 0 start)
        │
        ├─ p ── snapshot commit B (tree of files at turn 0 end)
        │
        ├─ p ── snapshot commit C (tree of files at turn 1 start)
        ...
```

Each keepalive commit has the snapshot as a parent. `update-ref` is used with the expected old value (CAS-like) to handle concurrent processes — it retries up to 5 times if another process updated the ref concurrently.

### How restore works

When you pick a restore option, `restoreCommitExactly(targetCommitSha)` runs:

1. `captureWorktreeTree()` → current tree SHA
2. `getCommitTreeSha(target)` → target tree SHA
3. If identical → nothing to do, return early
4. Snapshot current state → **undo commit SHA** (so you can undo the restore)
5. `git diff --diff-filter=D` → find files that exist now but **won't exist** in the target
6. Delete those files from disk (with a safety check: must be inside repo root)
7. `git restore --source=<target> --worktree .` → restores only the worktree, does **not** touch the index
8. Update the `lastExact` cache for deduplication

This produces an exact restore — tracked and untracked (non-ignored) files are restored, and files that shouldn't exist are removed.

### Deduplication

Before creating a snapshot commit, Rewind captures the worktree tree SHA. If it matches the latest exact snapshot tree, Rewind reuses that existing commit instead of creating a new one. This means no-op turns (where the agent reads but doesn't change files) don't create redundant snapshots.

### Lineage (cross-session lookups)

When you fork or resume, the new session has a `parentSession` link. Rewind follows this chain to find snapshots from ancestor sessions:

```
resolveEntrySnapshotWithLineage(entryId)
  └─ current session → parse rewind entries → lookup entryId
     └─ if not found → follow parentSession link
        └─ parse parent session file → lookup entryId
           └─ ... recurse up the chain
```

This means a fork can find and restore rewind points from the original session, grandparent session, and so on.

### Fork flow (two-phase handoff)

The fork is split into two phases because the extension reloads in the new child process — in-memory state doesn't transfer automatically:

**Phase 1: `session_before_fork`** (in the parent session)

1. Resolve the selected entry's snapshot via lineage
2. Show a `select()` UI with restore options
3. Based on choice → either restore files or keep them
4. Write a `rewind-fork-pending` entry to the **parent** session with the resulting state (current + undo SHAs)

**Phase 2: `session_start`** (in the child session, reason=`"fork"`)

1. Parse the **parent** session file
2. Extract the `rewind-fork-pending` entry
3. Write a `rewind-op` entry to the **child** session inheriting the current/undo state
4. Reconstruct state so the child session knows its rewind position

```
Parent session                     Child session
──────────────                     ─────────────
before_fork event
  ├─ resolve snapshot
  ├─ show restore UI
  ├─ restore files (or not)
  └─ write rewind-fork-pending ──► session_start (fork)
                                     ├─ read parent's fork-pending
                                     ├─ write rewind-op to child
                                     └─ reconstruct state
```

### Tree navigation (two-phase handoff)

Same two-phase pattern as fork:

- **`session_before_tree`**: Show restore options, optionally restore files, store pending state in memory
- **`session_tree`**: Write `rewind-op` to the session, clear pending state, reconstruct

### Compaction handling

When pi compacts a session (summarizes old messages), rewind writes a `rewind-op` that binds the compaction entry to the current snapshot commit — so you can still restore to that point even after the original entries are gone.

### Retention

Retention only affects git reachability — session JSONL metadata is **append-only** and never compacted by Rewind.

When configured, retention sweeps run on:
- **Startup** — with an optional time budget (`startupBudgetMs`)
- **Shutdown**
- Every **50 new snapshots** during the session

The sweep process:

1. **Discover** session files (ancestor lineage only, or scan all repo sessions — depending on `scanMode`)
2. **Parse** all `rewind-turn`/`rewind-op` entries → build a live set of commit SHAs
3. **Protect** pinned commits (labeled entries, latest current/undo per session)
4. **Apply** `maxSnapshots` and `maxAgeDays` filters to remaining candidates
5. **Rewrite** `refs/pi-rewind/store` to only keep alive the surviving commits
6. Optionally run `git gc --auto` (skipped on startup to avoid races with concurrent snapshot creation)

If retention discovery yields an empty live set, Rewind preserves the existing `refs/pi-rewind/store` ref rather than deleting it.

---

## Configuration

Add optional settings to `~/.pi/agent/settings.json`:

```json
{
  "rewind": {
    "silentCheckpoints": true,
    "retention": {
      "maxSnapshots": 2000,
      "maxAgeDays": 30,
      "pinLabeledEntries": true,
      "scanMode": "ancestor-only",
      "startupBudgetMs": 5000
    }
  }
}
```

### Settings reference

| Setting | Default | Description |
|---------|---------|-------------|
| `rewind.silentCheckpoints` | `false` | Hide footer status indicator and checkpoint notifications |
| `rewind.retention.maxSnapshots` | ∞ | Cap on unpinned unique snapshot commits kept reachable |
| `rewind.retention.maxAgeDays` | ∞ | Age limit for unpinned snapshot commits |
| `rewind.retention.pinLabeledEntries` | `false` | Exempt snapshots bound to labeled nodes from pruning |
| `rewind.retention.scanMode` | `"ancestor-only"` | Discovery mode: `ancestor-only` (lineage) or `repo-sessions` (scan all) |
| `rewind.retention.startupBudgetMs` | ∞ | Time budget for startup retention sweeps |

Without `rewind.retention`, Rewind keeps exact history with no automatic expiration. This can grow git object storage without bound over time.

## Status indicator

When `silentCheckpoints` is off, the footer shows:

```
◆ N points / M snapshots
```

- **N points** = number of entry→commit bindings (rewind-able nodes in the session)
- **M snapshots** = number of unique commit SHAs (actual git snapshots on disk)

## Requirements

- pi v0.65.0+
- Git repository (no-op in non-git directories)

## Snapshot scope

### In scope ✅

- Tracked files
- Untracked, non-ignored files
- Exact delete-before-restore (files present now but absent in target are removed)
- No staging of the real git index during restore

### Out of scope ❌

- Ignored files (`.gitignore`d)
- Empty directories
- `toolResult` nodes (no rewind points)
- `bashExecution` nodes (no rewind points)

### Canonical rewind points

Exact file restore is available for:
- **User nodes** — the state when you sent the prompt
- **Assistant nodes** — the state after the agent finished
- **Compaction nodes** — aliased to the current exact state
- **Branch-summary nodes** — aliased during `/tree` navigation

## Inspecting storage

```bash
# Show the store ref head
git rev-parse refs/pi-rewind/store

# Show rewind entries in session files
grep '"customType":"rewind-' ~/.pi/agent/sessions/**/*.jsonl

# Show the keepalive chain
git log --oneline refs/pi-rewind/store
```

## Credits

Originally [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook) by [nicobailon](https://github.com/nicobailon).
