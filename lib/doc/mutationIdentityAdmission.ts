import type { Mutation } from "@/lib/doc/types";
import {
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
		case "setAppName":
		case "setConnectType":
		case "setAppLogo":
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
	const claimedInBatch = new Set<Uuid>();
	for (const [mutationIndex, mutation] of mutations.entries()) {
		for (const claim of identitiesClaimedBy(mutation)) {
			const { identity } = claim;
			const existing = seen.get(identity.uuid);
			const preservesOwnedIdentity =
				existing !== undefined &&
				!claimedInBatch.has(identity.uuid) &&
				claim.preserveIfOwnedBy !== undefined &&
				existing.kind === identity.kind &&
				existing.ownerUuid === claim.preserveIfOwnedBy &&
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
		}
	}
	return undefined;
}
