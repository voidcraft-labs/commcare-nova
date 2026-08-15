import { createHash } from "node:crypto";
import type { Event } from "@/lib/log/types";

export interface DesignSessionResolutionMatch {
	readonly sessionId: string;
	readonly reason: string;
	readonly updatedAt: Date | string;
}

export interface DesignSessionResolution {
	readonly selected: DesignSessionResolutionMatch;
	readonly alternatives: readonly DesignSessionResolutionMatch[];
}

/**
 * Pick the newest matching session while preserving the alternatives in the
 * result. App ids can legitimately name several edit sessions; silently
 * discarding that ambiguity would make an inspector look authoritative while
 * showing the wrong run.
 */
export function selectDesignSessionResolution(
	matches: readonly DesignSessionResolutionMatch[],
): DesignSessionResolution | null {
	const bySession = new Map<string, DesignSessionResolutionMatch>();
	for (const match of matches) {
		const existing = bySession.get(match.sessionId);
		if (
			existing === undefined ||
			Date.parse(String(match.updatedAt)) >
				Date.parse(String(existing.updatedAt))
		) {
			bySession.set(match.sessionId, match);
		}
	}
	const ordered = [...bySession.values()].sort(
		(left, right) =>
			Date.parse(String(right.updatedAt)) - Date.parse(String(left.updatedAt)),
	);
	const selected = ordered[0];
	if (selected === undefined) return null;
	return { selected, alternatives: ordered.slice(1) };
}

/** Stable, order-preserving run-id collection for cross-ledger inspection. */
export function collectRunIds(
	...sources: ReadonlyArray<readonly (string | null | undefined)[]>
): string[] {
	const seen = new Set<string>();
	const runIds: string[] = [];
	for (const source of sources) {
		for (const value of source) {
			if (
				value === null ||
				value === undefined ||
				value === "" ||
				seen.has(value)
			)
				continue;
			seen.add(value);
			runIds.push(value);
		}
	}
	return runIds;
}

export function jsonByteLength(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function messageRole(message: Record<string, unknown>): string {
	return typeof message.role === "string"
		? message.role
		: typeof message.type === "string"
			? message.type
			: "message";
}

/**
 * A payload-safe context ledger summary. Full persisted ModelMessages are
 * available behind the explicit --context-content flag; the ordinary view
 * shows shape and byte pressure without spilling customer content.
 */
export function summarizeModelMessage(message: unknown): string {
	if (message === null || typeof message !== "object" || Array.isArray(message))
		return `${typeof message} · ${jsonByteLength(message)} B`;
	const record = message as Record<string, unknown>;
	const role = messageRole(record);
	const kind = typeof record.kind === "string" ? `/${record.kind}` : "";
	const content = record.content;
	const parts = Array.isArray(content)
		? content.length
		: content === undefined
			? 0
			: 1;
	return `${role}${kind} · ${parts} part${parts === 1 ? "" : "s"} · ${jsonByteLength(message)} B`;
}

function compactJson(value: unknown, maxLength = 500): string {
	const json = JSON.stringify(value);
	return json.length <= maxLength ? json : `${json.slice(0, maxLength)}…`;
}

/** One-line event rendering used by the design-session event expansion. */
export function summarizeDesignEvent(event: Event): string {
	if (event.kind === "mutation") {
		return `mutation ${event.stage ?? "(no stage)"} ${compactJson(event.mutation, 240)}`;
	}
	if (event.kind === "archived-mutation") return "archived mutation";
	const payload = event.payload;
	switch (payload.type) {
		case "user-message":
			return `user ${payload.text.replace(/\s+/g, " ").slice(0, 240)}`;
		case "assistant-text":
			return `assistant ${payload.text.replace(/\s+/g, " ").slice(0, 240)}`;
		case "assistant-reasoning":
			return `reasoning ${payload.text.replace(/\s+/g, " ").slice(0, 240)}`;
		case "tool-call":
			return `tool call ${payload.toolName} (${jsonByteLength(payload.input)} B input)`;
		case "tool-result":
			return `tool result ${payload.toolName} (${jsonByteLength(payload.output)} B output)`;
		case "error":
			return `ERROR ${payload.error.type}${payload.error.fatal ? " fatal" : ""}: ${payload.error.message}`;
		case "step-usage":
			return `usage ${payload.inputTokens} in / ${payload.outputTokens} out / ${payload.cacheReadTokens ?? 0} cache read${payload.finishReason === undefined ? "" : ` / ${payload.finishReason}`}`;
		case "design-tool-outcome":
			return `design ${payload.outcome} ${payload.toolName} (${payload.code})`;
		case "executor-tool-outcome":
			return `executor step ${payload.modelStep} ${payload.outcome} ${payload.toolName} (${payload.code})`;
		case "validation-attempt":
			return `validation attempt ${payload.attempt}: ${payload.errors.length} error(s)`;
		case "attachment-prep":
			return `attachment prep ${payload.phase}${payload.count === undefined ? "" : ` (${payload.count})`}`;
	}
}

/**
 * Watch-mode fingerprint. The collector deliberately omits an observation
 * timestamp, so unchanged durable state produces no terminal spam.
 */
export function designSessionSnapshotFingerprint(snapshot: unknown): string {
	return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
