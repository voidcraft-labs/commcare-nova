/** Shared UUID-addressed vocabulary for case-operation tools. */

import { z } from "zod";
import {
	caseOperationIdVerdict,
	caseOperationLinkIdentifierVerdict,
	caseOperationWritePropertyVerdict,
} from "@/lib/doc/identifierVerdicts";
import {
	type BlueprintDoc,
	CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
	CASE_OPERATION_IDENTIFIER_REGEX,
	CASE_OPERATION_PROPERTY_FORMAT_MESSAGE,
	CASE_OPERATION_PROPERTY_REGEX,
	type CaseOperation,
	type CaseOperationLink,
	type CaseOperationWrite,
	caseOperationSchema,
	orderedCaseOperations,
	RESERVED_CASE_OPERATION_TYPES,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { predicateSchema, valueExpressionSchema } from "@/lib/domain/predicate";

export {
	formAddressSchema as operationAddressSchema,
	resolveFormAddress as resolveOperationAddress,
} from "../shared/entityAddresses";

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
		idFrom: uuidSchema
			.optional()
			.describe(
				"Optional field UUID whose answer deterministically keys the case",
			),
	})
	.strict();

const operationTargetInputSchema = z
	.object({
		kind: z.literal("op"),
		opUuid: uuidSchema.describe("UUID of an earlier create operation"),
	})
	.strict();

const sessionTargetInputSchema = z
	.object({ kind: z.literal("session") })
	.strict();

const expressionTargetInputSchema = z
	.object({
		kind: z.literal("expression"),
		expr: valueExpressionSchema,
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
		value: valueExpressionSchema,
		condition: predicateSchema.optional(),
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
		condition: predicateSchema.optional(),
		forEach: z
			.object({ repeat: uuidSchema })
			.strict()
			.optional()
			.describe("Repeat field UUID; omit to run once per submission"),
		name: valueExpressionSchema,
		owner: valueExpressionSchema.optional(),
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
		condition: predicateSchema.optional(),
		forEach: z
			.object({ repeat: uuidSchema })
			.strict()
			.optional()
			.describe("Repeat field UUID; omit to run once per submission"),
		owner: valueExpressionSchema.optional(),
		rename: valueExpressionSchema.optional(),
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
		condition: predicateSchema.optional(),
		forEach: z
			.object({ repeat: uuidSchema })
			.strict()
			.optional()
			.describe("Repeat field UUID; omit to run once per submission"),
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

export function operationByUuid(
	doc: BlueprintDoc,
	formUuid: Uuid,
	uuid: Uuid,
): CaseOperation | undefined {
	return (doc.forms[formUuid]?.caseOperations ?? []).find(
		(operation) => operation.uuid === uuid,
	);
}

export function resolveCaseOperationInput(
	input: CaseOperationInput,
	uuid: Uuid,
): CaseOperation {
	const common = {
		uuid,
		id: input.id,
		action: input.action,
		caseType: input.caseType,
		target: input.target as CaseOperation["target"],
		...(input.condition !== undefined && { condition: input.condition }),
		...(input.forEach !== undefined && { forEach: input.forEach }),
		writes: input.writes as CaseOperationWrite[] | undefined,
	};
	switch (input.action) {
		case "create":
			return caseOperationSchema.parse({
				...common,
				action: "create",
				name: input.name,
				...(input.owner !== undefined && { owner: input.owner }),
				links: input.links as CaseOperationLink[] | undefined,
			});
		case "update":
			return caseOperationSchema.parse({
				...common,
				action: "update",
				...(input.owner !== undefined && { owner: input.owner }),
				...(input.rename !== undefined && { rename: input.rename }),
				...(input.retype !== undefined && { retype: input.retype }),
				links: input.links as CaseOperationLink[] | undefined,
			});
		case "close":
			return caseOperationSchema.parse({ ...common, action: "close" });
	}
}

export function projectedCaseOperations(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly CaseOperation[] {
	return orderedCaseOperations(doc.forms[formUuid] ?? {});
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
