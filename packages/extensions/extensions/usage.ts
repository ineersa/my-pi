import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { AuthStorage, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type PiAuthEntry = {
	type?: string;
	key?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	[key: string]: unknown;
};

type PiAuthMap = Record<string, PiAuthEntry>;

type UsageWindow = {
	label: string;
	percentLeft: number;
	resetDescription: string | null;
	windowMinutes: number | null;
};

type ProviderRateLimits = {
	provider: "openai";
	windows: UsageWindow[];
	credits: number | null;
	account: string | null;
	plan: string | null;
	note: string | null;
	error: string | null;
};

type ZaiRateLimits = {
	provider: "zai";
	windows: UsageWindow[];
	modelCount: number | null;
	note: string | null;
	error: string | null;
};

type ZaiQuotaLimitItem = {
	type?: unknown;
	usage?: unknown;
	currentValue?: unknown;
	percentage?: unknown;
	nextResetTime?: unknown;
};

type ZaiQuotaResponse = {
	code?: unknown;
	msg?: unknown;
	data?: { limits?: unknown };
	success?: unknown;
};

const PROBE_TIMEOUT_MS = 15_000;
const OPENAI_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_AUTH_KEYS = ["openai-codex", "openai"];
const ZAI_PROVIDER_KEY = "zai";
const ZAI_ENV_KEY = "ZAI_API_KEY";
const ZAI_MODELS_ENDPOINT = "https://api.z.ai/api/coding/paas/v4/models";
const ZAI_QUOTA_ENDPOINT = "https://api.z.ai/api/monitor/usage/quota/limit";

let oauthModule: typeof import("@earendil-works/pi-ai/oauth") | null = null;
let authStorage: AuthStorage | null = null;

function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

function fmtDuration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) {
		return `${seconds}s`;
	}

	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) {
		return `${minutes}m${remainingSeconds > 0 ? `${remainingSeconds}s` : ""}`;
	}

	const days = Math.floor(minutes / (24 * 60));
	const minutesAfterDays = minutes - days * 24 * 60;
	const hours = Math.floor(minutesAfterDays / 60);
	const remainingMinutes = minutesAfterDays % 60;

	if (days > 0) {
		return `${days}d${hours > 0 ? `${hours}h` : ""}${remainingMinutes > 0 ? `${remainingMinutes}m` : ""}`;
	}

	return `${hours}h${remainingMinutes > 0 ? `${remainingMinutes}m` : ""}`;
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

function parseFiniteNumber(value: unknown): number | null {
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) {
		return null;
	}
	return parsed;
}

function countdownFromSeconds(seconds: unknown): string | null {
	const parsed = parseFiniteNumber(seconds);
	if (parsed === null) {
		return null;
	}
	if (parsed <= 0) {
		return "now";
	}
	return `in ${fmtDuration(parsed * 1000)}`;
}

function parseLooseFiniteNumber(value: unknown): number | null {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	const direct = Number(trimmed);
	if (Number.isFinite(direct)) {
		return direct;
	}
	const match = trimmed.match(/-?\d+(?:\.\d+)?/);
	if (!match) {
		return null;
	}
	const parsed = Number(match[0]);
	return Number.isFinite(parsed) ? parsed : null;
}

function parseHeaderNumber(headers: Headers, names: string[]): number | null {
	for (const name of names) {
		const raw = headers.get(name);
		const parsed = parseLooseFiniteNumber(raw);
		if (parsed !== null) {
			return parsed;
		}
	}
	return null;
}

function countdownFromResetValue(value: unknown): string | null {
	if (typeof value !== "string" || value.trim().length === 0) {
		return null;
	}
	const trimmed = value.trim();

	const directNumber = Number(trimmed);
	if (Number.isFinite(directNumber)) {
		if (directNumber <= 0) {
			return "now";
		}
		if (directNumber > 1_000_000_000_000) {
			return `in ${fmtDuration(Math.max(0, directNumber - Date.now()))}`;
		}
		if (directNumber > 1_000_000_000) {
			return countdownFromSeconds(directNumber - Date.now() / 1000);
		}
		return countdownFromSeconds(directNumber);
	}

	const durationMatches = [...trimmed.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/gi)];
	if (durationMatches.length > 0) {
		const multipliers: Record<string, number> = {
			ms: 1,
			s: 1_000,
			m: 60_000,
			h: 3_600_000,
			d: 86_400_000,
			w: 604_800_000,
		};
		let totalMs = 0;
		for (const match of durationMatches) {
			const amount = Number.parseFloat(match[1]);
			const unit = match[2].toLowerCase();
			const multiplier = multipliers[unit];
			if (Number.isFinite(amount) && multiplier) {
				totalMs += amount * multiplier;
			}
		}
		if (totalMs <= 0) {
			return "now";
		}
		return `in ${fmtDuration(totalMs)}`;
	}

	const asDateMs = Date.parse(trimmed);
	if (Number.isFinite(asDateMs)) {
		const diff = asDateMs - Date.now();
		if (diff <= 0) {
			return "now";
		}
		return `in ${fmtDuration(diff)}`;
	}

	const looseNumber = parseLooseFiniteNumber(trimmed);
	if (looseNumber !== null) {
		if (looseNumber <= 0) {
			return "now";
		}
		return countdownFromSeconds(looseNumber);
	}

	return null;
}

function maybeAddWindowFromHeaders(
	windows: UsageWindow[],
	headers: Headers,
	label: string,
	limitHeaders: string[],
	remainingHeaders: string[],
	resetHeaders: string[],
): boolean {
	const limit = parseHeaderNumber(headers, limitHeaders);
	const remaining = parseHeaderNumber(headers, remainingHeaders);
	if (limit === null || remaining === null || limit <= 0) {
		return false;
	}

	let resetDescription: string | null = null;
	for (const name of resetHeaders) {
		const parsed = countdownFromResetValue(headers.get(name));
		if (parsed) {
			resetDescription = parsed;
			break;
		}
	}

	windows.push({
		label,
		percentLeft: clampPercent((remaining / limit) * 100),
		resetDescription,
		windowMinutes: null,
	});
	return true;
}

function windowLabelFromSeconds(seconds: number): string {
	if (seconds <= 0 || !Number.isFinite(seconds)) {
		return "window";
	}
	if (seconds % 604_800 === 0) {
		return `${seconds / 604_800}w`;
	}
	if (seconds % 86_400 === 0) {
		return `${seconds / 86_400}d`;
	}
	if (seconds % 3_600 === 0) {
		return `${seconds / 3_600}h`;
	}
	if (seconds % 60 === 0) {
		return `${seconds / 60}m`;
	}
	return `${Math.round(seconds)}s`;
}

function appendNote(existing: string | null, next: string): string {
	return existing ? `${existing} ${next}` : next;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
	try {
		const parts = jwt.split(".");
		if (parts.length < 2) {
			return null;
		}
		const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
		return JSON.parse(payload) as Record<string, unknown>;
	} catch {
		return null;
	}
}

function readPiAuth(): PiAuthMap {
	const authPath = getAuthPath();
	try {
		if (!existsSync(authPath)) {
			return {};
		}
		const raw = readFileSync(authPath, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") {
			return {};
		}
		return parsed as PiAuthMap;
	} catch {
		return {};
	}
}

function persistAuthEntry(authKey: string, entry: PiAuthEntry): void {
	try {
		const authPath = getAuthPath();
		const current = existsSync(authPath) ? (JSON.parse(readFileSync(authPath, "utf-8")) as Record<string, unknown>) : {};
		current[authKey] = { type: "oauth", ...entry };
		writeFileSync(authPath, `${JSON.stringify(current, null, 2)}\n`, "utf-8");
	} catch {
		// Non-critical. We can still use the fresh token in-memory.
	}
}

async function getOAuthModule(): Promise<typeof import("@earendil-works/pi-ai/oauth") | null> {
	if (oauthModule) {
		return oauthModule;
	}
	try {
		oauthModule = await import("@earendil-works/pi-ai/oauth");
		return oauthModule;
	} catch {
		return null;
	}
}

function getAuthStorage(): AuthStorage | null {
	try {
		if (!authStorage) {
			authStorage = AuthStorage.create(getAuthPath());
		}
		authStorage.reload();
		return authStorage;
	} catch {
		return null;
	}
}

async function getProviderApiKey(providerId: string): Promise<string | null> {
	const storage = getAuthStorage();
	if (!storage) {
		return null;
	}
	try {
		const apiKey = await storage.getApiKey(providerId, { includeFallback: false });
		return typeof apiKey === "string" && apiKey.trim().length > 0 ? apiKey.trim() : null;
	} catch {
		return null;
	}
}

async function refreshProviderToken(authKey: string, entry: PiAuthEntry, allAuth: PiAuthMap): Promise<string | null> {
	const oauth = await getOAuthModule();
	if (!oauth) {
		return null;
	}

	try {
		const credentials: Record<string, OAuthCredentials> = {};
		for (const [key, value] of Object.entries(allAuth)) {
			if (
				value.type === "oauth" &&
				typeof value.access === "string" &&
				typeof value.refresh === "string" &&
				typeof value.expires === "number"
			) {
				credentials[key] = {
					...value,
					access: value.access,
					refresh: value.refresh,
					expires: value.expires,
				};
			}
		}

		const result = await oauth.getOAuthApiKey(authKey, credentials);
		if (!result || typeof result.apiKey !== "string") {
			return null;
		}

		const updated: PiAuthEntry = {
			...entry,
			...(result.newCredentials as Partial<PiAuthEntry>),
		};
		persistAuthEntry(authKey, updated);

		let token = result.apiKey;
		try {
			const parsed = JSON.parse(token) as { token?: unknown };
			if (typeof parsed.token === "string" && parsed.token.trim().length > 0) {
				token = parsed.token;
			}
		} catch {
			// Token is not JSON encoded.
		}

		return token.trim() || null;
	} catch {
		return null;
	}
}

async function ensureFreshToken(authKey: string, entry: PiAuthEntry, allAuth: PiAuthMap): Promise<string | null> {
	const access = typeof entry.access === "string" ? entry.access.trim() : "";
	const expires = typeof entry.expires === "number" ? entry.expires : 0;
	if (access && (expires <= 0 || Date.now() < expires)) {
		return access;
	}
	if (entry.type !== "oauth") {
		if (access) {
			return access;
		}
		const resolved = await getProviderApiKey(authKey);
		if (resolved) {
			return resolved;
		}
		const key = typeof entry.key === "string" ? entry.key.trim() : "";
		return key || null;
	}
	return refreshProviderToken(authKey, entry, allAuth);
}

function maybeAddOpenAIWhamWindow(
	result: ProviderRateLimits,
	groupLabel: string,
	windowLabel: string,
	window: unknown,
): void {
	if (!(window && typeof window === "object")) {
		return;
	}

	const typed = window as Record<string, unknown>;
	const usedPercent = parseFiniteNumber(typed.used_percent);
	if (usedPercent === null) {
		return;
	}

	const windowSeconds = parseFiniteNumber(typed.limit_window_seconds);
	const roundedWindowSeconds = windowSeconds !== null && windowSeconds > 0 ? Math.round(windowSeconds) : null;
	const labelSuffix = roundedWindowSeconds ? windowLabelFromSeconds(roundedWindowSeconds) : windowLabel;
	const resetFromDuration = countdownFromSeconds(typed.reset_after_seconds);
	const resetAtSeconds = parseFiniteNumber(typed.reset_at);
	const resetFromTimestamp = resetAtSeconds === null ? null : countdownFromSeconds(resetAtSeconds - Date.now() / 1000);

	result.windows.push({
		label: `${groupLabel} (${labelSuffix})`,
		percentLeft: clampPercent(100 - usedPercent),
		resetDescription: resetFromDuration ?? resetFromTimestamp,
		windowMinutes: roundedWindowSeconds ? Math.max(1, Math.round(roundedWindowSeconds / 60)) : null,
	});
}

function maybeAddOpenAIRateLimitGroup(result: ProviderRateLimits, groupLabel: string, group: unknown): void {
	if (!(group && typeof group === "object")) {
		return;
	}
	const typed = group as Record<string, unknown>;

	if (typed.allowed === false) {
		result.note = appendNote(result.note, `${groupLabel} currently blocked.`);
	}
	if (typed.limit_reached === true) {
		result.note = appendNote(result.note, `${groupLabel} limit reached.`);
	}

	maybeAddOpenAIWhamWindow(result, groupLabel, "primary", typed.primary_window);
	maybeAddOpenAIWhamWindow(result, groupLabel, "secondary", typed.secondary_window);
}

function hydrateOpenAIFromJwt(result: ProviderRateLimits, token: string): { accountId: string | null } {
	const jwt = decodeJwtPayload(token);
	if (!jwt) {
		return { accountId: null };
	}

	const profile = jwt["https://api.openai.com/profile"] as { email?: unknown } | undefined;
	if (typeof profile?.email === "string") {
		result.account = profile.email;
	}

	const auth = jwt["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
	if (typeof auth?.chatgpt_plan_type === "string") {
		result.plan = auth.chatgpt_plan_type;
	}

	const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : null;
	return { accountId };
}

async function probeOpenAIDirect(token: string): Promise<ProviderRateLimits> {
	const result: ProviderRateLimits = {
		provider: "openai",
		windows: [],
		credits: null,
		account: null,
		plan: null,
		note: null,
		error: null,
	};

	const { accountId } = hydrateOpenAIFromJwt(result, token);

	try {
		const headers: Record<string, string> = {
			authorization: `Bearer ${token}`,
			accept: "application/json",
		};
		if (accountId) {
			headers["chatgpt-account-id"] = accountId;
		}

		const response = await fetch(OPENAI_USAGE_ENDPOINT, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});

		if (response.status === 401) {
			result.error = "OpenAI auth token expired — run pi login openai-codex.";
			return result;
		}
		if (response.status === 429) {
			const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
			const retryHint = Number.isFinite(retryAfter) ? ` (retry in ${fmtDuration(Math.max(0, retryAfter) * 1000)})` : "";
			result.note = `OpenAI usage endpoint is rate-limited${retryHint}.`;
			return result;
		}
		if (!response.ok) {
			result.note = `OpenAI usage endpoint returned ${response.status}.`;
			return result;
		}

		const payload = (await response.json()) as Record<string, unknown>;
		if (typeof payload.plan_type === "string") {
			result.plan = payload.plan_type;
		}
		if (typeof payload.email === "string") {
			result.account = payload.email;
		}

		const credits = payload.credits;
		if (credits && typeof credits === "object") {
			const typedCredits = credits as { unlimited?: unknown; balance?: unknown };
			if (typedCredits.unlimited === true) {
				result.note = appendNote(result.note, "Credits are unlimited.");
			} else {
				const balance = parseFiniteNumber(typedCredits.balance);
				if (balance !== null) {
					result.credits = balance;
				}
			}
		}

		maybeAddOpenAIRateLimitGroup(result, "Codex", payload.rate_limit);
		maybeAddOpenAIRateLimitGroup(result, "Code Review", payload.code_review_rate_limit);

		const additionalRateLimits = payload.additional_rate_limits;
		if (Array.isArray(additionalRateLimits)) {
			for (const item of additionalRateLimits) {
				if (!(item && typeof item === "object")) {
					continue;
				}
				const typedItem = item as Record<string, unknown>;
				const label =
					typeof typedItem.limit_name === "string"
						? typedItem.limit_name
						: typeof typedItem.metered_feature === "string"
							? typedItem.metered_feature
							: "Additional";
				maybeAddOpenAIRateLimitGroup(result, label, typedItem.rate_limit);
			}
		}

		if (result.windows.length === 0) {
			result.note = appendNote(result.note, "OpenAI response did not include window data.");
		}
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			result.error = "OpenAI usage probe timed out.";
		} else {
			result.error = error instanceof Error ? error.message : String(error);
		}
	}

	return result;
}

function findOpenAIAuth(auth: PiAuthMap): { authKey: string; entry: PiAuthEntry } | null {
	for (const key of OPENAI_AUTH_KEYS) {
		const entry = auth[key];
		if (entry) {
			return { authKey: key, entry };
		}
	}
	return null;
}

function formatOpenAISection(limits: ProviderRateLimits): string[] {
	const lines: string[] = [];
	lines.push("OpenAI Codex:");

	if (limits.error) {
		lines.push(`  Error: ${limits.error}`);
	}

	const windows = [...limits.windows].sort((a, b) => a.percentLeft - b.percentLeft);
	if (windows.length === 0 && !limits.error) {
		lines.push("  Quota windows: unavailable");
	}
	for (const window of windows) {
		const reset = window.resetDescription ? `, resets ${window.resetDescription}` : "";
		lines.push(`  ${window.label}: ${window.percentLeft.toFixed(0)}% left${reset}`);
	}

	if (limits.plan) {
		lines.push(`  Plan: ${limits.plan}`);
	}
	if (limits.account) {
		lines.push(`  Account: ${limits.account}`);
	}
	if (limits.credits !== null) {
		lines.push(`  Credits: ${limits.credits.toFixed(2)}`);
	}
	if (limits.note) {
		lines.push(`  Note: ${limits.note}`);
	}

	return lines;
}

function modelLooksLikeZai(ctx: ExtensionContext): boolean {
	const modelProvider = typeof (ctx.model as { provider?: unknown } | undefined)?.provider === "string"
		? String((ctx.model as { provider?: unknown }).provider).toLowerCase()
		: "";
	const modelId = ctx.model?.id?.toLowerCase() ?? "";
	return modelProvider.includes("zai") || modelId.includes("zai");
}

function getZaiAuthHeaderVariants(token: string): string[] {
	const trimmed = token.trim();
	if (!trimmed) {
		return [];
	}
	if (/^bearer\s+/i.test(trimmed)) {
		return [trimmed];
	}
	return [trimmed, `Bearer ${trimmed}`];
}

async function fetchZaiWithAuth(url: string, token: string): Promise<Response> {
	const variants = getZaiAuthHeaderVariants(token);
	if (variants.length === 0) {
		throw new Error("Missing z.ai API key");
	}

	let lastResponse: Response | null = null;
	for (let index = 0; index < variants.length; index += 1) {
		const authValue = variants[index];
		const response = await fetch(url, {
			method: "GET",
			headers: {
				authorization: authValue,
				"content-type": "application/json",
				accept: "application/json",
				"user-agent": "my-pi-usage/1.0",
			},
			signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
		});
		lastResponse = response;
		if (response.status !== 401 && response.status !== 403) {
			return response;
		}
	}

	if (!lastResponse) {
		throw new Error("z.ai request failed before receiving a response");
	}
	return lastResponse;
}

function maybeAddZaiQuotaWindow(result: ZaiRateLimits, limit: unknown): void {
	if (!(limit && typeof limit === "object")) {
		return;
	}

	const typed = limit as ZaiQuotaLimitItem;
	const limitType = typeof typed.type === "string" ? typed.type.toUpperCase() : "";
	const total = parseFiniteNumber(typed.usage);
	const used = parseFiniteNumber(typed.currentValue);
	const reportedPercent = parseFiniteNumber(typed.percentage);

	const usedPercent =
		reportedPercent !== null
			? reportedPercent
			: total !== null && total > 0 && used !== null
				? (used / total) * 100
				: null;
	if (usedPercent === null) {
		return;
	}

	let label = "Quota";
	if (limitType === "TOKENS_LIMIT") {
		label = "Tokens";
	} else if (limitType === "TIME_LIMIT") {
		label = "MCP searches";
	}
	if (total !== null && used !== null) {
		label += ` (${Math.round(used).toLocaleString()}/${Math.round(total).toLocaleString()})`;
	}

	const nextResetTime = parseFiniteNumber(typed.nextResetTime);
	const resetDescription =
		nextResetTime !== null
			? nextResetTime <= Date.now()
				? "now"
				: `in ${fmtDuration(nextResetTime - Date.now())}`
			: null;

	result.windows.push({
		label,
		percentLeft: clampPercent(100 - usedPercent),
		resetDescription,
		windowMinutes: limitType === "TOKENS_LIMIT" ? 300 : null,
	});
}

async function probeZaiDirect(token: string): Promise<ZaiRateLimits> {
	const result: ZaiRateLimits = {
		provider: "zai",
		windows: [],
		modelCount: null,
		note: null,
		error: null,
	};

	try {
		const quotaResponse = await fetchZaiWithAuth(ZAI_QUOTA_ENDPOINT, token);
		if (quotaResponse.status === 401 || quotaResponse.status === 403) {
			result.error = "z.ai API key rejected — check ZAI_API_KEY or auth.json provider \"zai\".";
			return result;
		}
		if (quotaResponse.status === 429) {
			const retryAfter = Number.parseInt(quotaResponse.headers.get("retry-after") ?? "", 10);
			const retryHint = Number.isFinite(retryAfter) ? ` (retry in ${fmtDuration(Math.max(0, retryAfter) * 1000)})` : "";
			result.note = `z.ai quota endpoint is rate-limited${retryHint}.`;
		}
		if (!quotaResponse.ok) {
			const body = (await quotaResponse.text()).trim();
			const detail = body ? ` ${body.slice(0, 200)}` : "";
			result.error = `z.ai quota endpoint returned ${quotaResponse.status}.${detail}`;
			return result;
		}

		const quotaPayload = (await quotaResponse.json()) as ZaiQuotaResponse;
		const success = quotaPayload.success === true;
		const code = parseFiniteNumber(quotaPayload.code);
		if (!success || code !== 200) {
			const message = typeof quotaPayload.msg === "string" ? quotaPayload.msg : "Unknown z.ai error";
			result.error = `z.ai quota query failed (${code ?? "?"}): ${message}`;
			return result;
		}

		const limitsRaw = quotaPayload.data?.limits;
		const limits = Array.isArray(limitsRaw) ? limitsRaw : [];
		for (const limit of limits) {
			maybeAddZaiQuotaWindow(result, limit);
		}
		if (result.windows.length === 0) {
			result.note = appendNote(result.note, "z.ai quota response did not include usable window data.");
		}
	} catch (error) {
		if (error instanceof Error && error.name === "TimeoutError") {
			result.error = "z.ai quota probe timed out.";
		} else {
			result.error = error instanceof Error ? error.message : String(error);
		}
		return result;
	}

	try {
		const modelsResponse = await fetchZaiWithAuth(ZAI_MODELS_ENDPOINT, token);
		if (modelsResponse.ok) {
			const payload = (await modelsResponse.json()) as { data?: unknown };
			if (Array.isArray(payload.data)) {
				result.modelCount = payload.data.length;
			}
		}
	} catch {
		// Model count is optional enrichment.
	}

	return result;
}

function formatZaiSection(limits: ZaiRateLimits): string[] {
	const lines: string[] = ["z.ai:"];

	if (limits.error) {
		lines.push(`  Error: ${limits.error}`);
	}

	const windows = [...limits.windows].sort((a, b) => a.percentLeft - b.percentLeft);
	if (windows.length === 0 && !limits.error) {
		lines.push("  Quota windows: unavailable");
	}
	for (const window of windows) {
		const reset = window.resetDescription ? `, resets ${window.resetDescription}` : "";
		lines.push(`  ${window.label}: ${window.percentLeft.toFixed(0)}% left${reset}`);
	}

	if (limits.modelCount !== null) {
		lines.push(`  Models visible: ${limits.modelCount}`);
	}
	if (limits.note) {
		lines.push(`  Note: ${limits.note}`);
	}

	return lines;
}

async function buildZaiStatus(auth: PiAuthMap, ctx: ExtensionContext): Promise<string[]> {
	const hasZaiEnv = typeof process.env[ZAI_ENV_KEY] === "string" && process.env[ZAI_ENV_KEY]!.trim().length > 0;
	const hasZaiAuthEntry = Boolean(auth[ZAI_PROVIDER_KEY]);
	const apiKey = await getProviderApiKey(ZAI_PROVIDER_KEY);

	if (!apiKey) {
		const lines: string[] = ["z.ai:"];
		if (hasZaiEnv || hasZaiAuthEntry) {
			lines.push("  Configured, but API key could not be resolved.");
			lines.push(`  Check ${ZAI_ENV_KEY} and ~/.pi/agent/auth.json entry \"${ZAI_PROVIDER_KEY}\".`);
		} else {
			lines.push(`  Not configured (set ${ZAI_ENV_KEY} or add auth.json provider \"${ZAI_PROVIDER_KEY}\").`);
		}
		if (modelLooksLikeZai(ctx)) {
			lines.push("  Active model appears to be z.ai.");
		}
		return lines;
	}

	const limits = await probeZaiDirect(apiKey);
	const lines = formatZaiSection(limits);
	if (modelLooksLikeZai(ctx) && !limits.error) {
		lines.push("  Active model: z.ai");
	}
	return lines;
}

function collectSessionTotals(ctx: ExtensionContext): { input: number; output: number; cost: number; turns: number } {
	let input = 0;
	let output = 0;
	let cost = 0;
	let turns = 0;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "assistant") {
			continue;
		}
		const usage = entry.message.usage;
		input += Number(usage.input) || 0;
		output += Number(usage.output) || 0;
		cost += Number(usage.cost.total) || 0;
		turns += 1;
	}

	return { input, output, cost, turns };
}

export default function usageExtension(pi: ExtensionAPI): void {
	pi.registerCommand("usage", {
		description: "Show OpenAI Codex and z.ai quota status",
		handler: async (_args, ctx) => {
			const auth = readPiAuth();
			const lines: string[] = ["Provider usage / quota status", ""];

			const openAiAuth = findOpenAIAuth(auth);
			if (!openAiAuth) {
				lines.push("OpenAI Codex:");
				lines.push("  Not configured (run: pi login openai-codex)");
			} else {
				const token = await ensureFreshToken(openAiAuth.authKey, openAiAuth.entry, auth);
				if (!token) {
					lines.push("OpenAI Codex:");
					lines.push("  Auth token unavailable/expired (run: pi login openai-codex)");
				} else {
					const limits = await probeOpenAIDirect(token);
					lines.push(...formatOpenAISection(limits));
				}
			}

			lines.push("");
			lines.push(...(await buildZaiStatus(auth, ctx)));

			const totals = collectSessionTotals(ctx);
			lines.push("");
			lines.push(
				`Session totals: ${totals.turns} turns, ${totals.input.toLocaleString()} in / ${totals.output.toLocaleString()} out, $${totals.cost.toFixed(3)}`,
			);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
