import { produce } from "immer";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import { admitMutationBatch } from "@/lib/doc/mutationAdmission";
import { applyMutations } from "@/lib/doc/mutations";
import { blueprintDocSchema } from "@/lib/domain/blueprint";

export interface CanonicalMutationSuffixRow {
	readonly seq: string;
	readonly batch_id: string;
	readonly actor_id: string;
	readonly kind: string;
	readonly mutations: unknown;
}

export interface CanonicalMutationFoldInput {
	readonly baselineSnapshot: unknown;
	readonly baselineSeq: string;
	readonly expectedHeadSeq: string | number;
	readonly suffix: readonly CanonicalMutationSuffixRow[];
}

export interface CanonicalMutationFoldResult {
	readonly snapshot: ReturnType<typeof toPersistableDoc>;
	readonly headSeq: string;
	readonly batches: number;
	readonly mutations: number;
}

const ACCEPTED_MUTATION_KINDS = new Set([
	"autosave",
	"mcp",
	"chat",
	"migration",
]);

/**
 * Strictly replay a post-baseline accepted-mutation suffix through the same
 * schema and reducer that admit and apply runtime commits.
 *
 * The canonical-identity migration injects this authority only when auditing
 * an already-applied database. Its legacy transform remains timestamp-frozen;
 * the post-horizon suffix deliberately follows the current steady-state
 * contract, so there is one reducer rather than a migration-private dialect
 * that can drift from what runtime actually persisted.
 */
export function replayCanonicalMutationSuffix(
	input: CanonicalMutationFoldInput,
): CanonicalMutationFoldResult {
	const parsedBaseline = blueprintDocSchema.parse(input.baselineSnapshot);
	let folded = hydratePersistedBlueprint(parsedBaseline);
	let expectedSeq = BigInt(input.baselineSeq);
	let mutationCount = 0;

	for (const row of input.suffix) {
		expectedSeq += BigInt(1);
		if (
			BigInt(row.seq) !== expectedSeq ||
			row.batch_id.length === 0 ||
			row.actor_id.length === 0 ||
			!ACCEPTED_MUTATION_KINDS.has(row.kind)
		) {
			throw new Error("invalid post-horizon mutation envelope");
		}
		const mutations = admitMutationBatch(row.mutations);
		if (mutations.length === 0) {
			throw new Error(
				"only the referenced fold baseline marker may carry an empty mutation batch",
			);
		}
		mutationCount += mutations.length;
		folded = produce(folded, (draft) => {
			applyMutations(draft, mutations);
		});
	}

	if (expectedSeq !== BigInt(input.expectedHeadSeq)) {
		throw new Error("post-horizon mutation sequence does not reach app head");
	}

	const snapshot = toPersistableDoc(folded);
	// Reparse the result at the same strict domain boundary as a stored
	// baseline. A reducer bug may otherwise create a JSON-shaped value that
	// happens to digest but is not a canonical PersistableDoc.
	blueprintDocSchema.parse(snapshot);
	return {
		snapshot,
		headSeq: expectedSeq.toString(),
		batches: input.suffix.length,
		mutations: mutationCount,
	};
}
