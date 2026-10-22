import type { LookupOptionsSource } from "@/lib/domain";
import { isMatchAll } from "@/lib/domain/expression/builders";
import type { ExpressionContext } from "@/lib/domain/expression/context";
import { simplifyForEmission } from "@/lib/domain/expression/simplify";
import type { LookupWireNaming } from "./lookup/naming";
import type { FormNodeProjection } from "./xpath/formNodeProjection";
import { w } from "./xpath/wire/builders";
import {
	toWire,
	type WireTarget,
	type WireTermBindings,
} from "./xpath/wire/fromExpression";
import { lookupInstance } from "./xpath/wire/instances";
import type { WireExpr } from "./xpath/wire/tree";

/**
 * The nodeset of a lookup-backed choice list: the table's rows in its
 * fixture instance, narrowed by the authored row filter. A form's itemset
 * reads the XForm's own instance id and a Search prompt's the suite fixture
 * id (`instanceScope`); the filter's form reads are the caller's, since only
 * a form question has sibling answers. Core evaluates the nodeset with the
 * question as `current()`, each row as the predicate's context
 * (`org/javarosa/core/model/ItemsetBinding.java::getChoices`).
 */
export function lookupOptionsNodeset(
	source: Pick<LookupOptionsSource, "tableId" | "filter">,
	scope: {
		readonly target: WireTarget;
		readonly types: ExpressionContext;
		readonly naming: LookupWireNaming;
		readonly instanceScope: "xform" | "suite";
		readonly form?: FormNodeProjection;
		readonly bindings?: Omit<WireTermBindings, "lookup">;
	},
): WireExpr {
	const table = scope.naming.tableFor(source.tableId);
	const predicates: WireExpr[] = [];
	if (source.filter !== undefined) {
		const filter = simplifyForEmission(source.filter);
		if (!isMatchAll(filter))
			predicates.push(
				toWire(filter, {
					target: scope.target,
					types: scope.types,
					...(scope.form === undefined ? {} : { form: scope.form }),
					anchor: { kind: "unaddressable" },
					bindings: {
						...scope.bindings,
						lookup: {
							naming: scope.naming,
							instanceScope: scope.instanceScope,
							rowScope: {
								tableId: source.tableId,
								caseAnchor: { kind: "unaddressable" },
							},
						},
					},
				}),
			);
	}
	return w.instance(
		lookupInstance(source.tableId, scope.naming, scope.instanceScope),
		[w.step(table.listElementName), w.step(table.rowElementName, predicates)],
	);
}
