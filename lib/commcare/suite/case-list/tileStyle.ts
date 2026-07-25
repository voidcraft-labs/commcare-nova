// lib/commcare/suite/case-list/tileStyle.ts
//
// The `<style>` child of a tile-laid-out `<field>` — the one place in
// the package that emits CommCare's grid vocabulary.
//
// `<style>` and `<grid>` are ONE indivisible wire unit, not an element
// with an optional child. `DetailFieldParser::parseStyle`
// (`commcare-core/.../org/commcare/xml/DetailFieldParser.java`) runs
// `StyleParser` and then `GridParser` unconditionally whenever a
// `<style>` element is present, and `GridParser::parse`
// (`commcare-core/.../org/commcare/xml/GridParser.java`) opens with
// `checkNode("grid")` and then reads all four coordinates through
// UNGUARDED `Integer.parseInt` calls. So:
//
//   - a `<style>` with no `<grid>` child is a hard InvalidStructureException
//     at install, and
//   - a `<grid>` missing any one of the four attributes raises a raw
//     NumberFormatException that escapes the parser's structured-error path
//     entirely.
//
// HQ can emit both of those states — its custom branch
// (`commcare-hq/corehq/apps/app_manager/suite_xml/features/case_tiles.py::CaseTileHelper.build_case_tile_detail`)
// guards on `any(... is not None ...)` across the four coordinates
// rather than `all(...)`. Nova cannot: `TileCell` carries the four as
// required slots of one object, so this emitter has no partial input to
// receive and needs no guard.
//
// The five presentation attributes are the whole of what `<style>`
// carries besides the grid, and each is optional
// (`commcare-core/.../org/commcare/xml/StyleParser.java::StyleParser.parse`
// reads every one with a plain `getAttributeValue`, and
// `Boolean.parseBoolean(null)` makes both booleans default false).
// `css-id` is the sixth attribute the parser reads; Nova does not emit
// it because the Web Apps renderer never consumes it (`Tile.cssId` is
// serialized to the client and referenced nowhere in cloudcare), so an
// authoring surface for it would be an affordance with no effect.

import type { Element } from "domhandler";
import { el } from "@/lib/commcare/elementBuilders";
import type { TileCell, TileVerticalAlign } from "@/lib/domain";

/**
 * Nova's vertical-alignment words → the wire values Web Apps honors.
 *
 * The suite parser stores `vert-align` as an unvalidated string, but
 * the renderer passes it through
 * `commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/menus/views.js::getValidFieldAlignment`,
 * which rewrites anything outside
 * `commcare-hq/corehq/apps/cloudcare/static/cloudcare/js/formplayer/constants.js::ALLOWED_FIELD_ALIGNMENTS`
 * (`start`, `end`, `center`, `left`, `right`) to `start`. HQ's own
 * shipped `icon_text_grid` template emits `vert-align="top"` and Web
 * Apps silently ignores it. Emitting only honored values is what makes
 * "top" mean top on the device.
 */
export const TILE_VERTICAL_ALIGN_WIRE: Readonly<
	Record<TileVerticalAlign, string>
> = {
	top: "start",
	middle: "center",
	bottom: "end",
};

/**
 * Build the `<style><grid/></style>` child for one placed tile cell.
 *
 * Attribute order follows CommCare HQ's own emitted bytes — presentation
 * attributes on `<style>` in `horz-align`, `vert-align`, `font-size`,
 * `show-border`, `show-shading` order, and the grid attributes in
 * `grid-height`, `grid-width`, `grid-x`, `grid-y` order — so an emitted
 * field is byte-comparable against
 * `commcare-hq/corehq/apps/app_manager/tests/data/suite/suite-case-tiles.xml`
 * and `…/case-tile-case-detail.xml` without normalizing attribute order.
 *
 * A presentation slot the author never set is OMITTED rather than
 * emitted at its default. That distinction is real for `font-size`: an
 * absent attribute leaves the renderer's generated rule as an empty
 * `font-size: ;` declaration the browser discards, so the cell inherits
 * the list's size — there is no `medium` fallback at runtime.
 */
export function buildTileStyleBlock(cell: TileCell): Element {
	const attribs: Record<string, string> = {};
	if (cell.horizontalAlign !== undefined) {
		attribs["horz-align"] = cell.horizontalAlign;
	}
	if (cell.verticalAlign !== undefined) {
		attribs["vert-align"] = TILE_VERTICAL_ALIGN_WIRE[cell.verticalAlign];
	}
	if (cell.fontSize !== undefined) attribs["font-size"] = cell.fontSize;
	if (cell.showBorder !== undefined) {
		attribs["show-border"] = String(cell.showBorder);
	}
	if (cell.showShading !== undefined) {
		attribs["show-shading"] = String(cell.showShading);
	}
	return el("style", attribs, [
		el("grid", {
			"grid-height": String(cell.height),
			"grid-width": String(cell.width),
			"grid-x": String(cell.x),
			"grid-y": String(cell.y),
		}),
	]);
}
