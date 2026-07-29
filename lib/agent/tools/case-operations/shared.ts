/**
 * Shared author vocabulary and identity bridge for case-operation tools.
 *
 * A form is ADDRESSED by `moduleUuid` + `formUuid`, because an address must be
 * something a caller can learn and that survives a rename. What an author
 * reads and writes INSIDE an operation stays author vocabulary: the operation's
 * own slug id (unique by validator rule) and field paths. This module is the
 * only crossing point between those shapes, so chat and MCP cannot drift or
 * leak storage identity into an expression an author has to read.
 */

import { z } from "zod";
import {
	carrierBlindCaseOperationsProjection,
	isDormantCaseOperationUnavailableProjection,
} from "@/lib/agent/dormantCarrierReadProjection";
import { orderedFormUuids } from "@/lib/doc/fieldWalk";
import {
	caseOperationIdVerdict,
	caseOperationLinkIdentifierVerdict,
	caseOperationWritePropertyVerdict,
} from "@/lib/doc/identifierVerdicts";
import {
	computeFieldPath,
	findContainingForm,
} from "@/lib/doc/mutations/helpers";
import {
	asUuid,
	type BlueprintDoc,
	CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
	CASE_OPERATION_IDENTIFIER_REGEX,
	CASE_OPERATION_PROPERTY_FORMAT_MESSAGE,
	CASE_OPERATION_PROPERTY_REGEX,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	orderedCaseOperations,
	RESERVED_CASE_OPERATION_TYPES,
	type Uuid,
	userPropertiesOf,
	userPropertySlugsByUuid,
} from "@/lib/domain";
import {
	type AuthorIdentityProjector,
	type AuthorIdentityResolver,
	authorPredicateSchema,
	authorValueExpressionSchema,
	projectPredicate,
	projectValueExpression,
	resolveAuthorPredicate,
	resolveAuthorValueExpression,
} from "./authorAst";

export { authorPredicateSchema, authorValueExpressionSchema };

const CASE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,254}$/;

const caseTypeInputSchema = z
	.string()
	.regex(
		CASE_TYPE_PATTERN,
		"Case type must start with a letter and use only letters, digits, underscores, or hyphens.",
	)
	.refine(
		(value) => !RESERVED_CASE_OPERATION_TYPES.has(value),
		"That case type is platform-owned and cannot be changed by an authored operation.",
	);

const operationIdInputSchema = z
	.string()
	.regex(
		CASE_OPERATION_IDENTIFIER_REGEX,
		CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
	)
	.refine(
		(value) => !value.startsWith("__nova_"),
		'Operation ids starting with "__nova_" are reserved.',
	);

const propertyInputSchema = z
	.string()
	.regex(CASE_OPERATION_PROPERTY_REGEX, CASE_OPERATION_PROPERTY_FORMAT_MESSAGE)
	.superRefine((value, ctx) => {
		const verdict = caseOperationWritePropertyVerdict(value, new Set());
		if (verdict.ok) return;
		ctx.addIssue({ code: "custom", message: verdict.userMessage });
	});

const linkIdInputSchema = z
	.string()
	.regex(
		CASE_OPERATION_IDENTIFIER_REGEX,
		CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
	)
	.max(255)
	.superRefine((value, ctx) => {
		const verdict = caseOperationLinkIdentifierVerdict(value, new Set());
		if (verdict.ok) return;
		ctx.addIssue({ code: "custom", message: verdict.userMessage });
	});

const newTargetInputSchema = z
	.object({
		kind: z.literal("new"),
		idFrom: z
			.string()
			.min(1)
			.optional()
			.describe(
				"Optional field path whose answer deterministically keys the case",
			),
	})
	.strict();

const operationTargetInputSchema = z
	.object({
		kind: z.literal("operation"),
		operationId: operationIdInputSchema.describe(
			"Id of an earlier create operation in this form",
		),
	})
	.strict();

const sessionTargetInputSchema = z
	.object({ kind: z.literal("session") })
	.strict();

const expressionTargetInputSchema = z
	.object({
		kind: z.literal("expression"),
		expr: authorValueExpressionSchema,
	})
	.strict();

const existingTargetInputSchema = z.discriminatedUnion("kind", [
	operationTargetInputSchema,
	sessionTargetInputSchema,
	expressionTargetInputSchema,
]);

const writeInputSchema = z
	.object({
		property: propertyInputSchema,
		value: authorValueExpressionSchema,
		condition: authorPredicateSchema.optional(),
	})
	.strict();

const linkInputSchema = z
	.object({
		identifier: linkIdInputSchema,
		targetType: caseTypeInputSchema,
		target: existingTargetInputSchema.nullable(),
		relationship: z.enum(["child", "extension"]),
	})
	.strict();

function uniqueMemberNames(
	items: readonly Record<string, unknown>[] | undefined,
	key: string,
	ctx: z.RefinementCtx,
): void {
	const seen = new Set<string>();
	for (const [index, item] of (items ?? []).entries()) {
		const value = item[key];
		if (typeof value !== "string") continue;
		if (seen.has(value)) {
			ctx.addIssue({
				code: "custom",
				path: [index, key],
				message: `"${value}" is used more than once in this operation.`,
			});
		}
		seen.add(value);
	}
}

const createOperationInputSchema = z
	.object({
		id: operationIdInputSchema,
		action: z.literal("create"),
		caseType: caseTypeInputSchema,
		target: newTargetInputSchema,
		condition: authorPredicateSchema.optional(),
		forEach: z
			.string()
			.min(1)
			.optional()
			.describe("Repeat field path; omit to run once per submission"),
		name: authorValueExpressionSchema,
		owner: authorValueExpressionSchema.optional(),
		writes: z.array(writeInputSchema).optional(),
		links: z.array(linkInputSchema).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		uniqueMemberNames(value.writes, "property", ctx);
		uniqueMemberNames(value.links, "identifier", ctx);
	});

const updateOperationInputSchema = z
	.object({
		id: operationIdInputSchema,
		action: z.literal("update"),
		caseType: caseTypeInputSchema,
		target: existingTargetInputSchema,
		condition: authorPredicateSchema.optional(),
		forEach: z
			.string()
			.min(1)
			.optional()
			.describe("Repeat field path; omit to run once per submission"),
		owner: authorValueExpressionSchema.optional(),
		rename: authorValueExpressionSchema.optional(),
		retype: caseTypeInputSchema.optional(),
		writes: z.array(writeInputSchema).optional(),
		links: z.array(linkInputSchema).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		uniqueMemberNames(value.writes, "property", ctx);
		uniqueMemberNames(value.links, "identifier", ctx);
	});

const closeOperationInputSchema = z
	.object({
		id: operationIdInputSchema,
		action: z.literal("close"),
		caseType: caseTypeInputSchema,
		target: existingTargetInputSchema,
		condition: authorPredicateSchema.optional(),
		forEach: z
			.string()
			.min(1)
			.optional()
			.describe("Repeat field path; omit to run once per submission"),
		writes: z.array(writeInputSchema).optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		uniqueMemberNames(value.writes, "property", ctx);
	});

/**
 * Facet legality is structural at the author boundary: each action has its own
 * closed schema, so a create with a session target or a close with an owner/link
 * cannot be sent by chat or MCP.
 */
export const caseOperationInputSchema = z.discriminatedUnion("action", [
	createOperationInputSchema,
	updateOperationInputSchema,
	closeOperationInputSchema,
]);

export type CaseOperationInput = z.infer<typeof caseOperationInputSchema>;

export const operationAddressSchema = z
	.object({
		moduleUuid: z
			.string()
			.min(1)
			.describe("Module uuid, from get_module or search_blueprint"),
		formUuid: z
			.string()
			.min(1)
			.describe("Form uuid, from get_module's form list or search_blueprint"),
	})
	.strict();

export interface OperationAddress {
	readonly moduleUuid: string;
	readonly formUuid: string;
}

export type OperationAddressResolution =
	| {
			readonly ok: true;
			readonly moduleUuid: Uuid;
			readonly formUuid: Uuid;
	  }
	| { readonly ok: false; readonly error: string };

/**
 * Resolve `(moduleUuid, formUuid)` to the form they name.
 *
 * The address is IDENTITY, not a name-derived slug. A slug is minted from the
 * display name at creation and never touched again, so it is a fossil of that
 * name rather than a projection of the object: after one rename it still reads
 * as meaningful and is not. Worse, nothing enforces slug uniqueness
 * (`lib/domain/idSlug.ts` says so outright), so two menus could carry the same
 * one — and picking the first silently wrote to a form the caller never meant
 * while the success message echoed the address it asked for.
 *
 * With uuids that whole class is unrepresentable, which is why there is no
 * ambiguity arm here to word carefully. What remains is the ordinary miss, and
 * the form-not-in-this-module case: a valid form uuid under the wrong module is
 * a caller mistake worth naming rather than quietly accepting, because the two
 * halves address different things and only the form is actually written to.
 */
export function resolveOperationAddress(
	doc: BlueprintDoc,
	address: OperationAddress,
): OperationAddressResolution {
	const moduleUuid = asUuid(address.moduleUuid);
	if (doc.modules[moduleUuid] === undefined) {
		return {
			ok: false,
			error: `No module with uuid "${address.moduleUuid}" is in this app. Module uuids come from get_module or search_blueprint.`,
		};
	}
	const formUuid = asUuid(address.formUuid);
	if (doc.forms[formUuid] === undefined) {
		return {
			ok: false,
			error: `No form with uuid "${address.formUuid}" is in this app. Form uuids come from get_module's form list or search_blueprint.`,
		};
	}
	if (!orderedFormUuids(doc, moduleUuid).includes(formUuid)) {
		return {
			ok: false,
			error: `Form "${doc.forms[formUuid]?.name ?? address.formUuid}" is not in module "${doc.modules[moduleUuid]?.name ?? address.moduleUuid}". Check which menu holds it with get_module.`,
		};
	}
	return { ok: true, moduleUuid, formUuid };
}

export function operationById(
	doc: BlueprintDoc,
	formUuid: Uuid,
	id: string,
): CaseOperation | undefined {
	return (doc.forms[formUuid]?.caseOperations ?? []).find(
		(operation) => operation.id === id,
	);
}

function fieldEntries(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly { readonly uuid: Uuid; readonly path: string }[] {
	const entries: { uuid: Uuid; path: string }[] = [];
	for (const field of Object.values(doc.fields)) {
		if (
			field === undefined ||
			findContainingForm(doc, field.uuid) !== formUuid
		) {
			continue;
		}
		const path = computeFieldPath(doc, field.uuid);
		if (path !== undefined) entries.push({ uuid: field.uuid, path });
	}
	return entries;
}

function identityResolver(
	doc: BlueprintDoc,
	formUuid: Uuid,
): AuthorIdentityResolver {
	const fields = fieldEntries(doc, formUuid);
	return {
		fieldUuid(path) {
			const match = fields.find((field) => field.path === path);
			if (match !== undefined) return match.uuid;
			throw new Error(
				`Field path "${path}" not found in this form. Available paths: ${fields.map((field) => field.path).join(", ") || "none"}.`,
			);
		},
		operationUuid(id) {
			const operation = operationById(doc, formUuid, id);
			if (operation !== undefined) return operation.uuid;
			throw new Error(`Case operation "${id}" not found in this form.`);
		},
		userPropertyUuid(slug) {
			const properties = Object.values(userPropertiesOf(doc));
			const match = properties.find((property) => property.slug === slug);
			if (match !== undefined) return match.uuid;
			throw new Error(
				`Worker information "${slug}" is not set up in this app. Available saved keys: ${properties.map((property) => property.slug).join(", ") || "none"}. Add it with add_user_properties first.`,
			);
		},
	};
}

function identityProjector(
	doc: BlueprintDoc,
	formUuid: Uuid,
): AuthorIdentityProjector {
	const fields = new Map(
		fieldEntries(doc, formUuid).map(({ uuid, path }) => [uuid, path]),
	);
	const operations = new Map(
		(doc.forms[formUuid]?.caseOperations ?? []).map(({ uuid, id }) => [
			uuid,
			id,
		]),
	);
	const userPropertySlugs = userPropertySlugsByUuid(doc);
	return {
		fieldPath: (uuid) => fields.get(uuid),
		operationId: (uuid) => operations.get(uuid),
		userPropertySlug: (uuid) => userPropertySlugs.get(uuid),
	};
}

function resolveTarget(
	target:
		| CaseOperationInput["target"]
		| z.infer<typeof linkInputSchema>["target"],
	resolver: AuthorIdentityResolver,
): CaseOperation["target"] | null {
	if (target === null) return null;
	switch (target.kind) {
		case "new":
			return target.idFrom === undefined
				? { kind: "new" }
				: { kind: "new", idFrom: resolver.fieldUuid(target.idFrom) };
		case "operation":
			return {
				kind: "op",
				opUuid: resolver.operationUuid(target.operationId),
			};
		case "session":
			return { kind: "session" };
		case "expression":
			return {
				kind: "expression",
				expr: resolveAuthorValueExpression(target.expr, resolver),
			};
	}
}

function resolveWrites(
	writes: CaseOperationInput["writes"],
	resolver: AuthorIdentityResolver,
): CaseOperationWrite[] | undefined {
	return writes?.map((write) => ({
		property: write.property,
		value: resolveAuthorValueExpression(write.value, resolver),
		...(write.condition !== undefined && {
			condition: resolveAuthorPredicate(write.condition, resolver),
		}),
	}));
}

function resolveLinks(
	links: Extract<CaseOperationInput, { action: "create" | "update" }>["links"],
	resolver: AuthorIdentityResolver,
): CaseOperationLink[] | undefined {
	return links?.map((link) => ({
		identifier: link.identifier,
		targetType: link.targetType,
		target: resolveTarget(link.target, resolver),
		relationship: link.relationship,
	}));
}

export function resolveCaseOperationInput(
	doc: BlueprintDoc,
	formUuid: Uuid,
	input: CaseOperationInput,
	uuid: Uuid = asUuid(crypto.randomUUID()),
): CaseOperation {
	const resolver = identityResolver(doc, formUuid);
	const common = {
		uuid,
		id: input.id,
		action: input.action,
		caseType: input.caseType,
		target: resolveTarget(input.target, resolver) as CaseOperation["target"],
		...(input.condition !== undefined && {
			condition: resolveAuthorPredicate(input.condition, resolver),
		}),
		...(input.forEach !== undefined && {
			forEach: { repeat: resolver.fieldUuid(input.forEach) },
		}),
		writes: resolveWrites(input.writes, resolver),
	};
	switch (input.action) {
		case "create":
			return {
				...common,
				action: "create",
				name: resolveAuthorValueExpression(input.name, resolver),
				...(input.owner !== undefined && {
					owner: resolveAuthorValueExpression(input.owner, resolver),
				}),
				links: resolveLinks(input.links, resolver),
			};
		case "update":
			return {
				...common,
				action: "update",
				...(input.owner !== undefined && {
					owner: resolveAuthorValueExpression(input.owner, resolver),
				}),
				...(input.rename !== undefined && {
					rename: resolveAuthorValueExpression(input.rename, resolver),
				}),
				...(input.retype !== undefined && { retype: input.retype }),
				links: resolveLinks(input.links, resolver),
			};
		case "close":
			return { ...common, action: "close" };
	}
}

function projectTarget(
	target: CaseOperation["target"] | null,
	projector: AuthorIdentityProjector,
): unknown {
	if (target === null) return null;
	switch (target.kind) {
		case "new":
			return target.idFrom === undefined
				? { kind: "new" }
				: {
						kind: "new",
						idFrom: projector.fieldPath(target.idFrom) ?? "[missing field]",
					};
		case "op":
			return {
				kind: "operation",
				operationId:
					projector.operationId(target.opUuid) ?? "[missing operation]",
			};
		case "session":
			return { kind: "session" };
		case "expression":
			return {
				kind: "expression",
				expr: projectValueExpression(target.expr, projector),
			};
	}
}

/** Read projection: ordered author shape with no uuid, opUuid, or field uuid. */
export function projectCaseOperation(
	doc: BlueprintDoc,
	formUuid: Uuid,
	operation: CaseOperation,
): Record<string, unknown> {
	const projector = identityProjector(doc, formUuid);
	return {
		id: operation.id,
		action: operation.action,
		caseType: operation.caseType,
		target: projectTarget(operation.target, projector),
		...(operation.condition !== undefined && {
			condition: projectPredicate(operation.condition, projector),
		}),
		...(operation.forEach !== undefined && {
			forEach:
				projector.fieldPath(operation.forEach.repeat) ?? "[missing field]",
		}),
		...(operation.name !== undefined && {
			name: projectValueExpression(operation.name, projector),
		}),
		...(operation.owner !== undefined && {
			owner: projectValueExpression(operation.owner, projector),
		}),
		...(operation.rename !== undefined && {
			rename: projectValueExpression(operation.rename, projector),
		}),
		...(operation.retype !== undefined && { retype: operation.retype }),
		...(operation.writes !== undefined && {
			writes: operation.writes.map((write) => ({
				property: write.property,
				value: projectValueExpression(write.value, projector),
				...(write.condition !== undefined && {
					condition: projectPredicate(write.condition, projector),
				}),
			})),
		}),
		...(operation.links !== undefined && {
			links: operation.links.map((link) => ({
				identifier: link.identifier,
				targetType: link.targetType,
				target: projectTarget(link.target, projector),
				relationship: link.relationship,
			})),
		}),
	};
}

export function projectedCaseOperations(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly Record<string, unknown>[] {
	const operations = carrierBlindCaseOperationsProjection(
		orderedCaseOperations(doc.forms[formUuid] ?? {}),
	);
	return operations.map((operation) => {
		if (isDormantCaseOperationUnavailableProjection(operation)) {
			return {
				id: operation.id,
				action: operation.action,
				caseType: operation.caseType,
				unavailable: operation.unavailable,
			};
		}
		return projectCaseOperation(doc, formUuid, operation);
	});
}

export function operationIdRejection(
	formOperations: readonly CaseOperation[],
	proposed: string,
	excludeUuid?: Uuid,
): string | undefined {
	const taken = new Set(
		formOperations
			.filter((operation) => operation.uuid !== excludeUuid)
			.map((operation) => operation.id),
	);
	const verdict = caseOperationIdVerdict(proposed, taken);
	return verdict.ok ? undefined : verdict.userMessage;
}

export function dependentOperationNames(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuids: readonly Uuid[],
): string {
	const ids = uuids.map(
		(uuid) =>
			doc.forms[formUuid]?.caseOperations?.find(
				(operation) => operation.uuid === uuid,
			)?.id ?? "another operation",
	);
	return ids.map((id) => `"${id}"`).join(", ");
}
