import type { Mutation } from "@/lib/doc/types";
import {
	type Automation,
	authoredBlueprintIdentities,
	type BlueprintAuthoredIdentity,
	type BlueprintAuthoredIdentityKind,
	type BlueprintDoc,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { assertNever } from "@/lib/utils/assertNever";

export interface MutationIdentityAdmissionIssue {
	readonly mutationIndex: number;
	readonly mutationKind: Mutation["kind"];
	readonly uuid: Uuid;
	readonly existingKind: BlueprintAuthoredIdentityKind;
	readonly incomingKind: BlueprintAuthoredIdentityKind;
}

function nestedModuleIdentities(
	module: Extract<Mutation, { kind: "addModule" }>["module"],
): BlueprintAuthoredIdentity[] {
	return [
		{ uuid: module.uuid, kind: "module" },
		...(module.caseListConfig?.columns ?? []).map((column) => ({
			uuid: column.uuid,
			kind: "caseListColumn" as const,
			ownerUuid: module.uuid,
		})),
		...(module.caseListConfig?.searchInputs ?? []).map((input) => ({
			uuid: input.uuid,
			kind: "searchInput" as const,
			ownerUuid: module.uuid,
		})),
	];
}

function nestedFormIdentities(
	form: Extract<Mutation, { kind: "addForm" }>["form"],
): BlueprintAuthoredIdentity[] {
	return [
		{ uuid: form.uuid, kind: "form" },
		...(form.caseOperations ?? []).map((operation) => ({
			uuid: operation.uuid,
			kind: "caseOperation" as const,
			ownerUuid: form.uuid,
		})),
	];
}

function nestedAutomationIdentities(
	automation: Automation,
): BlueprintAuthoredIdentity[] {
	return [
		{ uuid: automation.uuid, kind: "automation" },
		...automation.criteria.map((criterion) => ({
			uuid: criterion.uuid,
			kind: "automationCriterion" as const,
			ownerUuid: automation.uuid,
		})),
		...automation.setupOnlyCriteria.map((criterion) => ({
			uuid: criterion.uuid,
			kind: "automationSetupOnlyCriterion" as const,
			ownerUuid: automation.uuid,
		})),
		...(automation.kind === "case-update"
			? automation.updates.map((update) => ({
					uuid: update.uuid,
					kind: "automationUpdate" as const,
					ownerUuid: automation.uuid,
				}))
			: [
					...automation.recipients.map((recipient) => ({
						uuid: recipient.uuid,
						kind: "automationRecipient" as const,
						ownerUuid: automation.uuid,
					})),
					...automation.schedule.events.map((event) => ({
						uuid: event.uuid,
						kind: "automationEvent" as const,
						ownerUuid: automation.uuid,
					})),
					...automation.userDataFilters.map((filter) => ({
						uuid: filter.uuid,
						kind: "automationUserDataFilter" as const,
						ownerUuid: automation.uuid,
					})),
				]),
	];
}

type AutomationItemCollection = Extract<
	Mutation,
	{ kind: "editAutomationItem" }
>["edit"]["collection"];

function automationItemIdentityKind(
	collection: AutomationItemCollection,
): BlueprintAuthoredIdentityKind {
	return collection === "criterion"
		? "automationCriterion"
		: collection === "setup-only-criterion"
			? "automationSetupOnlyCriterion"
			: collection === "update"
				? "automationUpdate"
				: collection === "recipient"
					? "automationRecipient"
					: collection === "user-data-filter"
						? "automationUserDataFilter"
						: "automationEvent";
}

function automationEditIdentity(
	mutation: Extract<Mutation, { kind: "editAutomationItem" }>,
): BlueprintAuthoredIdentity | undefined {
	const edit = mutation.edit;
	if (edit.operation !== "add") return undefined;
	return {
		uuid: edit.value.uuid,
		kind: automationItemIdentityKind(edit.collection),
		ownerUuid: mutation.automationUuid,
	};
}

function inlineOptionIdentities(
	ownerUuid: Uuid,
	source: unknown,
): BlueprintAuthoredIdentity[] {
	if (
		typeof source !== "object" ||
		source === null ||
		!("kind" in source) ||
		source.kind !== "inline" ||
		!("options" in source) ||
		!Array.isArray(source.options)
	) {
		return [];
	}
	return source.options.flatMap((option) => {
		if (
			typeof option !== "object" ||
			option === null ||
			!("uuid" in option) ||
			typeof option.uuid !== "string"
		) {
			return [];
		}
		const uuid = uuidSchema.safeParse(option.uuid);
		if (!uuid.success) return [];
		return [
			{
				uuid: uuid.data,
				kind: "selectOption" as const,
				ownerUuid,
			},
		];
	});
}

interface MutationIdentityClaim {
	readonly identity: BlueprintAuthoredIdentity;
	/**
	 * An atomic collection replacement can carry identities already owned by
	 * that same collection owner. This is preservation, not creation. No other
	 * mutation gets this exception.
	 */
	readonly preserveIfOwnedBy?: Uuid;
}

interface OwnedIdentityScope {
	readonly kind: BlueprintAuthoredIdentityKind;
	readonly ownerUuid: Uuid;
}

interface OwnedIdentityReplacement extends OwnedIdentityScope {
	readonly retainedUuids: ReadonlySet<Uuid>;
}

interface OwnedIdentityRemoval extends OwnedIdentityScope {
	readonly uuid: Uuid;
}

/**
 * Whole-collection mutations preserve only the identities still present in
 * their final payload. Keep that semantic separate from their claims: an
 * omitted child is a removal even though the replacement mutation carries no
 * explicit remove arm for it.
 */
function ownedIdentityReplacementBy(
	mutation: Mutation,
): OwnedIdentityReplacement | undefined {
	switch (mutation.kind) {
		case "updateField": {
			if (!("optionsSource" in mutation.patch)) return undefined;
			return {
				kind: "selectOption",
				ownerUuid: mutation.uuid,
				retainedUuids: new Set(
					inlineOptionIdentities(
						mutation.uuid,
						mutation.patch.optionsSource,
					).map((identity) => identity.uuid),
				),
			};
		}
		case "setAutomationSchedule":
			return {
				kind: "automationEvent",
				ownerUuid: mutation.uuid,
				retainedUuids: new Set(
					mutation.schedule.events.map((event) => event.uuid),
				),
			};
		default:
			return undefined;
	}
}

/** Explicit child removals that can precede a same-owner collection replace. */
function ownedIdentityRemovalBy(
	mutation: Mutation,
): OwnedIdentityRemoval | undefined {
	switch (mutation.kind) {
		case "removeOption":
			return {
				uuid: mutation.uuid,
				kind: "selectOption",
				ownerUuid: mutation.fieldUuid,
			};
		case "editAutomationItem":
			return mutation.edit.operation === "remove"
				? {
						uuid: mutation.edit.uuid,
						kind: automationItemIdentityKind(mutation.edit.collection),
						ownerUuid: mutation.automationUuid,
					}
				: undefined;
		default:
			return undefined;
	}
}

function createClaims(
	identities: readonly BlueprintAuthoredIdentity[],
): MutationIdentityClaim[] {
	return identities.map((identity) => ({ identity }));
}

function identitiesClaimedBy(mutation: Mutation): MutationIdentityClaim[] {
	switch (mutation.kind) {
		case "addModule":
			return createClaims(nestedModuleIdentities(mutation.module));
		case "addForm":
			return createClaims(nestedFormIdentities(mutation.form));
		case "addField":
			return createClaims([
				{ uuid: mutation.field.uuid, kind: "field" },
				...("optionsSource" in mutation.field
					? inlineOptionIdentities(
							mutation.field.uuid,
							mutation.field.optionsSource,
						)
					: []),
			]);
		case "convertField":
			return createClaims(
				inlineOptionIdentities(mutation.uuid, mutation.optionsSource),
			);
		case "updateField":
			return "optionsSource" in mutation.patch
				? inlineOptionIdentities(
						mutation.uuid,
						mutation.patch.optionsSource,
					).map((identity) => ({
						identity,
						preserveIfOwnedBy: mutation.uuid,
					}))
				: [];
		case "addOption":
			return createClaims([
				{
					uuid: mutation.option.uuid,
					kind: "selectOption",
					ownerUuid: mutation.fieldUuid,
				},
			]);
		case "addColumn":
			return createClaims([
				{
					uuid: mutation.column.uuid,
					kind: "caseListColumn",
					ownerUuid: mutation.moduleUuid,
				},
			]);
		case "addSearchInput":
			return createClaims([
				{
					uuid: mutation.searchInput.uuid,
					kind: "searchInput",
					ownerUuid: mutation.moduleUuid,
				},
			]);
		case "addUserProperty":
			return createClaims([
				{ uuid: mutation.property.uuid, kind: "userProperty" },
			]);
		case "addUserType":
			return createClaims([{ uuid: mutation.userType.uuid, kind: "userType" }]);
		case "addPersona":
			return createClaims([{ uuid: mutation.persona.uuid, kind: "persona" }]);
		case "addOrganizationLevel":
			return createClaims([
				{ uuid: mutation.level.uuid, kind: "organizationLevel" },
			]);
		case "addLocationProperty":
			return createClaims([
				{ uuid: mutation.property.uuid, kind: "locationProperty" },
			]);
		case "addAutomation":
			return createClaims(nestedAutomationIdentities(mutation.automation));
		case "editAutomationItem": {
			const identity = automationEditIdentity(mutation);
			return identity === undefined ? [] : createClaims([identity]);
		}
		case "setAutomationSchedule":
			return mutation.schedule.events.map((event) => ({
				identity: {
					uuid: event.uuid,
					kind: "automationEvent",
					ownerUuid: mutation.uuid,
				},
				preserveIfOwnedBy: mutation.uuid,
			}));
		case "updateForm":
			return mutation.caseOperationChange?.operation === "add"
				? createClaims([
						{
							uuid: mutation.caseOperationChange.value.uuid,
							kind: "caseOperation",
							ownerUuid: mutation.uuid,
						},
					])
				: [];
		case "removeModule":
		case "moveModule":
		case "renameModule":
		case "updateModule":
		case "setModuleMedia":
		case "removeForm":
		case "moveForm":
		case "renameForm":
		case "setFormMedia":
		case "removeField":
		case "moveField":
		case "setFieldMedia":
		case "removeOption":
		case "moveOption":
		case "updateOption":
		case "removeColumn":
		case "moveColumn":
		case "updateColumn":
		case "removeSearchInput":
		case "moveSearchInput":
		case "updateSearchInput":
		case "removeUserProperty":
		case "updateUserProperty":
		case "removeUserType":
		case "updateUserType":
		case "removePersona":
		case "updatePersona":
		case "removeOrganizationLevel":
		case "updateOrganizationLevel":
		case "removeLocationProperty":
		case "updateLocationProperty":
		case "updateAutomation":
		case "removeAutomation":
		case "moveAutomation":
		case "updateAutomationSchedule":
		case "setAppName":
		case "setConnectType":
		case "setAppLogo":
		case "relabelSourceLanguage":
		case "addLanguage":
		case "updateLanguage":
		case "removeLanguage":
		case "setDefaultLanguage":
		case "setTranslation":
		case "reviewTranslation":
		case "renameCaseProperties":
		case "declareCaseType":
		case "retireCaseType":
		case "addCaseProperty":
		case "setCaseProperty":
		case "removeCaseProperty":
		case "setCaseTypeMeta":
		case "setCaseListMeta":
			return [];
		default:
			return assertNever(mutation, "identitiesClaimedBy");
	}
}

/**
 * Reject any attempted authored-identity reuse against the current document,
 * an earlier creator in the same batch, or another nested entity in the same
 * payload. Removed identities remain reserved for the batch: delete/recreate
 * is not an identity-preserving edit.
 */
export function mutationIdentityAdmissionIssue(
	doc: BlueprintDoc,
	mutations: readonly Mutation[],
): MutationIdentityAdmissionIssue | undefined {
	const seen = new Map<Uuid, BlueprintAuthoredIdentity>();
	for (const identity of authoredBlueprintIdentities(doc)) {
		seen.set(identity.uuid, identity);
	}
	const live = new Map(seen);
	const removedInBatch = new Set<Uuid>();
	const claimedInBatch = new Set<Uuid>();
	for (const [mutationIndex, mutation] of mutations.entries()) {
		const replacement = ownedIdentityReplacementBy(mutation);
		if (replacement !== undefined) {
			for (const identity of live.values()) {
				if (
					identity.kind === replacement.kind &&
					identity.ownerUuid === replacement.ownerUuid &&
					!replacement.retainedUuids.has(identity.uuid)
				) {
					live.delete(identity.uuid);
					removedInBatch.add(identity.uuid);
				}
			}
		}
		const removal = ownedIdentityRemovalBy(mutation);
		if (removal !== undefined) {
			const identity = live.get(removal.uuid);
			if (
				identity?.kind === removal.kind &&
				identity.ownerUuid === removal.ownerUuid
			) {
				live.delete(removal.uuid);
				removedInBatch.add(removal.uuid);
			}
		}
		for (const claim of identitiesClaimedBy(mutation)) {
			const { identity } = claim;
			const existing = seen.get(identity.uuid);
			const liveExisting = live.get(identity.uuid);
			const preservesOwnedIdentity =
				existing !== undefined &&
				liveExisting !== undefined &&
				!claimedInBatch.has(identity.uuid) &&
				!removedInBatch.has(identity.uuid) &&
				claim.preserveIfOwnedBy !== undefined &&
				existing.kind === identity.kind &&
				liveExisting.kind === identity.kind &&
				existing.ownerUuid === claim.preserveIfOwnedBy &&
				liveExisting.ownerUuid === claim.preserveIfOwnedBy &&
				identity.ownerUuid === claim.preserveIfOwnedBy;
			if (existing !== undefined && !preservesOwnedIdentity) {
				return {
					mutationIndex,
					mutationKind: mutation.kind,
					uuid: identity.uuid,
					existingKind: existing.kind,
					incomingKind: identity.kind,
				};
			}
			claimedInBatch.add(identity.uuid);
			seen.set(identity.uuid, identity);
			live.set(identity.uuid, identity);
		}
	}
	return undefined;
}
