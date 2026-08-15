/**
 * Change-set digest vocabulary over the shared canonical-JSON discipline
 * (`lib/utils/canonicalJson.ts` — code-point-sorted keys, SHA-256 hex,
 * JS-only domain).
 *
 * Every change-set identity uses it: `base_snapshot_digest`,
 * `input_digest`, `mutation_digest`, `committed_snapshot_digest`, finding
 * fingerprints.
 */

export {
	canonicalJsonDigest,
	canonicalJsonText,
} from "@/lib/utils/canonicalJson";

import { canonicalJsonDigest as digest } from "@/lib/utils/canonicalJson";

/** The private-workspace call protocol version, hashed into every input digest
 *  so a future protocol change cannot silently replay old receipts. */
export const WORKSPACE_CALL_PROTOCOL_VERSION = 1;

/**
 * A private-workspace call's input digest: the caller's ACTUAL request — computed
 * over the raw projected input BEFORE handle resolution, so a retry compares
 * what the caller sent, while the stored mutation digest proves the resolved
 * canonical result.
 */
export function workspaceCallInputDigest(args: {
	readonly toolName: string;
	readonly expectedWorkspaceRevision: number;
	readonly projectedInput: unknown;
}): string {
	return digest({
		workspaceCallProtocolVersion: WORKSPACE_CALL_PROTOCOL_VERSION,
		toolName: args.toolName,
		expectedWorkspaceRevision: args.expectedWorkspaceRevision,
		projectedInput: args.projectedInput,
	});
}
