import { produce } from "immer";
import { evaluateCommit } from "@/lib/commcare/validator/gate";
import {
	hydratePersistedBlueprint,
	toPersistableDoc,
} from "@/lib/doc/fieldParent";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import { applyMutations } from "@/lib/doc/mutations";
import { blueprintDocSchema } from "@/lib/domain/blueprint";
import {
	nextPersistedSequence,
	safePersistedSequence,
} from "@/lib/utils/persistedSequence";
import {
	type AdmittedDurableAppChange,
	parsePersistedAppChangeEnvelope,
	parsePersistedJsonText,
} from "./persistedJson";

export interface CanonicalAppChangeSuffixRow {
	readonly seq: string | number;
	readonly batch_id: string;
	readonly run_id: string | null;
	readonly actor_id: string;
	readonly kind: string;
	readonly mutationsText: string;
	readonly from_project_id: string | null;
	readonly to_project_id: string | null;
}

export interface CanonicalAppChangeFoldInput {
	readonly baselineSnapshotText: string;
	readonly baselineSeq: string | number;
	readonly baselineProjectId: string;
	readonly expectedHeadSeq: string | number;
	readonly expectedFinalProjectId: string;
	readonly suffix: readonly CanonicalAppChangeSuffixRow[];
	/** Current definitions for the final Project, read in the fold transaction. */
	readonly finalLookupContext: LookupValidationContext;
}

export interface CanonicalAppChangeFoldResult {
	readonly snapshot: ReturnType<typeof toPersistableDoc>;
	readonly projectId: string;
	readonly headSeq: string;
	readonly batches: number;
	readonly mutations: number;
}

function requireNonblankProjectId(value: string, context: string): string {
	if (value.trim().length === 0) {
		throw new Error(`${context} must be nonblank.`);
	}
	return value;
}

/**
 * Strictly replay the contiguous suffix after the greatest immutable
 * app-change fold baseline.
 *
 * Every envelope and mutation body is admitted before reduction begins. The
 * fold starts in the baseline's captured Project, applies exact Project moves
 * in sequence, and checks only the final reconstructed Blueprint against the
 * current definitions of its final Project. Historical intermediate
 * Blueprints cannot honestly be checked against mutable lookup definitions
 * from today.
 */
export function replayCanonicalAppChangeSuffix(
	input: CanonicalAppChangeFoldInput,
): CanonicalAppChangeFoldResult {
	const parsedBaseline = blueprintDocSchema.parse(
		parsePersistedJsonText(
			input.baselineSnapshotText,
			"app_change_fold_baselines.snapshot",
		),
	);
	let folded = hydratePersistedBlueprint(parsedBaseline);
	let foldedProjectId = requireNonblankProjectId(
		input.baselineProjectId,
		"app_change_fold_baselines.project_id",
	);
	const expectedFinalProjectId = requireNonblankProjectId(
		input.expectedFinalProjectId,
		"apps.project_id at canonical app-change head",
	);
	if (
		input.finalLookupContext.kind !== "available" ||
		input.finalLookupContext.projectId !== expectedFinalProjectId
	) {
		throw new Error(
			"canonical app-change fold requires definitions from the app's final Project.",
		);
	}
	let expectedSeq = safePersistedSequence(
		input.baselineSeq,
		"app_change_fold_baselines.seq",
	);
	let mutationCount = 0;
	const admitted: AdmittedDurableAppChange[] = [];

	// Admit the complete durable suffix before applying any row. A malformed
	// later envelope must not be hidden behind an earlier reducer failure.
	for (const row of input.suffix) {
		expectedSeq = nextPersistedSequence(
			expectedSeq,
			"app_changes canonical suffix sequence",
		);
		const change = parsePersistedAppChangeEnvelope(
			{
				seq: row.seq,
				batchId: row.batch_id,
				runId: row.run_id,
				actorId: row.actor_id,
				kind: row.kind,
				mutationsText: row.mutationsText,
				fromProjectId: row.from_project_id,
				toProjectId: row.to_project_id,
			},
			`app_changes row at sequence ${row.seq}`,
		);
		if (change.seq !== expectedSeq) {
			throw new Error("canonical app-change suffix is not contiguous.");
		}
		if (change.kind === "fold-baseline") {
			throw new Error(
				"canonical app-change suffix starts after the greatest fold baseline.",
			);
		}
		mutationCount += change.mutations.length;
		admitted.push(change);
	}

	if (
		expectedSeq !==
		safePersistedSequence(
			input.expectedHeadSeq,
			"apps.mutation_seq at canonical app-change head",
		)
	) {
		throw new Error("canonical app-change suffix does not reach app head.");
	}

	for (const change of admitted) {
		if (change.kind === "project-move") {
			if (foldedProjectId !== change.fromProjectId) {
				throw new Error(
					`project move at sequence ${change.seq} does not start in the folded Project.`,
				);
			}
			foldedProjectId = change.toProjectId;
		}
		if (change.mutations.length > 0) {
			folded = produce(folded, (draft) => {
				applyMutations(draft, change.mutations);
			});
		}
	}

	if (foldedProjectId !== expectedFinalProjectId) {
		throw new Error(
			"canonical app-change fold does not reach the app's final Project.",
		);
	}

	const snapshot = toPersistableDoc(folded);
	blueprintDocSchema.parse(snapshot);
	const finalVerdict = evaluateCommit({
		nextDoc: folded,
		lookupContext: input.finalLookupContext,
	});
	if (!finalVerdict.ok) {
		const codes = [
			...new Set(finalVerdict.findings.map((finding) => finding.code)),
		]
			.sort()
			.join(",");
		throw new Error(
			`canonical app-change fold fails the final absolute commit gate (${codes}).`,
		);
	}

	return {
		snapshot,
		projectId: foldedProjectId,
		headSeq: String(expectedSeq),
		batches: input.suffix.length,
		mutations: mutationCount,
	};
}
