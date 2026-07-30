import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	switch (typeof value) {
		case "string":
		case "boolean":
		case "number":
			return JSON.stringify(value);
		case "object":
			return `{${Object.entries(value as Record<string, unknown>)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
				.join(",")}}`;
		default:
			throw new Error("Mutation fold snapshots must be canonical JSON values.");
	}
}

export function mutationFoldSnapshotDigest(snapshot: unknown): string {
	return createHash("sha256").update(canonicalJson(snapshot)).digest("hex");
}
