/**
 * Exact in-memory test writer for tool tests that exercise a real
 * `McpContext` without Postgres.
 *
 * Callers seed the authoritative document before invoking a tool. Each call
 * replays the admitted batch on that document and returns the resulting
 * `committedDoc`; there is deliberately no seq-only or missing-document shape.
 */

import type {
	ApplyBlueprintChangeArgs,
	ApplyBlueprintChangeResult,
} from "@/lib/db/applyBlueprintChange";
import { prepareMutationCandidate } from "@/lib/doc/commitVerdicts";
import type { BlueprintDoc } from "@/lib/domain";

const docs = new Map<string, BlueprintDoc>();
const sequences = new Map<string, number>();

export function seedApplyBlueprintChangeTestWriter(doc: BlueprintDoc): void {
	docs.set(doc.appId, doc);
	sequences.set(doc.appId, 0);
}

export async function commitApplyBlueprintChangeTestBatch(
	args: ApplyBlueprintChangeArgs,
): Promise<ApplyBlueprintChangeResult> {
	const current = docs.get(args.appId);
	if (current === undefined) {
		throw new Error(
			`[applyBlueprintChangeTestWriter] seed app ${args.appId} before committing`,
		);
	}
	const prepared = prepareMutationCandidate(current, args.guard.mutations);
	const seq = (sequences.get(args.appId) ?? 0) + 1;
	docs.set(args.appId, prepared.nextDoc);
	sequences.set(args.appId, seq);
	return { seq, committedDoc: prepared.nextDoc };
}
