/**
 * The fold tripwire for the Firestore→Postgres cutover scripts.
 *
 * `accepted_mutations` is permanent, ordered history: folding every batch from
 * an app's genesis reproduces its `blueprint_entities` rows
 * (`lib/db/types.ts`'s invariant). This helper runs that fold through the SAME
 * reducer the app uses (`applyMutations`) and compares the result to the
 * entity-row snapshot, so a cutover that carried the mutations but corrupted
 * their relationship to the entities is caught.
 *
 * Genesis is an EMPTY doc: the chat build path creates an app empty and commits
 * everything as batches (`app/api/chat/route.ts`), so a chat-built app with its
 * full history retained folds from empty to its snapshot exactly. Two shapes
 * legitimately DON'T fold from empty, and both are TOLERATED (classified
 * `incomplete`, never a failure):
 *   - a TEMPLATE/blank or MCP app born with seed entities (its genesis base is
 *     the seed, not empty), and
 *   - an app whose old Firestore `acceptedMutations` ring was TTL-pruned, so the
 *     retained batches don't reach genesis.
 * Only a reducer that THROWS mid-fold is a real anomaly (the reducers are total
 * by design, so a throw means genuinely unreplayable stored mutations) — that
 * is the `error` outcome the callers surface.
 *
 * Deleted in a follow-up commit with the rest of the cutover scripts.
 */

import { produce } from "immer";
import { toPersistableDoc } from "@/lib/doc/fieldParent";
import { applyMutations } from "@/lib/doc/mutations";
import type { BlueprintDoc, Mutation } from "@/lib/doc/types";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import { stableStringify } from "./firestoreRest";

/** The empty in-memory doc a chat-built app is born as (`createApp`). */
export function emptyBlueprintDoc(appId: string): BlueprintDoc {
	return {
		appId,
		appName: "",
		connectType: null,
		caseTypes: null,
		modules: {},
		forms: {},
		fields: {},
		moduleOrder: [],
		formOrder: {},
		fieldOrder: {},
		fieldParent: {},
	};
}

export type FoldOutcome =
	/** fold(batches) from empty genesis reproduced the entity-row snapshot. */
	| { kind: "verified" }
	/** Diverged — pruned ring or a seeded/template genesis. Tolerated. */
	| { kind: "incomplete" }
	/** A batch threw while replaying — genuinely unreplayable stored mutations. */
	| { kind: "error"; message: string };

/**
 * Fold `batches` (ordered by seq) onto an empty genesis doc and classify the
 * result against `expectedStable` (the `stableStringify` of the entity-row
 * blueprint). A reducer throw is `error`; a structurally-invalid or divergent
 * fold is `incomplete` (pruned/seeded); an exact match is `verified`.
 */
export function foldReproducesSnapshot(
	appId: string,
	batches: Mutation[][],
	expectedStable: string,
): FoldOutcome {
	let folded: BlueprintDoc;
	try {
		folded = produce(emptyBlueprintDoc(appId), (draft) => {
			for (const muts of batches) applyMutations(draft, muts);
		});
	} catch (err) {
		return {
			kind: "error",
			message: err instanceof Error ? err.message : String(err),
		};
	}
	// A pruned/seeded fold can produce a structurally-incomplete doc; a parse
	// failure there means "not reconstructable from empty", i.e. incomplete —
	// NOT the same class as a reducer throw.
	let normalizedStable: string;
	try {
		normalizedStable = stableStringify(
			blueprintDocSchema.parse(toPersistableDoc(folded)),
		);
	} catch {
		return { kind: "incomplete" };
	}
	return normalizedStable === expectedStable
		? { kind: "verified" }
		: { kind: "incomplete" };
}

/** Extract a seq-ordered list of mutation batches from decoded
 *  `acceptedMutations` docs (each doc's `mutations` array, sorted by `seq`). */
export function batchesFromAcceptedMutations(
	docs: Array<{ data: Record<string, unknown> }>,
): Mutation[][] {
	return docs
		.map((d) => ({
			seq: typeof d.data.seq === "number" ? d.data.seq : 0,
			mutations: Array.isArray(d.data.mutations)
				? (d.data.mutations as Mutation[])
				: [],
		}))
		.sort((a, b) => a.seq - b.seq)
		.map((b) => b.mutations);
}
