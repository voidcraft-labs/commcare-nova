import { type Element, isTag } from "domhandler";
import {
	NAMED_TILE_SLOTS,
	type NamedTileSlot,
	namedTileCell,
	type Uuid,
} from "@/lib/domain";
import { el, text } from "../../elementBuilders";
import { buildTileStyleBlock } from "./tileStyle";

const WIRE: Record<NamedTileSlot, string> = {
	topLeftImage: "top_left_image",
	topLeftText: "top_left_text",
	topRightImage: "top_right_image",
	topRightText: "top_right_text",
	middleLeftImage: "middle_left_image",
	middleLeftText: "middle_left_text",
	middleRightImage: "middle_right_image",
	middleRightText: "middle_right_text",
	bottomLeftImage: "bottom_left_image",
	bottomLeftText: "bottom_left_text",
};
export function readNamedTileSlot(value: unknown): NamedTileSlot | undefined {
	return NAMED_TILE_SLOTS.find((slot) => WIRE[slot] === value);
}
export function namedTileWireSlot(
	assignments: Record<NamedTileSlot, Uuid>,
	uuid: Uuid,
): string | undefined {
	const slot = NAMED_TILE_SLOTS.find((slot) => assignments[slot] === uuid);
	return slot && WIRE[slot];
}

/** A named template has its own field order and headers. Its sort lookup
 * uses the displayed XPath of each source column, even if a different slot
 * displays the same value first (CaseTileHelper._populate_sort_elements_in_detail). */
export function buildNamedTileFields(
	slots: Record<NamedTileSlot, Uuid>,
	fields: readonly {
		uuid?: Uuid;
		element: Element;
		format: string;
		rawHeader?: string;
	}[],
): Element[] {
	function child(node: Element | undefined, tag: string) {
		return node?.children.find(
			(item): item is Element => isTag(item) && item.name === tag,
		);
	}
	function expression(field: Element) {
		const value = child(child(child(field, "template"), "text"), "xpath");
		if (value?.attribs.function !== "$calculated_property") return value;
		const variable = value.children.find(
			(item): item is Element =>
				isTag(item) &&
				item.name === "variable" &&
				item.attribs.name === "calculated_property",
		);
		return child(variable, "xpath") ?? value;
	}
	const byUuid = new Map(fields.map((field) => [field.uuid, field]));
	const sorted = new Map<string, { field: Element; sort: Element }>();
	for (const { element } of fields) {
		const sort = child(element, "sort");
		const key = expression(element)?.attribs.function;
		if (!sort || !key) continue;
		const previous = sorted.get(key)?.sort;
		if (
			!previous ||
			(sort.attribs.order !== undefined &&
				(previous.attribs.order === undefined ||
					Number(sort.attribs.order) < Number(previous.attribs.order)))
		)
			sorted.set(key, { field: element, sort });
	}
	const result = [el("variables", {})];
	for (const slot of NAMED_TILE_SLOTS) {
		const source = byUuid.get(slots[slot]);
		const value = source && expression(source.element);
		if (!source || !value)
			throw new Error(
				"Each position on the case tile needs a field with a value.",
			);
		const image = slot.endsWith("Image");
		const locale =
			source.rawHeader ??
			child(child(child(source.element, "header"), "text"), "locale")?.attribs
				.id;
		const label = () => (locale ? [el("locale", { id: locale })] : []);
		const style = buildTileStyleBlock(namedTileCell(slot));
		if (image) style.attribs["vert-align"] = "top";
		const children = [
			style,
			el("header", {}, [el("text", {}, image ? [] : label())]),
			el("template", { form: source.format }, [
				el("text", {}, [
					...(image ? [] : [...label(), text("\u2005")]),
					value.cloneNode(true),
				]),
			]),
		];
		const sort = sorted.get(value.attribs.function);
		if (sort) {
			children.push(sort.sort.cloneNode(true));
			sorted.delete(value.attribs.function);
		}
		const endpoint = child(source.element, "endpoint-action");
		if (endpoint) children.push(endpoint.cloneNode(true));
		result.push(el("field", {}, children));
	}
	result.push(...[...sorted.values()].map(({ field }) => field));
	return result;
}
