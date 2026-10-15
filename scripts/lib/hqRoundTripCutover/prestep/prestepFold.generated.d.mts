/** One `app_changes` row after a fold baseline, its mutations as stored text. */
export interface PrestepFoldSuffixRow {
	readonly seq: string | number;
	readonly batch_id: string;
	readonly run_id: string | null;
	readonly actor_id: string;
	readonly kind: string;
	readonly mutationsText: string;
	readonly from_project_id: string | null;
	readonly to_project_id: string | null;
}

export interface PrestepFoldInput {
	readonly baselineSnapshotText: string;
	readonly baselineSeq: string | number;
	readonly baselineProjectId: string;
	readonly targetSeq: string | number;
	readonly suffix: readonly PrestepFoldSuffixRow[];
}

export interface PrestepFoldResult {
	/** The pre-step persistable document at `targetSeq`, in the pre-step shape. */
	readonly snapshot: unknown;
	readonly projectId: string;
	readonly headSeq: string;
	readonly batches: number;
	readonly mutations: number;
}

/**
 * The pre-step `foldCanonicalAppChangeSuffixBounded`: admits every envelope of
 * the contiguous suffix after one fold baseline in the pre-step dialect, then
 * reduces it with the pre-step reducer, following project moves. Throws on a
 * gap, a fold baseline inside the suffix, an unknown kind, a mutation the
 * pre-step dialect does not hold, or a suffix that does not reach `targetSeq`.
 */
export function foldCanonicalAppChangeSuffixBounded(
	input: PrestepFoldInput,
): PrestepFoldResult;
