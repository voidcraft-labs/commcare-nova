import type { BlueprintDoc } from "./blueprint";
import type { Uuid } from "./uuid";

export const BLUEPRINT_AUTHORED_IDENTITY_KINDS = [
	"module",
	"form",
	"field",
	"selectOption",
	"caseListColumn",
	"searchInput",
	"caseOperation",
	"formLink",
	"userProperty",
	"userType",
	"persona",
	"organizationLevel",
	"locationProperty",
	"automation",
	"automationCriterion",
	"automationSetupOnlyCriterion",
	"automationUpdate",
	"automationRecipient",
	"automationEvent",
	"automationUserDataFilter",
] as const;

export type BlueprintAuthoredIdentityKind =
	(typeof BLUEPRINT_AUTHORED_IDENTITY_KINDS)[number];

export interface BlueprintAuthoredIdentity {
	readonly uuid: Uuid;
	readonly kind: BlueprintAuthoredIdentityKind;
	/** UUID of the entity that structurally owns a nested identity. */
	readonly ownerUuid?: Uuid;
}

/**
 * Enumerate every Nova-authored identity stored inside one Blueprint.
 *
 * The order is stable and follows the document's structural collections. It
 * deliberately includes nested identities: options, case-list columns,
 * Search inputs, and case operations are SA/MCP targets and reference leaves,
 * so allowing one of them to collide with another authored object would make a
 * UUID address kind-dependent instead of globally unambiguous.
 */
export function authoredBlueprintIdentities(
	doc: BlueprintDoc,
): BlueprintAuthoredIdentity[] {
	const identities: BlueprintAuthoredIdentity[] = [];
	for (const module of Object.values(doc.modules)) {
		identities.push({ uuid: module.uuid, kind: "module" });
		for (const column of module.caseListConfig?.columns ?? []) {
			identities.push({
				uuid: column.uuid,
				kind: "caseListColumn",
				ownerUuid: module.uuid,
			});
		}
		for (const input of module.caseListConfig?.searchInputs ?? []) {
			identities.push({
				uuid: input.uuid,
				kind: "searchInput",
				ownerUuid: module.uuid,
			});
		}
	}
	for (const form of Object.values(doc.forms)) {
		identities.push({ uuid: form.uuid, kind: "form" });
		for (const operation of form.caseOperations ?? []) {
			identities.push({
				uuid: operation.uuid,
				kind: "caseOperation",
				ownerUuid: form.uuid,
			});
		}
		for (const link of form.formLinks ?? []) {
			identities.push({
				uuid: link.uuid,
				kind: "formLink",
				ownerUuid: form.uuid,
			});
		}
	}
	for (const field of Object.values(doc.fields)) {
		identities.push({ uuid: field.uuid, kind: "field" });
		if ("optionsSource" in field && field.optionsSource.kind === "inline") {
			for (const option of field.optionsSource.options) {
				identities.push({
					uuid: option.uuid,
					kind: "selectOption",
					ownerUuid: field.uuid,
				});
			}
		}
	}
	for (const property of Object.values(doc.userProperties ?? {})) {
		identities.push({ uuid: property.uuid, kind: "userProperty" });
	}
	for (const userType of Object.values(doc.userTypes ?? {})) {
		identities.push({ uuid: userType.uuid, kind: "userType" });
	}
	for (const persona of Object.values(doc.personas ?? {})) {
		identities.push({ uuid: persona.uuid, kind: "persona" });
	}
	for (const level of Object.values(doc.organizationLevels ?? {})) {
		identities.push({ uuid: level.uuid, kind: "organizationLevel" });
	}
	for (const property of Object.values(doc.locationProperties ?? {})) {
		identities.push({ uuid: property.uuid, kind: "locationProperty" });
	}
	for (const automation of Object.values(doc.automations ?? {})) {
		identities.push({ uuid: automation.uuid, kind: "automation" });
		for (const criterion of automation.criteria) {
			identities.push({
				uuid: criterion.uuid,
				kind: "automationCriterion",
				ownerUuid: automation.uuid,
			});
		}
		for (const criterion of automation.setupOnlyCriteria) {
			identities.push({
				uuid: criterion.uuid,
				kind: "automationSetupOnlyCriterion",
				ownerUuid: automation.uuid,
			});
		}
		if (automation.kind === "case-update") {
			for (const update of automation.updates) {
				identities.push({
					uuid: update.uuid,
					kind: "automationUpdate",
					ownerUuid: automation.uuid,
				});
			}
		} else {
			for (const recipient of automation.recipients) {
				identities.push({
					uuid: recipient.uuid,
					kind: "automationRecipient",
					ownerUuid: automation.uuid,
				});
			}
			for (const event of automation.schedule.events) {
				identities.push({
					uuid: event.uuid,
					kind: "automationEvent",
					ownerUuid: automation.uuid,
				});
			}
			for (const filter of automation.userDataFilters) {
				identities.push({
					uuid: filter.uuid,
					kind: "automationUserDataFilter",
					ownerUuid: automation.uuid,
				});
			}
		}
	}
	return identities;
}

export function findAuthoredBlueprintIdentity(
	doc: BlueprintDoc,
	uuid: Uuid,
): BlueprintAuthoredIdentity | undefined {
	return authoredBlueprintIdentities(doc).find(
		(identity) => identity.uuid === uuid,
	);
}
