/**
 * Payload-safe shape summaries of persisted model messages, shared by the
 * anatomy's recorded views and the design-session CLI inspector.
 */

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
 * A payload-safe context ledger summary: role, part count, and byte size,
 * never customer content.
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
