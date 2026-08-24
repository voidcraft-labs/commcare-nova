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

export interface ModuleHandleBinding {
	readonly handle: string;
	readonly uuid: string;
	readonly entityKind: string;
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

function boundModuleUuid(
	handles: readonly ModuleHandleBinding[],
	handle: string,
): string | null {
	const binding = handles.find((entry) => entry.handle === handle);
	return binding?.entityKind === "module" ? binding.uuid : null;
}

/** Resolve the exact durable module handle assigned to an accepted
 * composition. Display text is never the identity, so equal-name/equal-host
 * compositions remain distinct; finalization separately proves semantics. */
export function realizedModuleUuid(
	doc: BlueprintDoc,
	brief: SliceExecutionBrief,
	compositionId: string,
	handles: readonly ModuleHandleBinding[],
): Uuid | null {
	const realization = realizationFor(brief, compositionId);
	if (realization === undefined) return null;
	const moduleUuid = boundModuleUuid(
		handles,
		realization.blueprintModuleHandle,
	);
	if (moduleUuid === null) return null;
	return doc.modules[moduleUuid]?.uuid ?? null;
}

export function acceptedModulePlacementIssues(
	doc: BlueprintDoc,
	brief: SliceExecutionBrief,
	handles: readonly ModuleHandleBinding[],
): AcceptedModulePlacementIssue[] {
	const issues: AcceptedModulePlacementIssue[] = [];
	for (const realization of brief.moduleRealizations) {
		const semanticCandidates = semanticModuleUuids(
			doc,
			brief,
			realization.compositionId,
		);
		/* Every accepted composition must resolve through its exact durable
		 * handle. Construction-group coverage cannot substitute for this check:
		 * an executor may materialize other mutations while omitting this module. */
		const moduleUuid = realizedModuleUuid(
			doc,
			brief,
			realization.compositionId,
			handles,
		);
		const semanticMatch =
			moduleUuid !== null && semanticCandidates.includes(moduleUuid);
		const expectedParentUuid =
			realization.parentModuleCompositionId === null
				? null
				: realizedModuleUuid(
						doc,
						brief,
						realization.parentModuleCompositionId,
						handles,
					);
		const expectedAfterUuid =
			realization.afterSiblingModuleCompositionId === null
				? null
				: realizedModuleUuid(
						doc,
						brief,
						realization.afterSiblingModuleCompositionId,
						handles,
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
			semanticMatch &&
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
					? `Accepted module composition ${realization.compositionId} does not resolve through its exact module handle ${realization.blueprintModuleHandle}.`
					: !semanticMatch
						? `Module ${moduleUuid} resolved through ${realization.blueprintModuleHandle}, but its name or record host does not match accepted composition ${realization.compositionId}.`
						: `Module ${moduleUuid} is not in the accepted parent and sibling position. Move it to the exact menu placement in the execution brief.`,
			location: {
				kind: "module",
				moduleUuid: moduleUuid ?? semanticCandidates[0] ?? "",
			},
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
