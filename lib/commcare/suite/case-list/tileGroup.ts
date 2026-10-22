// lib/commcare/suite/case-list/tileGroup.ts
//
// The `<group>` child of a grouped tile's SHORT `<detail>` — the one
// place in the package that emits CommCare's tile-grouping vocabulary.
//
// The element is flat: a required `function` and an optional
// `header-rows` (`commcare-hq/.../suite_xml/xml_models.py::TileGroup`).
// It does not wrap the `<field>` block — grouping is a runtime
// behavior, not a structural nesting — and
// `commcare-core/.../org/commcare/xml/DetailParser.java::DetailParser.parse`
// dispatches `<detail>` children by name in a `while (nextTagInBlock)`
// loop, so its position among the siblings is not a wire constraint.
// Nova appends it after actions. Native HQ may append a Search action
// after the group; both orders parse to the same Core detail model.
//
// **`header-rows` is always written.** The attribute is optional in the
// grammar and the two sides default it DIFFERENTLY: the client falls
// back to `1`
// (`commcare-core/.../org/commcare/xml/DetailGroupParser.java::DetailGroupParser.parse`,
// where the constant is `ATTRIBUTE_NAME_HEADER_ROWS = "header-rows"`),
// while HQ's model defaults to `2`
// (`commcare-hq/.../models/case_list.py::CaseTileGroupConfig.header_rows`).
// Relying on either default silently halves or doubles the header
// depending on which side reads the app.
//
// The native HQ proof regenerates these details from actual Nova exports,
// and Core's SuiteParser reads both paths (proof/native).
//
// The `function` value is the only thing the device validates, and it
// validates it loosely: `DetailGroupParser::parse` runs
// `XPathParseTool.parseXPath` and nothing else. Nova narrows it to a
// case index by construction — see `caseTileGroupingSchema` for why —
// and the identifier's XML-element-name grammar is what makes this
// builder total. There is no escaping step because no input can need
// one.

import type { Element } from "domhandler";
import { type WireElementContext, xel } from "@/lib/commcare/elementBuilders";
import { w } from "@/lib/commcare/xpath/wire/builders";
import type { WireExpr } from "@/lib/commcare/xpath/wire/tree";
import type { CaseTileGrouping } from "@/lib/domain";

/** The group key expression: `string(./index/<identifier>)`, evaluated
 *  per row against the case node and kept as an opaque string by the
 *  runtime (`commcare-core/.../cases/entity/NodeEntityFactory::getEntity`). */
export function tileGroupFunction(identifier: string): WireExpr {
	return w.call("string", [
		w.context([w.self(), w.step("index"), w.step(identifier)]),
	]);
}

/** The `<group>` element for a grouped short detail. */
export function buildTileGroupElement(
	grouping: CaseTileGrouping,
	context: WireElementContext,
): Element {
	return xel(
		"group",
		{
			attributes: { "header-rows": String(grouping.headerRows) },
			xpath: { function: tileGroupFunction(grouping.identifier) },
		},
		context,
	);
}
