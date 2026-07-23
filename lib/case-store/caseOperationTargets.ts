import { z } from "zod";
import { AUTHORED_CASE_ID_VERSION } from "@/lib/domain";

/** Client-originated data. It carries one opaque CommCare identity only,
 * never authority. Case ids are strings by wire contract; S06 widens the
 * current UUID-backed storage family before this dormant seam activates. */
export const caseOperationTargetRequestSchema = z
	.object({ caseId: z.string().min(1) })
	.strict();

export type CaseOperationTargetRequest = z.infer<
	typeof caseOperationTargetRequestSchema
>;

/** Server-resolved row facts loaded under the app's tenant boundary. */
export const caseOperationTargetDescriptorSchema = z
	.object({
		caseId: z.string().min(1),
		caseType: z.string().min(1),
		projectId: z.string().min(1),
	})
	.strict();

export type CaseOperationTargetDescriptor = z.infer<
	typeof caseOperationTargetDescriptorSchema
>;

export type CaseOperationTargetVerdict =
	| { readonly ok: true; readonly descriptor: CaseOperationTargetDescriptor }
	| {
			readonly ok: false;
			readonly reason: "not-found-or-out-of-scope" | "case-type-mismatch";
	  };

/**
 * Re-authorize a runtime target against server-owned Project and immutable
 * pre-submission type facts. A later operation may have a different rolling
 * semantic type after retype; callers obtain this lookup type from the shared
 * case-operation order analysis rather than substituting `operation.caseType`.
 * The client request and the resolved row are deliberately separate
 * arguments: callers must load `resolved` from the case store and cannot make
 * a client-asserted `{ projectId, caseType }` object authoritative by passing
 * it through this helper. Parse failure, absence, an id mismatch, and foreign
 * tenancy collapse to the same result so this boundary cannot be used as a
 * cross-Project id oracle.
 */
export function validateCaseOperationTargetDescriptor(
	request: unknown,
	resolved: unknown,
	expected: { readonly projectId: string; readonly snapshotCaseType: string },
): CaseOperationTargetVerdict {
	const parsedRequest = caseOperationTargetRequestSchema.safeParse(request);
	const parsedResolved =
		caseOperationTargetDescriptorSchema.safeParse(resolved);
	if (
		!parsedRequest.success ||
		!parsedResolved.success ||
		parsedResolved.data.caseId !== parsedRequest.data.caseId ||
		parsedResolved.data.projectId !== expected.projectId
	) {
		return { ok: false, reason: "not-found-or-out-of-scope" };
	}
	if (parsedResolved.data.caseType !== expected.snapshotCaseType) {
		return { ok: false, reason: "case-type-mismatch" };
	}
	return { ok: true, descriptor: parsedResolved.data };
}

export interface ResolvedCaseOperationTypeTarget {
	readonly caseId: string;
	/** Server-authorized type in the immutable pre-submission snapshot. Absent
	 * only for a genuinely fresh create. */
	readonly snapshotCaseType?: string;
}

export interface ResolvedCaseOperationTypeStep {
	readonly operationUuid: string;
	readonly action: "create" | "update" | "close";
	readonly target: ResolvedCaseOperationTypeTarget;
	readonly expectedCaseType: string;
	readonly resultCaseType?: string;
	readonly links?: readonly {
		readonly slot: string;
		readonly target: ResolvedCaseOperationTypeTarget;
		readonly expectedCaseType: string;
	}[];
}

export type ResolvedCaseOperationTypeSequenceVerdict =
	| { readonly ok: true }
	| {
			readonly ok: false;
			readonly reason: "case-link-target-is-self";
			readonly operationUuid: string;
			readonly slot: `link:${string}`;
			readonly caseId: string;
	  }
	| {
			readonly ok: false;
			readonly reason:
				| "rolling-case-type-mismatch"
				| "authored-key-identity-is-type-stable";
			readonly operationUuid: string;
			readonly slot: "target" | `link:${string}`;
			readonly expectedCaseType: string;
			readonly actualCaseType: string;
	  };

/**
 * Runtime complement to the static alias proof in `caseOperationOrder.ts`.
 *
 * S06 expands repeated operations into actual physical execution order, folds
 * their separately authorized snapshot descriptors through this function,
 * and only then writes. Keying rolling state by the resolved opaque id catches
 * aliases the AST cannot prove (two fields, session vs property expression,
 * duplicate repeat values). Every link is checked for both concrete self-link
 * identity and rolling type before the operation's result type is installed,
 * matching the authored operation's atomic semantics and the XForm guard.
 */
export function validateResolvedCaseOperationTypeSequence(
	steps: readonly ResolvedCaseOperationTypeStep[],
): ResolvedCaseOperationTypeSequenceVerdict {
	const rollingTypes = new Map<string, string>();
	for (const step of steps) {
		const currentType =
			rollingTypes.get(step.target.caseId) ??
			step.target.snapshotCaseType ??
			(step.action === "create" ? step.expectedCaseType : undefined);
		if (currentType !== step.expectedCaseType) {
			return {
				ok: false,
				reason: "rolling-case-type-mismatch",
				operationUuid: step.operationUuid,
				slot: "target",
				expectedCaseType: step.expectedCaseType,
				actualCaseType: currentType ?? "missing",
			};
		}

		for (const link of step.links ?? []) {
			if (link.target.caseId === step.target.caseId) {
				return {
					ok: false,
					reason: "case-link-target-is-self",
					operationUuid: step.operationUuid,
					slot: `link:${link.slot}`,
					caseId: step.target.caseId,
				};
			}
			const linkType =
				rollingTypes.get(link.target.caseId) ?? link.target.snapshotCaseType;
			if (linkType !== link.expectedCaseType) {
				return {
					ok: false,
					reason: "rolling-case-type-mismatch",
					operationUuid: step.operationUuid,
					slot: `link:${link.slot}`,
					expectedCaseType: link.expectedCaseType,
					actualCaseType: linkType ?? "missing",
				};
			}
		}

		const resultType = step.resultCaseType ?? step.expectedCaseType;
		if (
			resultType !== step.expectedCaseType &&
			step.target.caseId.startsWith(`${AUTHORED_CASE_ID_VERSION}:`)
		) {
			return {
				ok: false,
				reason: "authored-key-identity-is-type-stable",
				operationUuid: step.operationUuid,
				slot: "target",
				expectedCaseType: step.expectedCaseType,
				actualCaseType: resultType,
			};
		}
		rollingTypes.set(step.target.caseId, resultType);
	}
	return { ok: true };
}
