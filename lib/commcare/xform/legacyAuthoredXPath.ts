/** PR4 only: form-authored text has not moved to Expression yet. These brands
 * may be created only at the old print/expand/lower boundary. Generated XPath
 * stays WireExpr, including the generated operands of a mixed expression.
 * PR5 removes this module together with that old authored pipeline. */
import { w } from "../xpath/wire/builders";
import {
	caseDbInstance,
	type InstanceDecl,
	searchInputInstance,
	sessionInstance,
} from "../xpath/wire/instances";
import { serializeWire } from "../xpath/wire/serialize";
import type {
	WireArithmetic,
	WireComparison,
	WireExpr,
	WireFunction,
	WireMode,
} from "../xpath/wire/tree";
import { collectInstanceRefs } from "./instanceRefs";

const authoredBrand = Symbol("legacy-authored-xpath");
const formLinkBrand = Symbol("legacy-form-link-xpath");
export interface LegacyAuthoredXPath {
	readonly [authoredBrand]: true;
	readonly text: string;
}
export interface LegacyFormLinkXPath {
	readonly [formLinkBrand]: true;
	readonly text: string;
}
type LegacyXPath = LegacyAuthoredXPath | LegacyFormLinkXPath;
export type AuthoredXPathValue = WireExpr | LegacyAuthoredXPath;
export type FormLinkXPathValue = WireExpr | LegacyFormLinkXPath;

/** Only the current authored projection pipeline may call this factory. */
export function legacyProjectedAuthoredXPath(
	text: string,
): LegacyAuthoredXPath {
	return { [authoredBrand]: true, text };
}
/** Only the current form-link projection pipeline may call this factory. */
export function legacyProjectedFormLinkXPath(
	text: string,
): LegacyFormLinkXPath {
	return { [formLinkBrand]: true, text };
}
export function isLegacyAuthoredXPath(
	value: unknown,
): value is LegacyAuthoredXPath {
	return typeof value === "object" && value !== null && authoredBrand in value;
}
export function isLegacyFormLinkXPath(
	value: unknown,
): value is LegacyFormLinkXPath {
	return typeof value === "object" && value !== null && formLinkBrand in value;
}
export function legacyAuthoredXPathText(value: LegacyAuthoredXPath): string {
	return value.text;
}
export function legacyFormLinkXPathText(value: LegacyFormLinkXPath): string {
	return value.text;
}

function isLegacy(value: WireExpr | LegacyXPath): value is LegacyXPath {
	return isLegacyAuthoredXPath(value) || isLegacyFormLinkXPath(value);
}
function operandText(value: WireExpr | LegacyXPath, mode: WireMode): string {
	if (isLegacy(value)) return value.text;
	const serialized = serializeWire(value, mode);
	if (serialized === undefined)
		throw new Error(
			"A generated operand cannot be withheld inside an authored XPath composition.",
		);
	return serialized.text;
}
function call<L extends LegacyXPath>(
	fn: WireFunction,
	args: readonly (WireExpr | L)[],
	mode: WireMode,
	brand: (text: string) => L,
): WireExpr | L {
	return args.every((arg): arg is WireExpr => !isLegacy(arg))
		? w.call(fn, args)
		: brand(`${fn}(${args.map((arg) => operandText(arg, mode)).join(", ")})`);
}
function binary<L extends LegacyXPath>(
	op: WireComparison | WireArithmetic,
	left: WireExpr | L,
	right: WireExpr | L,
	mode: WireMode,
	brand: (text: string) => L,
): WireExpr | L {
	if (!isLegacy(left) && !isLegacy(right)) {
		return op === "+" ||
			op === "-" ||
			op === "*" ||
			op === "div" ||
			op === "mod"
			? w.arith(op, left, right)
			: w.cmp(op, left, right);
	}
	return brand(
		`(${operandText(left, mode)}) ${op} (${operandText(right, mode)})`,
	);
}
function and<L extends LegacyXPath>(
	args: readonly (WireExpr | L)[],
	mode: WireMode,
	brand: (text: string) => L,
): WireExpr | L {
	if (args.every((arg): arg is WireExpr => !isLegacy(arg)))
		return w.and(...args);
	if (args.length === 1) return args[0];
	return brand(args.map((arg) => `(${operandText(arg, mode)})`).join(" and "));
}
export function legacyAuthoredCall(
	fn: WireFunction,
	args: readonly AuthoredXPathValue[],
	mode: WireMode,
): AuthoredXPathValue {
	return call(fn, args, mode, legacyProjectedAuthoredXPath);
}
export function legacyAuthoredBinary(
	op: WireComparison | WireArithmetic,
	left: AuthoredXPathValue,
	right: AuthoredXPathValue,
	mode: WireMode,
): AuthoredXPathValue {
	return binary(op, left, right, mode, legacyProjectedAuthoredXPath);
}
export function legacyAuthoredAnd(
	args: readonly AuthoredXPathValue[],
	mode: WireMode,
): AuthoredXPathValue {
	return and(args, mode, legacyProjectedAuthoredXPath);
}
export function legacyFormLinkCall(
	fn: WireFunction,
	args: readonly FormLinkXPathValue[],
	mode: WireMode = { target: "suite" },
): FormLinkXPathValue {
	return call(fn, args, mode, legacyProjectedFormLinkXPath);
}
export function legacyFormLinkBinary(
	op: WireComparison | WireArithmetic,
	left: FormLinkXPathValue,
	right: FormLinkXPathValue,
	mode: WireMode = { target: "suite" },
): FormLinkXPathValue {
	return binary(op, left, right, mode, legacyProjectedFormLinkXPath);
}
export function legacyFormLinkAnd(
	args: readonly FormLinkXPathValue[],
	mode: WireMode = { target: "suite" },
): FormLinkXPathValue {
	return and(args, mode, legacyProjectedFormLinkXPath);
}

/** HQ builds fallback guards literally as `not(emitted) and not(emitted)`.
 * Preserve that spelling through PR4's old authored projection so the local
 * fallback and HQ's independently constructed fallback stay identical. */
export function legacyFormLinkGuard(
	positive: FormLinkXPathValue | undefined,
	excluded: readonly FormLinkXPathValue[],
): FormLinkXPathValue {
	if (positive !== undefined && excluded.length === 0) return positive;
	if (
		(positive === undefined || !isLegacyFormLinkXPath(positive)) &&
		excluded.every((value): value is WireExpr => !isLegacyFormLinkXPath(value))
	) {
		return w.and(
			...(positive === undefined ? [] : [positive]),
			...excluded.map((value) => w.not(value)),
		);
	}
	const mode = { target: "suite" } as const;
	return legacyProjectedFormLinkXPath(
		[
			...(positive === undefined ? [] : [`(${operandText(positive, mode)})`]),
			...excluded.map((value) => `not(${operandText(value, mode)})`),
		].join(" and "),
	);
}

/** PR4's sole mixed generated function: an after-submit manual case datum
 * can supply the selected id of the grouped-tile parent companion. Its
 * fixed generated structure stays a tree unless that one operand is old
 * authored text. The index step is validated by the ordinary tree builder. */
export function legacyFormLinkGroupedParents(
	selectedCase: FormLinkXPathValue,
	identifier: string,
): FormLinkXPathValue {
	const mode = { target: "suite" } as const;
	const tail = [w.step("index"), w.step(identifier)];
	const predicate = legacyFormLinkBinary(
		"=",
		w.context([w.attr("case_id")]),
		selectedCase,
	);
	const cases = isLegacyFormLinkXPath(predicate)
		? legacyProjectedFormLinkXPath(
				`${serializeWire(w.instance(caseDbInstance(), [w.step("casedb"), w.step("case")]), mode).text}[${predicate.text}]/${serializeWire(w.context(tail), mode).text}`,
			)
		: w.instance(caseDbInstance(), [
				w.step("casedb"),
				w.step("case", [predicate]),
				...tail,
			]);
	return legacyFormLinkCall("join", [
		w.str(" "),
		legacyFormLinkCall("distinct-values", [cases]),
	]);
}

export interface LegacyInstanceContext {
	/** The actual launching search supplied by this form's projection context.
	 * No inferred id family, and no generated lookup/selected-cases scan. */
	readonly searchInputInstanceId?: string;
}
/** Called by the XML/HQ boundary only for branded, expanded authored text.
 * The old authoring gate admits structural casedb/session reads; expansion
 * may additionally insert the exact search-answer instance supplied here. */
export function legacyXPathInstances(
	value: LegacyXPath,
	context: LegacyInstanceContext = {},
): readonly InstanceDecl[] {
	return [...collectInstanceRefs(value.text)].map((id) => {
		if (id === "casedb") return caseDbInstance();
		if (id === "commcaresession") return sessionInstance();
		if (
			id === context.searchInputInstanceId &&
			(id === "search-input:results" || id === "search-input:results:inline")
		)
			return searchInputInstance(id);
		throw new Error(
			"An authored XPath reads an instance its form context does not supply. Validation must refuse that read before emission.",
		);
	});
}
export const legacyAuthoredXPathInstances = legacyXPathInstances;
export const legacyFormLinkXPathInstances = legacyXPathInstances;

/** Keep the temporary authored arm separate from the generated tree slots. */
export function partitionAuthoredXPath<Key extends string>(
	values: Partial<Record<Key, AuthoredXPathValue>>,
): {
	xpath: Partial<Record<Key, WireExpr>>;
	authoredXPath: Partial<Record<Key, LegacyAuthoredXPath>>;
} {
	const xpath: Partial<Record<Key, WireExpr>> = {};
	const authoredXPath: Partial<Record<Key, LegacyAuthoredXPath>> = {};
	for (const key of Object.keys(values) as Key[]) {
		const value = values[key];
		if (value === undefined) continue;
		if (isLegacyAuthoredXPath(value)) authoredXPath[key] = value;
		else xpath[key] = value;
	}
	return { xpath, authoredXPath };
}

export function legacyAuthoredOr(
	args: readonly AuthoredXPathValue[],
	mode: WireMode,
): AuthoredXPathValue {
	if (args.every((arg): arg is WireExpr => !isLegacy(arg)))
		return w.or(...args);
	if (args.length === 1) return args[0];
	return legacyProjectedAuthoredXPath(
		args.map((arg) => `(${operandText(arg, mode)})`).join(" or "),
	);
}
