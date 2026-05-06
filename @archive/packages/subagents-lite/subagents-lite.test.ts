/**
 * Tests for subagents-lite: frontmatter parsing, agent registry, parallel cap.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "./lib/frontmatter.js";
import { shellQuote } from "./lib/tmux.js";
import { MAX_SUBAGENTS_PER_RUN } from "./types.js";

// ─── Frontmatter parsing ────────────────────────────────────────────────

describe("parseFrontmatter", () => {
	it("parses valid frontmatter with body", () => {
		const content = `---
name: scout
description: Fast recon agent
model: claude-haiku
---

You are a scout agent.`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.name).toBe("scout");
		expect(result.frontmatter.description).toBe("Fast recon agent");
		expect(result.frontmatter.model).toBe("claude-haiku");
		expect(result.body).toBe("You are a scout agent.");
	});

	it("returns empty frontmatter when no delimiters", () => {
		const content = "Just a body without frontmatter.";
		const result = parseFrontmatter(content);
		expect(Object.keys(result.frontmatter)).toHaveLength(0);
		expect(result.body).toBe(content);
	});

	it("handles quoted values", () => {
		const content = `---
name: "my agent"
description: 'a quoted desc'
---

Body here.`;

		const result = parseFrontmatter(content);
		expect(result.frontmatter.name).toBe("my agent");
		expect(result.frontmatter.description).toBe("a quoted desc");
	});

	it("handles empty body", () => {
		const content = `---
name: test
description: test
---`;
		const result = parseFrontmatter(content);
		expect(result.frontmatter.name).toBe("test");
		expect(result.body).toBe("");
	});

	it("handles CRLF line endings", () => {
		const content = "---\r\nname: test\r\ndescription: test\r\n---\r\n\r\nBody.";
		const result = parseFrontmatter(content);
		expect(result.frontmatter.name).toBe("test");
		expect(result.body).toBe("Body.");
	});

	it("skips unclosed frontmatter", () => {
		const content = "---\nname: test\nno closing delimiter";
		const result = parseFrontmatter(content);
		expect(Object.keys(result.frontmatter)).toHaveLength(0);
	});
});

// ─── Shell quoting regression guard ─────────────────────────────────────

describe("shellQuote", () => {
	it("keeps generated task scripts bash-parseable with nested quote tokens", () => {
		const token = `"'"'thinking"'"'`;
		const task = `Task: verify literal token ${token}`;
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-quote-test-"));
		const scriptPath = path.join(tmpDir, "script.sh");

		try {
			const script = `#!/usr/bin/env bash\nprintf '%s\\n' ${shellQuote(task)}\n`;
			fs.writeFileSync(scriptPath, script, { mode: 0o700 });

			const check = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8" });
			expect(check.status).toBe(0);
			expect(check.stderr.trim()).toBe("");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ─── Parallel cap enforcement ───────────────────────────────────────────

describe("MAX_SUBAGENTS_PER_RUN", () => {
	it("is 1", () => {
		expect(MAX_SUBAGENTS_PER_RUN).toBe(1);
	});
});
