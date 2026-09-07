import {
	type CaseProperty,
	effectiveDataType,
	type UserProperty,
} from "@/lib/domain";
import {
	acceptsType,
	dateLiteral,
	datetimeLiteral,
	formField,
	input,
	type Literal,
	literal,
	prop,
	type ResolvedType,
	reasonFor,
	type SlotConstraint,
	sessionContext,
	sessionUser,
	sessionUserProperty,
	type Term,
	tableColumn,
	timeLiteral,
	term as wrapTerm,
} from "@/lib/domain/predicate";
import { reseedLiteralForConstraint } from "./cards/reseed";
import type { AdmitExpressionChange } from "./editorContext";
import type { ExpressionEditContext } from "./expressionEditorSchemas";
import type { EditorPath } from "./path";
export type TermMode =
	| "literal"
	| "property"
	| "field"
	| "input"
	| "table-column"
	| "session-context"
	| "session-user"
	| "session-user-property";

/** Read the mode discriminator from the Term's `kind`. Maps `prop`
 *  to "property" because the user-facing label is "Case property"
 *  rather than "Prop"; every other kind reads through unchanged. */
export function termMode(term: Term): TermMode {
	switch (term.kind) {
		case "literal":
			return "literal";
		case "prop":
			return "property";
		case "field":
			return "field";
		case "input":
			return "input";
		case "session-context":
			return "session-context";
		case "session-user":
			return "session-user";
		case "session-user-property":
			return "session-user-property";
		case "table-column":
			return "table-column";
		case "fixed-location":
		case "owner-location-at-level":
			throw new Error(
				"Location owner terms are edited by the case-owner location control, not the general expression source menu.",
			);
	}
}

export function termsMatch(left: Term, right: Term): boolean {
	if (left === right) return true;
	return JSON.stringify(left) === JSON.stringify(right);
}

export function literalHasMeaningfulContent(value: Literal): boolean {
	return typeof value.value === "string" ? value.value.length > 0 : true;
}

export function termHasMeaningfulContent(value: Term): boolean {
	switch (value.kind) {
		case "literal":
			return literalHasMeaningfulContent(value);
		case "prop":
			return value.property.length > 0 || value.via !== undefined;
		case "field":
			return true;
		case "input":
			return true;
		case "session-context":
			return true;
		case "session-user":
			return value.field.length > 0;
		case "session-user-property":
			return true;
		case "table-column":
			return true;
		case "fixed-location":
		case "owner-location-at-level":
			return true;
	}
}

export function termModeLabel(
	mode: TermMode,
	sourceContext: "value" | "subject",
): string {
	switch (mode) {
		case "literal":
			return "A value";
		case "property":
			return sourceContext === "subject"
				? "Case information"
				: "Other case information";
		case "field":
			return "A form answer";
		case "input":
			return "A search answer";
		case "table-column":
			return "A table column";
		case "session-context":
			return "App information";
		case "session-user":
			return "Other user field";
		case "session-user-property":
			return "Worker information";
	}
}

export function describeTermModeReplacement(
	source: Term,
	targetLabel: string,
): { readonly title: string; readonly description: string } {
	const replacement = targetLabel.replace(/^./, (letter) =>
		letter.toLocaleLowerCase(),
	);
	const title = `Use ${replacement} instead?`;
	switch (source.kind) {
		case "literal":
			return {
				title,
				description: "This replaces the saved value. You can undo this change.",
			};
		case "prop":
			return source.via === undefined
				? {
						title,
						description:
							"This replaces the selected case information. You can undo this change.",
					}
				: {
						title,
						description:
							"This replaces the selected case information and its connection. You can undo this change.",
					};
		case "field":
			return {
				title,
				description:
					"This replaces the selected form answer. You can undo this change.",
			};
		case "input":
			return {
				title,
				description:
					"This replaces the selected search answer. You can undo this change.",
			};
		case "session-context":
			return {
				title,
				description:
					"This replaces the selected app information. You can undo this change.",
			};
		case "session-user":
		case "session-user-property":
			return {
				title,
				description:
					"This replaces the saved user information field. You can undo this change.",
			};
		case "table-column":
			return {
				title,
				description:
					"This replaces the selected data-table column. You can undo this change.",
			};
		case "fixed-location":
		case "owner-location-at-level":
			throw new Error(
				"Location owner terms are replaced by the case-owner location control.",
			);
	}
}

/** Whether the slot accepts a value of type `t`: `ANY_CONSTRAINT`
 *  admits everything. */
export function constraintAdmitsType(
	constraint: SlotConstraint,
	t: ResolvedType,
): boolean {
	return constraint.accepts === "any" || acceptsType(constraint, t);
}

/** A property filter derived from the slot constraint: `undefined`
 *  (no narrowing) when the constraint is unconstrained. Memoize at the
 *  call site so `PropertyPicker`'s `[caseType, filter]` memo stays
 *  stable across renders with the same constraint. */
export function propertyFilterFor(
	constraint: SlotConstraint,
): ((p: CaseProperty) => boolean) | undefined {
	if (constraint.accepts === "any") return undefined;
	return (p) => acceptsType(constraint, effectiveDataType(p));
}

/** Per-mode admission verdict + reason for the source menu. */
export type ModeAdmission = Record<
	TermMode,
	{ admitted: boolean; reason?: string }
>;

export interface TermAdmissionContext extends ExpressionEditContext {
	readonly admitExpressionChange?: AdmitExpressionChange;
	readonly userProperties: readonly UserProperty[];
}

/**
 * Resolve which Term sources can produce a value the slot accepts:
 *   - `literal`: admitted unless this exact node is an absence-check
 *     subject. Otherwise a literal can be `null`, which is compatible
 *     with every type, and the shape menu does the fine-grained gating
 *     per accepted type.
 *   - `property`: admitted when a property of an accepted type
 *     exists on the current case type.
 *   - `input`: admitted when a declared search input of an accepted
 *     type is in scope.
 *   - `session-context` / both user sources: resolve to `text`, so
 *     admitted only when the slot accepts text.
 */
export function computeModeAdmission(
	ctx: TermAdmissionContext,
	constraint: SlotConstraint,
	path: EditorPath,
): ModeAdmission {
	const reason = reasonFor(constraint);
	const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
	const hasAcceptedProperty =
		ct?.properties.some(
			(p) =>
				constraint.accepts === "any" ||
				acceptsType(constraint, effectiveDataType(p)),
		) ?? false;
	const hasAcceptedInput = ctx.knownInputs.some(
		(input) =>
			constraint.accepts === "any" ||
			acceptsType(constraint, input.data_type ?? "text"),
	);
	/* The decl list arrives already narrowed to the answers this slot may
	 * read (repeat correlation is the mounting surface's call), so the only
	 * question left here is the slot's own type. */
	const hasAcceptedFormField = (ctx.formFields ?? []).some(
		(field) =>
			constraint.accepts === "any" ||
			acceptsType(constraint, field.dataType ?? "text"),
	);
	const hasAcceptedTableColumn = (ctx.tableScope?.columns ?? []).some(
		(column) =>
			constraint.accepts === "any" || acceptsType(constraint, column.dataType),
	);
	const textAdmitted = constraintAdmitsType(constraint, "text");
	const typeAdmission: ModeAdmission = {
		literal:
			constraint.forbidDirectLiteral === true
				? {
						admitted: false,
						reason:
							"Use case information, a search answer, app information, or a calculation here",
					}
				: { admitted: true },
		property: hasAcceptedProperty
			? { admitted: true }
			: { admitted: false, reason },
		field: hasAcceptedFormField
			? { admitted: true }
			: {
					admitted: false,
					reason:
						(ctx.formFields ?? []).length === 0
							? "Form answers are available when a case operation saves them"
							: reason,
				},
		input: hasAcceptedInput ? { admitted: true } : { admitted: false, reason },
		"table-column": hasAcceptedTableColumn
			? { admitted: true }
			: {
					admitted: false,
					reason:
						ctx.tableScope === undefined
							? "Table columns are available only in a data-table row rule"
							: reason,
				},
		"session-context": textAdmitted
			? { admitted: true }
			: { admitted: false, reason },
		"session-user": textAdmitted
			? { admitted: true }
			: { admitted: false, reason },
		"session-user-property":
			textAdmitted && ctx.userProperties.length > 0
				? { admitted: true }
				: {
						admitted: false,
						reason:
							ctx.userProperties.length === 0
								? "Add worker information in App setup first"
								: reason,
					},
	};
	if (ctx.admitExpressionChange === undefined) return typeAdmission;

	return Object.fromEntries(
		(Object.keys(typeAdmission) as TermMode[]).map((mode) => {
			const slotVerdict = typeAdmission[mode];
			if (!slotVerdict.admitted) return [mode, slotVerdict];
			const ruleVerdict = ctx.admitExpressionChange?.(
				path,
				wrapTerm(buildTermAdmissionProbe(mode, ctx, constraint)),
			);
			return [mode, ruleVerdict ?? slotVerdict];
		}),
	) as ModeAdmission;
}

/** Use a schema-valid representative only to ask a rule-level admission
 * checker whether a source family is allowed. User information has no honest
 * semantic default, so this probe must never become authored data. */
export function buildTermAdmissionProbe(
	mode: TermMode,
	ctx: TermAdmissionContext,
	constraint: SlotConstraint,
): Term {
	return mode === "session-user"
		? sessionUser("_")
		: buildTermDefault(mode, ctx, constraint);
}

/** Build a per-mode draft. Every returned value is a complete, schema-valid
 * authored choice. Source families with no honest default are either excluded
 * by admission or collected by `requestMode` before this function is reached. */
export function buildTermDefault(
	mode: TermMode,
	ctx: TermAdmissionContext,
	constraint: SlotConstraint,
): Term {
	switch (mode) {
		case "literal":
			return constraint.accepts === "any"
				? literal("")
				: reseedLiteralForConstraint(literal(""), constraint.accepts);
		case "property": {
			const ct = ctx.caseTypes.find((c) => c.name === ctx.currentCaseType);
			const filter = propertyFilterFor(constraint);
			const property = ct?.properties.find((p) => (filter ? filter(p) : true));
			if (property === undefined) {
				throw new Error(
					"Case information is unavailable without a property of the required type.",
				);
			}
			return prop(ctx.currentCaseType, property.name);
		}
		case "field": {
			// The first answer whose type the slot accepts. A surface with no
			// admissible answer never offers the source.
			const admissible = (ctx.formFields ?? []).find(
				(field) =>
					constraint.accepts === "any" ||
					acceptsType(constraint, field.dataType ?? "text"),
			);
			if (admissible === undefined) {
				throw new Error(
					"Form answer is unavailable without an in-scope field of the required type.",
				);
			}
			return formField(admissible.uuid);
		}
		case "input": {
			const matching = ctx.knownInputs.find((i) =>
				constraint.accepts === "any"
					? true
					: acceptsType(constraint, i.data_type ?? "text"),
			);
			const selected = matching ?? ctx.knownInputs[0];
			if (selected === undefined) {
				throw new Error(
					"Search answer is unavailable until a search field exists.",
				);
			}
			return input(selected.uuid);
		}
		case "table-column": {
			const column = ctx.tableScope?.columns.find(
				(candidate) =>
					constraint.accepts === "any" ||
					acceptsType(constraint, candidate.dataType),
			);
			if (ctx.tableScope === undefined || column === undefined) {
				throw new Error(
					"A data-table column cannot be seeded without an admitted row scope.",
				);
			}
			return tableColumn(ctx.tableScope.tableId, column.id);
		}
		case "session-context":
			// `userid` is the most authored choice ("owned by me"
			// filters in the case-list); other fields require an
			// explicit pick.
			return sessionContext("userid");
		case "session-user":
			throw new Error(
				"Worker data requires a field name before it can be authored.",
			);
		case "session-user-property": {
			const property = ctx.userProperties[0];
			if (property === undefined) {
				throw new Error(
					"Worker information cannot be selected without a catalog property.",
				);
			}
			return sessionUserProperty(property.uuid);
		}
	}
}

export type LiteralShape =
	| "text"
	| "number"
	| "boolean"
	| "null"
	| "date"
	| "datetime"
	| "time";

/** Classify a literal into the editor's shape enum. Reads
 *  `data_type` first (the explicit qualifier set by `dateLiteral`
 *  etc.), then falls back to the JS runtime type: same fallback
 *  the type-checker's `literalType` uses. The classification drives
 *  the input variant; the runtime literal carries the matching
 *  qualifier on rebuild via the `buildLiteralForShape` mapping. */
export function classifyLiteralShape(lit: Literal): LiteralShape {
	if (lit.data_type === "date") return "date";
	if (lit.data_type === "datetime") return "datetime";
	if (lit.data_type === "time") return "time";
	if (lit.value === null) return "null";
	if (typeof lit.value === "boolean") return "boolean";
	if (typeof lit.value === "number") return "number";
	return "text";
}

export function literalsMatch(left: Literal, right: Literal): boolean {
	return left.value === right.value && left.data_type === right.data_type;
}

/** The resolved type a literal shape produces: drives the shape
 *  menu's per-shape admission against the slot's accept-set.
 *  `boolean` resolves to `text` (CommCare has no Boolean type); `null`
 *  resolves to the null sentinel (`_any`), compatible with every
 *  type. */
export const LITERAL_SHAPE_TYPE: Record<LiteralShape, ResolvedType> = {
	text: "text",
	number: "int",
	boolean: "text",
	null: "_any",
	date: "date",
	datetime: "datetime",
	time: "time",
};

/** Initial draft for a shape the mounted editor has not visited yet.
 *  Typed builders carry the intended temporal qualifier; returning to
 *  a visited shape restores its cached draft instead. */
export function buildLiteralForShape(shape: LiteralShape): Literal {
	switch (shape) {
		case "text":
			return literal("");
		case "number":
			return literal(0);
		case "boolean":
			return literal(false);
		case "null":
			return literal(null);
		case "date":
			return dateLiteral("");
		case "datetime":
			return datetimeLiteral("");
		case "time":
			return timeLiteral("");
	}
}

export const LITERAL_SHAPE_LABELS: Record<LiteralShape, string> = {
	text: "Text",
	number: "Number",
	boolean: "Yes or no",
	null: "No value",
	date: "Date",
	datetime: "Date and time",
	time: "Time",
};

export function describeLiteralShapeReplacement(
	source: LiteralShape,
	target: LiteralShape,
): { readonly title: string; readonly description: string } {
	const sourceDescription =
		source === "null"
			? "saved “No value” choice"
			: `saved ${LITERAL_SHAPE_LABELS[source].toLocaleLowerCase()} value`;
	return {
		title: `Change this value to ${LITERAL_SHAPE_LABELS[target].toLocaleLowerCase()}?`,
		description: `This replaces the ${sourceDescription}. You can undo this change.`,
	};
}
