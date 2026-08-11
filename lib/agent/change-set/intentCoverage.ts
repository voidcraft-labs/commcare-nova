import type { DesignId } from "@/lib/agent/design/ids";
import type { ImplementationCoordinate } from "@/lib/agent/design/projection/coordinates";
import type { IntentProvenanceRow } from "@/lib/db/canonicalCommitSidecars";
import type { Mutation } from "@/lib/doc/types";
import type { Uuid } from "@/lib/domain/uuid";
import type { ChangeSetStep, SliceDesignChangeSet } from "./types";

export interface ProvenIntentCoverage {
	readonly owningIntentIds: readonly DesignId[];
	readonly provenance: readonly IntentProvenanceRow[];
}

/** Prove exact construction-group coverage from durable mutation-bearing steps.
 * `intentIds` is the retained private-storage field name. */
export function proveIntentCoverage(args: {
	readonly changeSet: SliceDesignChangeSet;
	readonly steps: readonly ChangeSetStep[];
	readonly expectedOwningIntentIds: readonly DesignId[];
	readonly appId: string;
}): ProvenIntentCoverage {
	const expected = new Set<string>(args.expectedOwningIntentIds);
	const covered = new Set<string>();
	const provenance: IntentProvenanceRow[] = [];
	const provenanceKeys = new Set<string>();

	for (const step of args.steps) {
		if (step.mutations.length === 0 || step.intentIds.length === 0) {
			throw new Error(
				`Staged step ${step.ordinal} must bind its implementation mutations to at least one assigned construction group.`,
			);
		}
		const coordinates = coordinatesForMutations(step.mutations, args.appId);
		for (const intentId of step.intentIds) {
			if (!expected.has(intentId)) {
				throw new Error(
					`Staged step ${step.ordinal} names construction group ${intentId}, which is not assigned to this slice.`,
				);
			}
			covered.add(intentId);
			for (const coordinate of coordinates) {
				const key = `${intentId}:${JSON.stringify(coordinate)}`;
				if (provenanceKeys.has(key)) continue;
				provenanceKeys.add(key);
				provenance.push({
					designSessionId: args.changeSet.designSessionId,
					designRevisionId: args.changeSet.designRevisionId,
					buildPlanId: args.changeSet.buildPlanId,
					sliceId: args.changeSet.sliceId,
					intentId,
					coordinate,
				});
			}
		}
	}

	const missing = args.expectedOwningIntentIds.filter((id) => !covered.has(id));
	if (missing.length > 0) {
		throw new Error(
			`The staged implementation does not cover every construction group assigned to this slice: ${missing.join(", ")}.`,
		);
	}
	return { owningIntentIds: [...args.expectedOwningIntentIds], provenance };
}

function coordinatesForMutations(
	mutations: readonly Mutation[],
	appId: string,
): readonly ImplementationCoordinate[] {
	const coordinates = new Map<string, ImplementationCoordinate>();
	for (const mutation of mutations) {
		const coordinate = coordinateForMutation(mutation, appId);
		coordinates.set(JSON.stringify(coordinate), coordinate);
	}
	return [...coordinates.values()];
}

function coordinateForMutation(
	mutation: Mutation,
	appId: string,
): ImplementationCoordinate {
	switch (mutation.kind) {
		case "addModule":
			return entityCoordinate("module", mutation.module.uuid);
		case "removeModule":
		case "moveModule":
		case "renameModule":
		case "updateModule":
		case "setCaseListMeta":
		case "setModuleMedia":
			return entityCoordinate("module", mutation.uuid);
		case "addSearchInput":
		case "updateSearchInput":
		case "removeSearchInput":
		case "moveSearchInput":
			return entityCoordinate("module", mutation.moduleUuid);

		case "addForm":
			return entityCoordinate("form", mutation.form.uuid);
		case "removeForm":
		case "moveForm":
		case "renameForm":
		case "setFormMedia":
			return entityCoordinate("form", mutation.uuid);
		case "updateForm": {
			const operation =
				mutation.caseOperationChange ?? mutation.caseOperationPatch;
			if (operation !== undefined) {
				const uuid =
					operation.operation === "add" ? operation.value.uuid : operation.uuid;
				return entityCoordinate("case-operation", uuid);
			}
			return entityCoordinate("form", mutation.uuid);
		}

		case "addField":
			return entityCoordinate("field", mutation.field.uuid);
		case "removeField":
		case "moveField":
		case "updateField":
		case "convertField":
			return entityCoordinate("field", mutation.uuid);
		case "addOption":
		case "updateOption":
		case "removeOption":
		case "moveOption":
		case "setFieldMedia":
			return entityCoordinate("field", mutation.fieldUuid);

		case "addColumn":
			return entityCoordinate("case-list-column", mutation.column.uuid);
		case "updateColumn":
		case "removeColumn":
		case "moveColumn":
			return entityCoordinate("case-list-column", mutation.uuid);

		case "addUserType":
			return entityCoordinate("user-type", mutation.userType.uuid);
		case "updateUserType":
		case "removeUserType":
			return entityCoordinate("user-type", mutation.uuid);
		case "addPersona":
			return entityCoordinate("persona", mutation.persona.uuid);
		case "updatePersona":
		case "removePersona":
			return entityCoordinate("persona", mutation.uuid);

		case "addOrganizationLevel":
			return entityCoordinate("organization-level", mutation.level.uuid);
		case "updateOrganizationLevel":
		case "removeOrganizationLevel":
			return entityCoordinate("organization-level", mutation.uuid);
		case "addLocationProperty":
			return entityCoordinate("location-property", mutation.property.uuid);
		case "updateLocationProperty":
		case "removeLocationProperty":
			return entityCoordinate("location-property", mutation.uuid);

		case "addAutomation":
			return entityCoordinate("automation", mutation.automation.uuid);
		case "updateAutomation":
		case "removeAutomation":
		case "moveAutomation":
		case "setAutomationSchedule":
		case "updateAutomationSchedule":
			return entityCoordinate("automation", mutation.uuid);
		case "editAutomationItem":
			return entityCoordinate("automation", mutation.automationUuid);

		case "addCaseProperty":
		case "setCaseProperty":
			return {
				kind: "case-property",
				caseType: mutation.caseType,
				property: mutation.property.name,
			};
		case "removeCaseProperty":
			return {
				kind: "case-property",
				caseType: mutation.caseType,
				property: mutation.property,
			};

		// These mutations either address the app itself or a collection whose
		// closed coordinate vocabulary deliberately has no finer identity.
		default:
			return { kind: "app", appId };
	}
}

function entityCoordinate<
	Kind extends Exclude<
		ImplementationCoordinate["kind"],
		"app" | "case-property" | "external-action"
	>,
>(kind: Kind, uuid: Uuid): Extract<ImplementationCoordinate, { kind: Kind }> {
	return { kind, uuid } as Extract<ImplementationCoordinate, { kind: Kind }>;
}
