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
// Nova pins it last to match HQ's own emission order
// (`case_tiles.py::CaseTileHelper.build_case_tile_detail` assigns
// `detail.tile_group` after the fields and the register action) and the
// one correctly-spelled fixture,
// `formplayer/src/test/resources/archives/case_list_auto_select/suite.xml`.
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
// Beware the spelling when reading upstream fixtures: three of the four
// `<group>` elements in the Dimagi trees write `grid-header-rows`,
// which parses as an unknown attribute and silently takes the client
// default, so they prove nothing about header-row behavior. The byte
// oracle for this emitter is HQ's own inline assertion,
// `commcare-hq/corehq/apps/app_manager/tests/test_suite_case_tiles_grouping.py::SuiteCaseTilesGroupingTest`.
//
// The `function` value is the only thing the device validates, and it
// validates it loosely: `DetailGroupParser::parse` runs
// `XPathParseTool.parseXPath` and nothing else. Nova narrows it to a
// case index by construction — see `caseTileGroupingSchema` for why —
// and the identifier's XML-element-name grammar is what makes this
// builder total. There is no escaping step because no input can need
// one.

import type { Element } from "domhandler";
import { el } from "@/lib/commcare/elementBuilders";
import type { CaseTileGrouping } from "@/lib/domain";

/** The group key expression: `string(./index/<identifier>)`, evaluated
 *  per row against the case node and kept as an opaque string by the
 *  runtime (`commcare-core/.../cases/entity/NodeEntityFactory::getEntity`). */
export function tileGroupFunction(identifier: string): string {
	return `string(./index/${identifier})`;
}

/** The `<group>` element for a grouped short detail. */
export function buildTileGroupElement(grouping: CaseTileGrouping): Element {
	return el("group", {
		function: tileGroupFunction(grouping.identifier),
		"header-rows": String(grouping.headerRows),
	});
}
