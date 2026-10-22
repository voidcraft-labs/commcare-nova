// The doc-aware form-source bridge shared by Builder, SA and MCP.
import { AuthoringInputError } from "@/lib/agent/authoring/errors";
import {
	type FormParseResult,
	type FormParseScope,
	parseFormExpression,
} from "@/lib/commcare/xpath/expressionAst";
import { formPrintContext } from "@/lib/commcare/xpath/formPrintContext";
import { readFormSyntax } from "@/lib/commcare/xpath/formSyntax";
import { formUserProperty } from "@/lib/commcare/xpath/referenceBindings";
import type { BlueprintDoc, Uuid } from "@/lib/doc/types";
import type { LookupDefinitionIndex } from "@/lib/domain/expression/context";
import {
	type FormStructure,
	formStructure,
} from "@/lib/domain/expression/formStructure";
import {
	type FormExpressionProjection,
	printFormExpression,
} from "@/lib/domain/expression/print";
import type {
	Expression,
	ExpressionSlotRef,
} from "@/lib/domain/expression/types";
import { type ProseReferencePart, prosePartSchema } from "@/lib/domain/prose";
import { expressionSlotValue } from "@/lib/domain/referenceSlots";
import { asUuid } from "@/lib/domain/uuid";

export interface FormExpressionOptions {
	readonly form?: FormStructure;
}

export interface FormProjectionOptions extends FormExpressionOptions {
	/** Lay the text out over lines past the printer's width (`print.ts`). */
	readonly layout?: boolean;
}

export interface ProseReferenceScope {
	readonly doc: BlueprintDoc;
	readonly formUuid?: Uuid;
	readonly form?: FormStructure;
	readonly authoring?: FormParseScope["authoring"];
}

/** Interpolation binds a reference directly; it is never executable source. */
export function parseProseReference(
	scope: ProseReferenceScope,
	name: string,
): ProseReferencePart {
	const source = name.startsWith("#") ? name : `#form/${name}`;
	const parsed = readFormSyntax(source);
	const fail = (): never => {
		throw new AuthoringInputError(
			`{{${name}}} must name one answer or record property.`,
		);
	};
	if (!parsed.ok || parsed.node?.kind !== "hashtag") return fail();
	const { namespace, segments } = parsed.node;
	let result: ProseReferencePart;
	if (namespace === "form") {
		const form =
			scope.form ??
			(scope.formUuid === undefined
				? undefined
				: formStructure(scope.doc, scope.formUuid));
		let uuid = scope.authoring?.resolveFormExactName?.(segments);
		if (uuid === undefined && form !== undefined) {
			let parent = form.formUuid;
			for (const segment of segments) {
				const matches = (form.fieldOrder.get(parent) ?? []).filter(
					(id) => form.fields.get(id)?.id === segment,
				);
				if (matches.length !== 1) {
					uuid = undefined;
					break;
				}
				uuid = matches[0];
				parent = matches[0];
			}
		}
		uuid ??= scope.authoring?.resolveFormShortName(segments);
		if (uuid === undefined || form?.fields.has(asUuid(uuid)) !== true)
			return fail();
		result = { kind: "field-ref", uuid: asUuid(uuid) };
	} else {
		if (segments.length !== 1) return fail();
		const property = segments[0];
		if (namespace === "user") {
			const worker = formUserProperty(scope, property, "worker-record");
			if (worker.kind === "session-user-property")
				result = {
					kind: "user-property-ref",
					userPropertyUuid: worker.userPropertyUuid,
				};
			else if (worker.kind === "session-user")
				result = { kind: "user-ref", property: worker.field };
			else return fail();
		} else {
			const caseType =
				namespace === "case" ? scope.authoring?.selectedCaseType : namespace;
			if (caseType === undefined || namespace === "search") return fail();
			result = { kind: "case-ref", caseType, property };
		}
	}
	const valid = prosePartSchema.safeParse(result);
	return valid.success && valid.data.kind !== "text" ? valid.data : fail();
}

/** The one scope a slot's text is parsed against: its document, its lookup
 * definitions, pending declarations, and the stored tree as the binding
 * hint. The editor's lint, completion, chips and draft reconciliation read
 * this same scope. */
export function formParseScopeForSlot(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	lookup: LookupDefinitionIndex | "unavailable",
	options: FormExpressionOptions = {},
): FormParseScope {
	const current =
		options.form !== undefined && slot.entity !== "module"
			? options.form.expressionAt(slot)
			: expressionSlotValue(doc, slot);
	return {
		doc,
		slot,
		lookup,
		current,
		...(options.form === undefined ? {} : { form: options.form }),
	};
}

/** Empty text clears an optional slot. Requiredness is owned by the caller's
 * schema/commit contract, so no empty expression is ever constructed here. */
export function parseFormExpressionForSlot(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	text: string,
	lookup: LookupDefinitionIndex | "unavailable",
	options: FormExpressionOptions = {},
): FormParseResult {
	return parseFormExpression(
		text,
		formParseScopeForSlot(doc, slot, lookup, options),
	);
}

export function parseAuthoredFormExpression(
	scope: FormParseScope,
	text: string,
): Expression | undefined {
	const parsed = parseFormExpression(text, scope);
	if (!parsed.ok)
		throw new AuthoringInputError(
			parsed.issues.map((issue) => issue.message).join("\n"),
		);
	return parsed.expression;
}

export function projectFormExpression(
	doc: BlueprintDoc,
	slot: ExpressionSlotRef,
	expression: Expression,
	lookup: LookupDefinitionIndex | "unavailable",
	options: FormProjectionOptions = {},
): FormExpressionProjection {
	const { layout, ...structure } = options;
	const context = formPrintContext({ doc, slot, lookup, ...structure });
	const projection = printFormExpression(expression, context, { layout });
	return context === undefined
		? {
				...projection,
				unresolved: [...projection.unresolved, { path: [], reason: "context" }],
			}
		: projection;
}

/** The structural slice the close-field resolver needs — both the doc
 *  and the builder UI's `{ fields, fieldOrder }` selector shape. */
export interface FieldRefResolvableDoc {
	fields: Readonly<Record<string, { uuid: Uuid; id: string } | undefined>>;
	fieldOrder: Readonly<Record<string, readonly string[] | undefined>>;
}

/**
 * Resolve a builder-authored close-condition field reference (a bare leaf id)
 * to the target field's stable uuid — pre-order first match across the
 * form's tree, the same rule the wire emitter's `findField` applies —
 * or return the text verbatim when nothing answers to it (a dangling
 * pointer the validator's close-condition rules flag from the slot).
 */
export function resolveCloseFieldRef(
	doc: FieldRefResolvableDoc,
	formUuid: string,
	ref: string,
): Uuid | string {
	if (ref.length === 0) return ref;
	const find = (parentUuid: string): Uuid | undefined => {
		// Membership-array order: the pre-order first match must agree with the
		// wire emitter's `findField`, so a close-field ref resolves to the same
		// UUID at commit time and at emit time even when cousins share an id.
		const ordered = [...(doc.fieldOrder[parentUuid] ?? [])];
		for (const uuid of ordered) {
			const field = doc.fields[uuid];
			if (!field) continue;
			if (field.id === ref) return field.uuid;
			if (doc.fieldOrder[uuid] !== undefined) {
				const found = find(uuid);
				if (found !== undefined) return found;
			}
		}
		return undefined;
	};
	return find(formUuid) ?? ref;
}
