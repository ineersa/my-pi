/** Detect shell move commands to nudge toward IDE move refactoring. */
export const MOVE_BASH_REGEX = /(^|[;&|]\s*|\s+)(?:git\s+mv|mv)(?=\s|$)/i;

/** Cooldown for repeated move nudges to avoid reminder spam. */
export const NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

/** Timeout for a single MCP tool call (e.g. get_file_problems). */
export const MCP_TOOL_CALL_TIMEOUT_MS = 30_000;

/** Max attempts before giving up on a tool call. */
export const MCP_MAX_RETRIES = 3;

/** Base delay between retries, multiplied by attempt index. */
export const MCP_RETRY_BASE_DELAY_MS = 1_000;

/** How long to wait for the MCP client to connect before giving up on that attempt. */
export const MCP_CONNECT_TIMEOUT_MS = 30_000;

/** Delay before attempting reconnection after a connection drop. */
export const MCP_RECONNECT_DELAY_MS = 3_000;

/** Index readiness checks before edit/write: retry count when IDE is in dumb/indexing mode. */
export const IDE_INDEX_STATUS_MAX_RETRIES = 5;

/** Base delay between index readiness retries; doubles each attempt (exponential backoff). */
export const IDE_INDEX_STATUS_RETRY_BASE_DELAY_MS = 2_000;

/** Maximum delay cap for index readiness retries. */
export const IDE_INDEX_STATUS_RETRY_MAX_DELAY_MS = 30_000;

/** Timeout for individual index status tool calls on the last retry attempt. */
export const IDE_INDEX_STATUS_LAST_ATTEMPT_TIMEOUT_MS = 30_000;
