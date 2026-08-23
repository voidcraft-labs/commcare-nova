/** Deterministic parity between accepted menu composition and a private candidate. */

import { type BlueprintDoc, moduleSiblingUuids, type Uuid } from "@/lib/domain";
import type { SliceExecutionBrief } from "./executionBrief";

export interface AcceptedModulePlacementIssue {
	readonly code: "ACCEPTED_MODULE_PLACEMENT_MISMATCH";
	readonly message: string;
	readonly location: {
		readonly kind: "module";
		readonly moduleUuid: string;
	};
	readonly details: {
		readonly moduleCompositionId: string;
		readonly acceptedParentModuleCompositionId: string | null;
		readonly acceptedAfterSiblingModuleCompositionId: string | null;
		readonly realizedParentModuleUuid: string | null;
		readonly realizedAfterSiblingModuleUuid: string | null;
	};
}

function realizationFor(brief: SliceExecutionBrief, compositionId: string) {
	return brief.moduleRealizations.find(
		(realization) => realization.compositionId === compositionId,
	);
}

function semanticModuleUuids(
	doc: BlueprintDoc,
	brief: SliceExecutionBrief,
	compositionId: string,
): Uuid[] {
	const composition = brief.moduleCompositions.find(
		(entry) => entry.id === compositionId,
	);
	const realization = realizationFor(brief, compositionId);
	if (composition === undefined || realization === undefined) return [];
	return doc.moduleOrder.filter((moduleUuid) => {
		const module = doc.modules[moduleUuid];
		return (
			module?.name === composition.name &&
			(module.caseType ?? null) ===
				(realization.hostRecord?.blueprintCaseType ?? null)
		);
	});
}

/** Resolve only an unambiguous module that matches the accepted semantic home. */
export function realizedModuleUuid(
	doc: BlueprintDoc,
	brief: SliceExecutionBrief,
	compositionId: string,
): Uuid | null {
	const realization = realizationFor(brief, compositionId);
	if (realization === undefined) return null;
	const candidates = semanticModuleUuids(doc, brief, compositionId).filter(
		(moduleUuid) => {
			const module = doc.modules[moduleUuid];
			if (module === undefined) return false;
			if (realization.parentModuleCompositionId === null) {
				return module.parentModuleUuid === undefined;
			}
			const parentComposition = brief.moduleCompositions.find(
				(entry) => entry.id === realization.parentModuleCompositionId,
			);
			const parentRealization = realizationFor(
				brief,
				realization.parentModuleCompositionId,
			);
			const parent =
				module.parentModuleUuid === undefined
					? undefined
					: doc.modules[module.parentModuleUuid];
			return (
				parent !== undefined &&
				parentComposition !== undefined &&
				parent?.name === parentComposition.name &&
				(parent.caseType ?? null) ===
					(parentRealization?.hostRecord?.blueprintCaseType ?? null)
			);
		},
	);
	return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function acceptedModulePlacementIssues(
	doc: BlueprintDoc,
	brief: SliceExecutionBrief,
): AcceptedModulePlacementIssue[] {
	const issues: AcceptedModulePlacementIssue[] = [];
	for (const realization of brief.moduleRealizations) {
		const semanticCandidates = semanticModuleUuids(
			doc,
			brief,
			realization.compositionId,
		);
		/* Construction-group coverage and ordinary validation own an absent
		 * module. This proof adds only the topology invariant once the accepted
		 * semantic module exists, so it composes with those existing gates. */
		if (semanticCandidates.length === 0) continue;
		const moduleUuid =
			semanticCandidates.length === 1 ? (semanticCandidates[0] ?? null) : null;
		const expectedParentUuid =
			realization.parentModuleCompositionId === null
				? null
				: realizedModuleUuid(doc, brief, realization.parentModuleCompositionId);
		const expectedAfterUuid =
			realization.afterSiblingModuleCompositionId === null
				? null
				: realizedModuleUuid(
						doc,
						brief,
						realization.afterSiblingModuleCompositionId,
					);
		const module = moduleUuid === null ? undefined : doc.modules[moduleUuid];
		const realizedParentUuid = module?.parentModuleUuid ?? null;
		const siblings =
			moduleUuid === null ? [] : moduleSiblingUuids(doc, realizedParentUuid);
		const siblingIndex =
			moduleUuid === null ? -1 : siblings.indexOf(moduleUuid);
		const realizedAfterUuid =
			siblingIndex <= 0 ? null : (siblings[siblingIndex - 1] ?? null);
		const unresolvedExpectedReference =
			(realization.parentModuleCompositionId !== null &&
				expectedParentUuid === null) ||
			(realization.afterSiblingModuleCompositionId !== null &&
				expectedAfterUuid === null);
		if (
			moduleUuid !== null &&
			!unresolvedExpectedReference &&
			realizedParentUuid === expectedParentUuid &&
			realizedAfterUuid === expectedAfterUuid
		) {
			continue;
		}
		issues.push({
			code: "ACCEPTED_MODULE_PLACEMENT_MISMATCH",
			message:
				moduleUuid === null
					? `Accepted module composition ${realization.compositionId} does not resolve to exactly one module in its accepted menu.`
					: `Module ${moduleUuid} is not in the accepted parent and sibling position. Move it to the exact menu placement in the execution brief.`,
			location: { kind: "module", moduleUuid: moduleUuid ?? "" },
			details: {
				moduleCompositionId: realization.compositionId,
				acceptedParentModuleCompositionId:
					realization.parentModuleCompositionId,
				acceptedAfterSiblingModuleCompositionId:
					realization.afterSiblingModuleCompositionId,
				realizedParentModuleUuid: realizedParentUuid,
				realizedAfterSiblingModuleUuid: realizedAfterUuid,
			},
		});
	}
	return issues;
}
