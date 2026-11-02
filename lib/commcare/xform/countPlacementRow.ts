/**
 * A count-placement row's id and index: the nodes that give each row of a
 * count-placement repeat its place and the record at that place. A query
 * repeat writes them (`builder.ts::buildQueryRepeat`), and so does a
 * several-case form's selection inside a repeat
 * (`caseOps.ts::emitSelectedCountPlacement`).
 *
 *   <item jr:template=""> <id/> <index/> …</item>
 *
 * The index is the row's 0-based place, set once by a `jr-insert` setvalue
 * reading `position(..)`. The row was just made then and is relevant, and a
 * row never moves (`jr:noAddRemove`). Every later read goes through the
 * stored index, never `position(..)`. A row past the end of the result is not
 * relevant, and Core drops a node that is not relevant from every nodeset
 * (`XPathLazyNodeset.java::performEvaluation`), so `position(..)` there
 * finds no node and throws (`XPathPositionFunc.java::evalBody`). The stored
 * index reads blank in such a row instead (`XPathPathExpr.java::getRefValue`),
 * which gives a blank id.
 *
 * The id is a calculate over the stored index, so it follows the result as
 * answers change. It is also set at `jr-insert` from `position(..)`, because
 * Core runs every `jr-insert` setvalue before any calculate
 * (`FormDef.java::createNewRepeat`), and an authored default that reads the
 * row's id is one of them. Setvalues are written in data-tree order, so the
 * id's comes before the index's and before every authored default in the row.
 */

import type { Element } from "domhandler";
import { type WireElementContext, xel } from "@/lib/commcare/elementBuilders";
import { w } from "../xpath/wire/builders";
import type { WireExpr } from "../xpath/wire/tree";
import type { FormPath } from "./formPath";

/** The names a count-placement row's pieces read: the wrapper's ids and
 * count, the row's id and index. */
export interface CountPlacementRowNames {
	readonly ids: string;
	readonly count: string;
	readonly id: string;
	readonly index: string;
}

/** The row's binds (id, then index) and its `jr-insert` setvalues. */
export interface CountPlacementRowPieces {
	readonly binds: readonly Element[];
	readonly setvalues: readonly Element[];
}

export function countPlacementRowPieces(
	rowPath: FormPath,
	names: CountPlacementRowNames,
	context: WireElementContext,
): CountPlacementRowPieces {
	const idPath = rowPath.child(names.id);
	const indexPath = rowPath.child(names.index);
	const countFromRow = w.context([w.parent(), w.parent(), w.step(names.count)]);
	const idsFromRow = w.context([w.parent(), w.parent(), w.step(names.ids)]);
	const idAt = (place: WireExpr): WireExpr =>
		w.call("if", [
			w.lt(place, countFromRow),
			w.call("selected-at", [idsFromRow, place]),
			w.str(""),
		]);
	const rowPosition = w.call("position", [w.context([w.parent()])]);
	const storedIndex = w.context([w.parent(), w.step(names.index)]);
	const setvalue = (ref: FormPath, value: WireExpr): Element =>
		xel(
			"setvalue",
			{
				attributes: { event: "jr-insert" },
				xpath: { ref: ref.toWire(), value },
			},
			context,
		);
	return {
		binds: [
			xel(
				"bind",
				{
					xpath: {
						nodeset: idPath.toWire(),
						"vellum:nodeset": idPath.toWire("hashtag"),
						calculate: idAt(storedIndex),
					},
				},
				context,
			),
			xel(
				"bind",
				{
					attributes: { type: "xsd:int" },
					xpath: {
						nodeset: indexPath.toWire(),
						"vellum:nodeset": indexPath.toWire("hashtag"),
					},
				},
				context,
			),
		],
		setvalues: [
			setvalue(idPath, idAt(rowPosition)),
			setvalue(indexPath, rowPosition),
		],
	};
}
