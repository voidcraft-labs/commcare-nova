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
import {
	type Expression,
	isProseSlotRef,
	type ProseSlotRef,
	type SlotContextRef,
} from "@/lib/domain/expression/types";
import { readCaseReference } from "@/lib/domain/hashtagSegments";
import {
	type ProseAtomPart,
	type ProseReferencePart,
	prosePartSchema,
} from "@/lib/domain/prose";
import { canonicalProseAtom } from "@/lib/domain/proseExpression";
import { expressionSlotValue } from "@/lib/domain/referenceSlots";
import { asUuid } from "@/lib/domain/uuid";

export interface FormExpressionOptions {
	readonly form?: FormStructure;
	/** A prose slot holds any number of calculated values, so it has no one
	 *  stored tree: the caller names the value being edited, absent for a
	 *  new one. An expression slot reads its own. */
	readonly current?: Expression;
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
	} else if (namespace === "user") {
		if (segments.length !== 1) return fail();
		const worker = formUserProperty(scope, segments[0], "worker-record");
		if (worker.kind === "session-user-property")
			result = {
				kind: "user-property-ref",
				userPropertyUuid: worker.userPropertyUuid,
			};
		else if (worker.kind === "session-user")
			result = { kind: "user-ref", property: worker.field };
		else return fail();
	} else if (namespace === "case") {
		const caseType = scope.authoring?.selectedCaseType;
		if (caseType === undefined || segments.length !== 1) return fail();
		result = { kind: "case-ref", caseType, property: segments[0] };
	} else {
		const read = readCaseReference(namespace, segments);
		if (read === undefined) return fail();
		result = { kind: "case-ref", ...read };
	}
	const valid = prosePartSchema.safeParse(result);
	return valid.success &&
		valid.data.kind !== "text" &&
		valid.data.kind !== "value"
		? valid.data
		: fail();
}

/** One insertion of a text: `=` and a formula is a calculated value, parsed in the text's prose
 *  slot; any other name is a reference. Throws `AuthoringInputError` with the sentences of
 *  "Copy": for `=` with no slot, for `=` with nothing after it, and for a formula that does not
 *  parse. */
export function parseProseAtom(
	scope: ProseReferenceScope,
	name: string,
	slot: ProseSlotRef | undefined,
	lookup: LookupDefinitionIndex | "unavailable",
): ProseAtomPart {
	if (!name.startsWith("=")) return parseProseReference(scope, name);
	const formula = name.slice(1).trim();
	if (formula === "")
		throw new AuthoringInputError(
			"{{= }} needs a formula after the equals sign, such as {{= format-date(date(#form/visit_date), '%e %b %Y')}}.",
		);
	if (slot === undefined)
		throw new AuthoringInputError(
			`A calculated value shows only in a question's label, hint, help text, validation message or choice label, where the form works it out. This text is none of those, so it can't hold {{= ${formula}}}. You can write the text without it.`,
		);
	const parsed = parseFormExpression(formula, {
		doc: scope.doc,
		slot,
		lookup,
		...(scope.form !== undefined && { form: scope.form }),
		...(scope.authoring !== undefined && { authoring: scope.authoring }),
	});
	if (!parsed.ok)
		throw new AuthoringInputError(
			[
				`The calculated value {{= ${formula}}} can't be read.`,
				...parsed.issues.map((issue) => issue.message),
			].join(" "),
		);
	if (parsed.expression === undefined)
		throw new AuthoringInputError(
			"{{= }} needs a formula after the equals sign, such as {{= format-date(date(#form/visit_date), '%e %b %Y')}}.",
		);
	return canonicalProseAtom(parsed.expression);
}

/** The one scope a slot's text is parsed against: its document, its lookup
 * definitions, pending declarations, and the stored tree as the binding
 * hint. The editor's lint, completion, chips and draft reconciliation read
 * this same scope. */
export function formParseScopeForSlot(
	doc: BlueprintDoc,
	slot: SlotContextRef,
	lookup: LookupDefinitionIndex | "unavailable",
	options: FormExpressionOptions = {},
): FormParseScope {
	const current = isProseSlotRef(slot)
		? options.current
		: options.form !== undefined && slot.entity !== "module"
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
	slot: SlotContextRef,
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
	slot: SlotContextRef,
	expression: Expression,
	lookup: LookupDefinitionIndex | "unavailable",
	options: FormProjectionOptions = {},
): FormExpressionProjection {
	const { layout, current, ...structure } = options;
	const context = formPrintContext({
		doc,
		slot,
		lookup,
		...structure,
		...(current === undefined ? {} : { current }),
	});
	const projection = printFormExpression(expression, context, { layout });
	return context === undefined
		? {
				...projection,
				unresolved: [...projection.unresolved, { path: [], reason: "context" }],
			}
		: projection;
}
