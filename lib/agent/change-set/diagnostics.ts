/**
 * Change-set diagnostics — the REAL whole-document evaluator run over the
 * private candidate, with stable finding identity for introduced/resolved
 * deltas and the `canCommit` derivation.
 *
 * Diagnostics are advisory until canonical commit: a private candidate MAY
 * carry gating findings (that is the point of private staging), and nothing
 * here redefines validity — the kernel's absolute gate at commit is the one
 * authority. Full findings are never persisted per step; receipts carry the
 * compact fingerprint summary and `inspect` recomputes current details.
 */

import type { DesignId } from "@/lib/agent/design/ids";
import type { ValidationError } from "@/lib/commcare/validator/errors";
import { mutationCommitVerdict } from "@/lib/doc/commitVerdicts";
import type { LookupValidationContext } from "@/lib/doc/lookupReferences";
import type { BlueprintDoc, PersistableDoc } from "@/lib/domain";
import { canonicalJsonDigest } from "./digest";
import type { ReadSetStatus } from "./readSets";
import type { ChangeSetDiagnosticsSummary } from "./schemas";
import type { ChangeSetStep, DesignChangeSet } from "./types";

/**
 * Stable identity for one validator finding: code + scope + location +
 * details, deliberately EXCLUDING the message (wording changes must not
 * read as a new finding). 16 hex chars — comparison identity, not a
 * cryptographic commitment.
 */
export function findingFingerprint(finding: ValidationError): string {
	return canonicalJsonDigest({
		code: finding.code,
		scope: finding.scope,
		location: finding.location,
		details: finding.details ?? null,
	}).slice(0, 16);
}

/** Run the absolute whole-document evaluator over the private candidate —
 *  an empty-batch verdict, so admission cannot interfere. */
export function evaluateOverlayFindings(
	overlay: BlueprintDoc,
	lookupContext: LookupValidationContext,
): ValidationError[] {
	const verdict = mutationCommitVerdict(overlay, [], lookupContext);
	return verdict.ok ? [] : verdict.findings;
}

export interface ChangeSetDiagnostics {
	readonly snapshotRevision: number;
	readonly candidateDigest: string;
	readonly allFindings: readonly ValidationError[];
	/** Boundary-only findings that prevent genesis finalization. They are also
	 * included in `allFindings`; the separate field keeps the phase explicit. */
	readonly finalizationFindings: readonly ValidationError[];
	/** Fingerprints of findings present now but not in the prior summary. */
	readonly introducedSincePreviousStep: readonly string[];
	/** Fingerprints present in the prior summary but resolved now. A resolved
	 * finding's full body is not recomputable from compact receipts, so the
	 * delta speaks fingerprint identity. */
	readonly resolvedSincePreviousStep: readonly string[];
	readonly readSetStatus: readonly ReadSetStatus[];
	readonly sliceIntentCoverage: readonly {
		readonly intentId: DesignId;
		readonly stepCount: number;
	}[];
	readonly canCommit: boolean;
}

export function computeChangeSetDiagnostics(args: {
	readonly changeSet: Pick<
		DesignChangeSet,
		"kind" | "revision" | "exclusiveKind"
	>;
	readonly overlaySnapshot: PersistableDoc;
	readonly overlay: BlueprintDoc;
	readonly findings: readonly ValidationError[];
	readonly finalizationFindings: readonly ValidationError[];
	readonly steps: readonly ChangeSetStep[];
	readonly readSetStatus: readonly ReadSetStatus[];
	readonly previousFingerprints: readonly string[];
}): ChangeSetDiagnostics {
	const findings = [...args.findings, ...args.finalizationFindings];
	const fingerprints = findings.map(findingFingerprint);
	const previous = new Set(args.previousFingerprints);
	const current = new Set(fingerprints);
	const introduced = fingerprints.filter((print) => !previous.has(print));
	const resolved = [...previous].filter((print) => !current.has(print));

	const coverage = new Map<DesignId, number>();
	for (const step of args.steps) {
		for (const intentId of step.intentIds) {
			coverage.set(intentId, (coverage.get(intentId) ?? 0) + 1);
		}
	}

	const readSetsCurrent = args.readSetStatus.every(
		(status) => status.state === "current",
	);

	return {
		snapshotRevision: args.changeSet.revision,
		candidateDigest: canonicalJsonDigest(args.overlaySnapshot),
		allFindings: findings,
		finalizationFindings: args.finalizationFindings,
		introducedSincePreviousStep: introduced,
		resolvedSincePreviousStep: resolved,
		readSetStatus: args.readSetStatus,
		sliceIntentCoverage: [...coverage.entries()]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([intentId, stepCount]) => ({ intentId, stepCount })),
		canCommit:
			findings.length === 0 && readSetsCurrent && args.steps.length > 0,
	};
}

/** The compact summary a stage receipt persists. */
export function summarizeDiagnostics(
	diagnostics: ChangeSetDiagnostics,
): ChangeSetDiagnosticsSummary {
	return {
		candidateDigest: diagnostics.candidateDigest,
		findingCount: diagnostics.allFindings.length,
		findingFingerprints: diagnostics.allFindings.map(findingFingerprint).sort(),
		canCommit: diagnostics.canCommit,
	};
}
