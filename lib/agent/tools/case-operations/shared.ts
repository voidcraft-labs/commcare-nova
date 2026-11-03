/** Shared UUID-addressed vocabulary for case-operation tools. */

import { z } from "zod";
import { caseWriteKeyId } from "@/lib/doc/caseWriteKeys";
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
	type CaseWriteVia,
	caseOperationSchema,
	type OwnCaseOperation,
	orderedCaseOperations,
	RESERVED_CASE_OPERATION_TYPES,
	type RelationStep,
	USERCASE_CASE_TYPE,
	type Uuid,
	uuidSchema,
} from "@/lib/domain";
import { conditionSchema, valueSchema } from "@/lib/domain/expression";

export {
	type CasePlacementRead,
	formCasePlacementReads,
} from "../../authoring/casePlacementWords";
export {
	formAddressSchema as operationAddressSchema,
	resolveFormAddress as resolveOperationAddress,
} from "../shared/entityAddresses";

const CASE_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,254}$/;
const CASE_TYPE_FORMAT_MESSAGE =
	"Case type must start with a letter and use only letters, digits, underscores, or hyphens.";
const RESERVED_CASE_TYPE_MESSAGE =
	"That case type is platform-owned and cannot be changed by an authored operation.";

const caseTypeInputSchema = z
	.string()
	.regex(CASE_TYPE_PATTERN, CASE_TYPE_FORMAT_MESSAGE)
	.refine(
		(value) => !RESERVED_CASE_OPERATION_TYPES.has(value),
		RESERVED_CASE_TYPE_MESSAGE,
	);

/** An update's case type: any authored type, or `commcare-user`, the
 *  worker's own record, which only an update targeting `worker-record`
 *  saves to (the gate holds that pairing). */
const updateCaseTypeInputSchema = z
	.string()
	.regex(CASE_TYPE_PATTERN, CASE_TYPE_FORMAT_MESSAGE)
	.refine(
		(value) =>
			value === USERCASE_CASE_TYPE || !RESERVED_CASE_OPERATION_TYPES.has(value),
		RESERVED_CASE_TYPE_MESSAGE,
	);

const operationIdInputSchema = z
	.string()
	.regex(
		CASE_OPERATION_IDENTIFIER_REGEX,
		CASE_OPERATION_IDENTIFIER_FORMAT_MESSAGE,
	)
	.superRefine((value, ctx) => {
		const verdict = caseOperationIdVerdict(value, new Set(), "suggested");
		if (verdict.ok) return;
		ctx.addIssue({ code: "custom", message: verdict.userMessage });
	});

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
		const verdict = caseOperationLinkIdentifierVerdict(
			value,
			new Set(),
			"suggested",
		);
		if (verdict.ok) return;
		ctx.addIssue({ code: "custom", message: verdict.userMessage });
	});

const newTargetInputSchema = z.strictObject({
	kind: z.literal("new"),
	idFrom: uuidSchema
		.optional()
		.describe(
			"Optional field UUID whose answer deterministically keys the case",
		),
});

const operationTargetInputSchema = z.strictObject({
	kind: z.literal("op"),
	opUuid: uuidSchema.describe("UUID of an earlier create operation"),
});

const sessionTargetInputSchema = z
	.strictObject({ kind: z.literal("session") })
	.describe(
		"The single record selected before this form opens. Unavailable in registration and survey forms; it is not the record a registration creates.",
	);

const expressionTargetInputSchema = z.strictObject({
	kind: z.literal("expression"),
	expr: valueSchema.describe(
		"An existing record ID. For a selected record's parent, use via(ancestor('parent'), #case/case_id). The relationship must exist and lead to the target case type.",
	),
});

const workerRecordTargetInputSchema = z
	.strictObject({ kind: z.literal("worker-record") })
	.describe(
		"The worker's own record, for an update of commcare-user only. It takes no condition, links, owner, rename, retype or forEach.",
	);

const existingTargetInputSchema = z.discriminatedUnion("kind", [
	operationTargetInputSchema,
	sessionTargetInputSchema,
	expressionTargetInputSchema,
]);

/** An update's target: an existing case, or the worker's own record, which
 *  only an update saves to (`lib/domain/forms.ts::caseOperationSchema`). */
const updateTargetInputSchema = z.discriminatedUnion("kind", [
	operationTargetInputSchema,
	sessionTargetInputSchema,
	expressionTargetInputSchema,
	workerRecordTargetInputSchema,
]);

/** The links a write walks from its operation's case to the case it saves
 *  to, one step per link; the field tool's `caseWrite.via` shares it. */
export const caseWriteViaInputSchema = z
	.array(
		z.strictObject({
			identifier: linkIdInputSchema,
			throughCaseType: caseTypeInputSchema.optional(),
		}),
	)
	.min(1);

/** A `caseWriteViaInputSchema` walk as the domain's non-empty tuple. Its
 *  callers are a parsed value, which the schema's `min(1)` keeps non-empty,
 *  and the change schema's duplicate-key refinement, which skips an empty
 *  walk that `min(1)` has already refused; an empty one here is a caller
 *  that checked neither. */
export function toCaseWriteVia(via: readonly RelationStep[]): CaseWriteVia {
	const [first, ...rest] = via;
	if (first === undefined)
		throw new Error(
			"A save to a case above needs at least one link to walk, and this one names none.",
		);
	return [first, ...rest];
}

const writeInputSchema = z.strictObject({
	property: propertyInputSchema,
	value: valueSchema,
	condition: conditionSchema.optional(),
});

/** A write of this form's own case, which alone can save to a case above
 *  it or save only a changed answer (decision R9); every other arm's writes
 *  keep `writeInputSchema`, whose strict shape refuses both. */
const ownWriteInputSchema = writeInputSchema.extend({
	via: caseWriteViaInputSchema
		.optional()
		.describe(
			'Save to a case above this form\'s case instead, one link identifier per step, parent or host, such as [{"identifier":"parent"}]. Only on a follow-up or close form.',
		),
	onlyIfChanged: z
		.literal(true)
		.optional()
		.describe(
			"true saves only when the worker changed the answer from the case's value. Only on a follow-up or close form, and refused where CommCare HQ keeps this form's case change in Save to Case.",
		),
});

const linkInputSchema = z.strictObject({
	identifier: linkIdInputSchema,
	targetType: caseTypeInputSchema,
	target: existingTargetInputSchema.nullable(),
	relationship: z.enum(["child", "extension"]),
});

/** Each write saves to its key, its property on the case its `via` walks
 *  to; two writes of one key in one change save to the same place. */
function uniqueWriteKeys(
	writes:
		| readonly {
				readonly property: string;
				readonly via?: readonly RelationStep[];
		  }[]
		| undefined,
	ctx: z.RefinementCtx,
): void {
	const seen = new Set<string>();
	for (const [index, write] of (writes ?? []).entries()) {
		// Zod runs this refinement even after `min(1)` refuses an empty walk;
		// that write already carries its issue and has no key to compare.
		if (write.via !== undefined && write.via.length === 0) continue;
		const id = caseWriteKeyId({
			property: write.property,
			...(write.via !== undefined && { via: toCaseWriteVia(write.via) }),
		});
		if (seen.has(id)) {
			ctx.addIssue({
				code: "custom",
				path: ["writes", index, "property"],
				message: `"${write.property}" is saved twice to the same case in this change.`,
			});
		}
		seen.add(id);
	}
}

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
	.strictObject({
		id: operationIdInputSchema,
		action: z.literal("create"),
		caseType: caseTypeInputSchema,
		target: newTargetInputSchema,
		condition: conditionSchema.optional(),
		forEach: z
			.strictObject({ repeat: uuidSchema })
			.optional()
			.describe("Repeat field UUID; omit to run once per submission"),
		name: valueSchema,
		owner: valueSchema.optional(),
		writes: z.array(writeInputSchema).optional(),
		links: z.array(linkInputSchema).optional(),
	})
	.superRefine((value, ctx) => {
		uniqueWriteKeys(value.writes, ctx);
		uniqueMemberNames(value.links, "identifier", ctx);
	});

const updateOperationInputSchema = z
	.strictObject({
		id: operationIdInputSchema,
		action: z.literal("update"),
		caseType: updateCaseTypeInputSchema,
		target: updateTargetInputSchema,
		condition: conditionSchema.optional(),
		forEach: z
			.strictObject({ repeat: uuidSchema })
			.optional()
			.describe("Repeat field UUID; omit to run once per submission"),
		owner: valueSchema.optional(),
		rename: valueSchema.optional(),
		retype: caseTypeInputSchema.optional(),
		writes: z.array(writeInputSchema).optional(),
		links: z.array(linkInputSchema).optional(),
	})
	.superRefine((value, ctx) => {
		uniqueWriteKeys(value.writes, ctx);
		uniqueMemberNames(value.links, "identifier", ctx);
	});

const closeOperationInputSchema = z
	.strictObject({
		id: operationIdInputSchema,
		action: z.literal("close"),
		caseType: caseTypeInputSchema,
		target: existingTargetInputSchema,
		condition: conditionSchema.optional(),
		forEach: z
			.strictObject({ repeat: uuidSchema })
			.optional()
			.describe("Repeat field UUID; omit to run once per submission"),
		writes: z.array(writeInputSchema).optional(),
	})
	.superRefine((value, ctx) => {
		uniqueWriteKeys(value.writes, ctx);
	});

/**
 * This form's own case. Its case type is the module's, its target follows
 * the form's type, and whether it runs is the form's open and close
 * conditions, so it names none of them; only `updateCaseOperation` takes it.
 */
export const ownOperationInputSchema = z
	.strictObject({
		action: z.literal("own"),
		name: valueSchema.optional(),
		owner: valueSchema.optional(),
		writes: z.array(ownWriteInputSchema).optional(),
		links: z.array(linkInputSchema).optional(),
	})
	.superRefine((value, ctx) => {
		uniqueWriteKeys(value.writes, ctx);
		uniqueMemberNames(value.links, "identifier", ctx);
	})
	.describe(
		"This form's own case: what the form's type creates, updates or closes. Its case type is the menu's, and its open and close conditions are updateForm's. name is required on a registration.",
	);

/**
 * Facet legality is structural at the author boundary: each action has its own
 * closed schema, so a create with a session target or a close with an owner/link
 * cannot be sent by chat or MCP. A new change is never this form's own case,
 * which comes with the form's type, so the strict union refuses `own` here.
 */
export const caseOperationInputSchema = z.discriminatedUnion("action", [
	createOperationInputSchema,
	updateOperationInputSchema,
	closeOperationInputSchema,
]);

export type CaseOperationInput = z.infer<typeof caseOperationInputSchema>;

/** The edit of an existing change: one of the three arms, or this form's
 *  own case. */
export const caseOperationUpdateInputSchema = z.discriminatedUnion("action", [
	ownOperationInputSchema,
	createOperationInputSchema,
	updateOperationInputSchema,
	closeOperationInputSchema,
]);

export type CaseOperationUpdateInput = z.infer<
	typeof caseOperationUpdateInputSchema
>;

/** The refusal for adding, removing or moving this form's own case. */
export const OWN_CASE_OPERATION_REFUSAL =
	"This form's own case is always its first change, and it goes only with the form's type.";

/** The own case as an edit leaves it: `existing`'s identity with the
 *  input's slots. */
export function resolveOwnCaseOperationInput(
	input: z.infer<typeof ownOperationInputSchema>,
	existing: OwnCaseOperation,
): OwnCaseOperation {
	return caseOperationSchema.parse({
		uuid: existing.uuid,
		id: existing.id,
		action: "own",
		...(input.name !== undefined && { name: input.name }),
		...(input.owner !== undefined && { owner: input.owner }),
		...(input.writes !== undefined && { writes: input.writes }),
		...(input.links !== undefined && { links: input.links }),
	}) as OwnCaseOperation;
}

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
): z.output<typeof caseOperationSchema> {
	const common = {
		uuid,
		id: input.id,
		caseType: input.caseType,
		...(input.condition !== undefined && { condition: input.condition }),
		...(input.forEach !== undefined && { forEach: input.forEach }),
		...(input.writes !== undefined && { writes: input.writes }),
	};
	switch (input.action) {
		case "create":
			return caseOperationSchema.parse({
				...common,
				action: "create",
				target: input.target,
				name: input.name,
				...(input.owner !== undefined && { owner: input.owner }),
				...(input.links !== undefined && { links: input.links }),
			});
		case "update":
			return caseOperationSchema.parse({
				...common,
				action: "update",
				target: input.target,
				...(input.owner !== undefined && { owner: input.owner }),
				...(input.rename !== undefined && { rename: input.rename }),
				...(input.retype !== undefined && { retype: input.retype }),
				...(input.links !== undefined && { links: input.links }),
			});
		case "close":
			return caseOperationSchema.parse({
				...common,
				action: "close",
				target: input.target,
			});
	}
}

/** A form's case changes in the order they run, this form's own case
 *  first. */
export function projectedCaseOperations(
	doc: BlueprintDoc,
	formUuid: Uuid,
): readonly CaseOperation[] {
	const operations = orderedCaseOperations(doc.forms[formUuid] ?? {});
	return [
		...operations.filter((operation) => operation.action === "own"),
		...operations.filter((operation) => operation.action !== "own"),
	];
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
