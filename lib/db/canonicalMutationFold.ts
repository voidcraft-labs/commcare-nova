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

/**
 * Input for the gate-free bounded fold: identical suffix admission and
 * replay, bounded at ANY target sequence rather than the app head, with no
 * final lookup-context gate — the change-set base loader's contract
 * (`lib/agent/change-set/baseLoader.ts`). A historical Blueprint replays as
 * exact mutation reduction; checking it against today's mutable lookup
 * definitions would be dishonest (see the module header), and the bounded
 * caller proves identity through its recorded base digest instead.
 */
export interface BoundedCanonicalAppChangeFoldInput {
	readonly baselineSnapshotText: string;
	readonly baselineSeq: string | number;
	readonly baselineProjectId: string;
	/** The exact sequence the fold must reach — the recorded base sequence. */
	readonly targetSeq: string | number;
	readonly suffix: readonly CanonicalAppChangeSuffixRow[];
}

function requireNonblankProjectId(value: string, context: string): string {
	if (value.trim().length === 0) {
		throw new Error(`${context} must be nonblank.`);
	}
	return value;
}

interface FoldSuffixCoreResult {
	readonly folded: ReturnType<typeof hydratePersistedBlueprint>;
	readonly foldedProjectId: string;
	readonly endSeq: number;
	readonly mutationCount: number;
}

/**
 * The shared fold core: strictly admit the contiguous suffix after one
 * immutable fold baseline, then replay it as exact mutation reduction,
 * tracking Project moves. Every envelope and mutation body is admitted
 * before reduction begins — a malformed later envelope must not be hidden
 * behind an earlier reducer failure.
 */
function foldSuffixCore(input: {
	readonly baselineSnapshotText: string;
	readonly baselineSeq: string | number;
	readonly baselineProjectId: string;
	readonly targetSeq: string | number;
	readonly targetSeqContext: string;
	readonly suffix: readonly CanonicalAppChangeSuffixRow[];
}): FoldSuffixCoreResult {
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
	let expectedSeq = safePersistedSequence(
		input.baselineSeq,
		"app_change_fold_baselines.seq",
	);
	let mutationCount = 0;
	const admitted: AdmittedDurableAppChange[] = [];

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
		safePersistedSequence(input.targetSeq, input.targetSeqContext)
	) {
		throw new Error("canonical app-change suffix does not reach its target.");
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

	return { folded, foldedProjectId, endSeq: expectedSeq, mutationCount };
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
	const core = foldSuffixCore({
		baselineSnapshotText: input.baselineSnapshotText,
		baselineSeq: input.baselineSeq,
		baselineProjectId: input.baselineProjectId,
		targetSeq: input.expectedHeadSeq,
		targetSeqContext: "apps.mutation_seq at canonical app-change head",
		suffix: input.suffix,
	});

	if (core.foldedProjectId !== expectedFinalProjectId) {
		throw new Error(
			"canonical app-change fold does not reach the app's final Project.",
		);
	}

	const snapshot = toPersistableDoc(core.folded);
	blueprintDocSchema.parse(snapshot);
	const finalVerdict = evaluateCommit({
		nextDoc: core.folded,
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
		projectId: core.foldedProjectId,
		headSeq: String(core.endSeq),
		batches: input.suffix.length,
		mutations: core.mutationCount,
	};
}

/**
 * The gate-free bounded fold: identical strict suffix admission and exact
 * replay, ending at ANY recorded target sequence. Returns the schema-parsed
 * snapshot and the Project the fold arrived in; the caller proves identity
 * against its recorded base digest. Deliberately NO lookup-context gate —
 * a historical Blueprint passed the absolute gate when it committed, and
 * today's mutable definitions cannot honestly re-judge it.
 */
export function foldCanonicalAppChangeSuffixBounded(
	input: BoundedCanonicalAppChangeFoldInput,
): CanonicalAppChangeFoldResult {
	const core = foldSuffixCore({
		baselineSnapshotText: input.baselineSnapshotText,
		baselineSeq: input.baselineSeq,
		baselineProjectId: input.baselineProjectId,
		targetSeq: input.targetSeq,
		targetSeqContext: "design_change_sets.base_seq",
		suffix: input.suffix,
	});
	const snapshot = toPersistableDoc(core.folded);
	blueprintDocSchema.parse(snapshot);
	return {
		snapshot,
		projectId: core.foldedProjectId,
		headSeq: String(core.endSeq),
		batches: input.suffix.length,
		mutations: core.mutationCount,
	};
}
