/**
 * The types a record slot's comparisons give the case properties they
 * compare. A record slot compares a property with a value of its own type:
 * the emitter prints `age = 18` for a whole-number property and
 * `age = '18'` for text, so a property the catalog holds untyped, compared
 * in a record slot with a value of a known type, is a property of that type.
 * Text is not ordered, so an ordering against a literal spelled as a date
 * or a date and time orders that type; a distance measured from a property
 * makes it a location, and a test of the choices it holds a list of choices.
 * Nothing else an app holds says so: no
 * writer types it, and HQ keeps no type of a property.
 */
import type { CasePropertyDataType } from "@/lib/domain/casePropertyTypes";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { literalShape } from "@/lib/domain/expression/ruleSets";
import { scalarDataType, typeOf } from "@/lib/domain/expression/typeChecker";
import type { Expression, Term } from "@/lib/domain/expression/types";
import { walkExpressionNodes } from "@/lib/domain/expression/walk";
import { isStandardCaseListProperty } from "@/lib/domain/standardCaseProperties";

/** The types a comparison gives a property, the value types that name one. */
const COMPARED_TYPES: ReadonlySet<string> = new Set<CasePropertyDataType>([
	"int",
	"decimal",
	"date",
	"datetime",
]);

export interface ComparedType {
	readonly caseType: string;
	readonly property: string;
	readonly dataType: CasePropertyDataType;
}

/** A custom property read of the row a comparison stands in. */
function comparedProperty(
	expression: Expression | undefined,
): Term | undefined {
	if (expression?.kind !== "term") return undefined;
	const term = expression.term;
	return term.kind === "prop" &&
		term.caseType !== undefined &&
		(term.via === undefined || term.via.kind === "self") &&
		!isStandardCaseListProperty(term.property)
		? term
		: undefined;
}

/** Each property `tree` compares, in `context`, with a value of a type a
 *  property may take, where `untyped` says the catalog holds it untyped. */
export function comparedTypes(
	tree: Expression,
	context: ExpressionContext,
	untyped: (caseType: string, property: string) => boolean,
): ComparedType[] {
	if (context.ruleSet !== "record") return [];
	const found: ComparedType[] = [];
	const note = (
		side: Expression | undefined,
		other: Expression | undefined,
		ordering: boolean,
	): void => {
		const term = comparedProperty(side);
		if (term?.kind !== "prop" || term.caseType === undefined) return;
		if (other === undefined || !untyped(term.caseType, term.property)) return;
		let type: string | undefined;
		try {
			type = scalarDataType(typeOf(other, context)?.data);
		} catch {
			return;
		}
		// Text is not ordered, so an ordering against a literal spelled as a
		// date or a date and time orders that type.
		const text =
			other.kind === "term" &&
			other.term.kind === "literal" &&
			other.term.data_type === undefined &&
			typeof other.term.value === "string"
				? other.term.value
				: undefined;
		const shape =
			ordering && text !== undefined ? literalShape(text) : undefined;
		if (shape?.type === "date" || shape?.type === "datetime") type = shape.type;
		if (type === undefined || !COMPARED_TYPES.has(type)) return;
		found.push({
			caseType: term.caseType,
			property: term.property,
			dataType: type as CasePropertyDataType,
		});
	};
	const noteKind = (side: Expression, dataType: CasePropertyDataType): void => {
		const term = comparedProperty(side);
		if (
			term?.kind === "prop" &&
			term.caseType !== undefined &&
			untyped(term.caseType, term.property)
		)
			found.push({
				caseType: term.caseType,
				property: term.property,
				dataType,
			});
	};
	walkExpressionNodes(tree, (node) => {
		switch (node.kind) {
			case "eq":
			case "neq":
				note(node.left, node.right, false);
				note(node.right, node.left, false);
				return;
			case "gt":
			case "gte":
			case "lt":
			case "lte":
				note(node.left, node.right, true);
				note(node.right, node.left, true);
				return;
			case "between":
				note(node.left, node.lower, true);
				note(node.left, node.upper, true);
				return;
			case "within-distance":
				// A distance is measured from a location, so the property it
				// measures is one.
				noteKind({ kind: "term", term: node.property }, "geopoint");
				return;
			case "multi-select-contains":
				// Only a list of choices holds several of them.
				noteKind(
					node.property.kind === "prop"
						? { kind: "term", term: node.property }
						: (node.property as Expression),
					"multi_select",
				);
				return;
			default:
				return;
		}
	});
	return found;
}

/** One type a property: the one every comparison gives it, or `decimal`
 *  where whole numbers and decimals meet. A property compared with values of
 *  other types is left out. */
export function agreedComparedTypes(
	found: readonly ComparedType[],
): ComparedType[] {
	const byProperty = new Map<string, Set<CasePropertyDataType>>();
	for (const one of found) {
		const key = JSON.stringify([one.caseType, one.property]);
		const set = byProperty.get(key) ?? new Set<CasePropertyDataType>();
		set.add(one.dataType);
		byProperty.set(key, set);
	}
	const out: ComparedType[] = [];
	for (const [key, set] of byProperty) {
		const [caseType, property] = JSON.parse(key) as [string, string];
		const dataType =
			set.size === 1
				? [...set][0]
				: set.size === 2 && set.has("int") && set.has("decimal")
					? "decimal"
					: undefined;
		if (dataType !== undefined) out.push({ caseType, property, dataType });
	}
	return out;
}
