/**
 * What changes between two moments of one role, by item identity.
 *
 * The diff is structural: an item is added, removed, replaced, or kept,
 * judged by a digest of its content. There is deliberately no character
 * diff of prompt text: the question this answers is "what does the model
 * receive here that it did not receive there", and that is a list of items.
 */

import { canonicalJsonDigest } from "@/lib/utils/canonicalJson";
import type { ContextItem, Moment } from "./types";

export type DiffStatus = "added" | "removed" | "replaced" | "kept";

export interface DiffEntry {
	readonly id: string;
	readonly label: string;
	readonly kind: ContextItem["kind"];
	readonly status: DiffStatus;
}

export interface MomentDiff {
	readonly baseline: { readonly id: string; readonly label: string };
	readonly selected: { readonly id: string; readonly label: string };
	/** Selected-moment order first, then items only the baseline had. */
	readonly entries: readonly DiffEntry[];
	readonly counts: Readonly<Record<DiffStatus, number>>;
}

/** The content an item is compared by. Labels, notes, and sources are
 * presentation and do not make two items different. */
export function itemContentDigest(item: ContextItem): string {
	switch (item.kind) {
		case "system":
			return canonicalJsonDigest({ kind: item.kind, text: item.text });
		case "tools":
			return canonicalJsonDigest({
				kind: item.kind,
				tools: item.tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
					strict: tool.strict ?? null,
					allowed: tool.allowed ?? null,
				})),
			});
		case "output-schema":
			return canonicalJsonDigest({
				kind: item.kind,
				jsonSchema: item.jsonSchema,
				strict: item.strict,
			});
		case "message":
			return canonicalJsonDigest({
				kind: item.kind,
				wireRole: item.wireRole,
				message: item.message,
				cacheBoundary: item.cacheBoundary ?? false,
			});
		case "compaction":
			return canonicalJsonDigest({ kind: item.kind });
		case "missing":
			return canonicalJsonDigest({
				kind: item.kind,
				needs: item.needs,
				explanation: item.explanation,
			});
	}
}

export function diffMoments(baseline: Moment, selected: Moment): MomentDiff {
	const before = new Map(baseline.items.map((item) => [item.id, item]));
	const after = new Map(selected.items.map((item) => [item.id, item]));
	const entries: DiffEntry[] = [];
	for (const item of selected.items) {
		const prior = before.get(item.id);
		const status: DiffStatus =
			prior === undefined
				? "added"
				: itemContentDigest(prior) === itemContentDigest(item)
					? "kept"
					: "replaced";
		entries.push({ id: item.id, label: item.label, kind: item.kind, status });
	}
	for (const item of baseline.items) {
		if (!after.has(item.id)) {
			entries.push({
				id: item.id,
				label: item.label,
				kind: item.kind,
				status: "removed",
			});
		}
	}
	const counts: Record<DiffStatus, number> = {
		added: 0,
		removed: 0,
		replaced: 0,
		kept: 0,
	};
	for (const entry of entries) counts[entry.status] += 1;
	return {
		baseline: { id: baseline.id, label: baseline.label },
		selected: { id: selected.id, label: selected.label },
		entries,
		counts,
	};
}
