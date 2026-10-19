import {
	GEOPOINT_CENTER_PATTERN,
	GEOPOINT_RAW_CENTER_PATTERN,
} from "@/lib/domain/expression/geopoint";
import { w } from "./builders";
import type { WireExpr } from "./tree";

export function normalizeGeopoint(value: WireExpr): WireExpr {
	return w.call("replace", [
		w.call("replace", [
			w.call("translate", [value, w.str(","), w.str(" ")]),
			w.str("^\\s+|\\s+$"),
			w.str(""),
		]),
		w.str("\\s+"),
		w.str(" "),
	]);
}
export function validGeopointCenter(
	raw: WireExpr,
	normalized = normalizeGeopoint(raw),
): WireExpr {
	const coordinate = (index: number) =>
		w.call("double", [w.call("selected-at", [normalized, w.num(index)])]);
	return w.and(
		w.call("regex", [raw, w.str(GEOPOINT_RAW_CENTER_PATTERN)]),
		w.call("regex", [normalized, w.str(GEOPOINT_CENTER_PATTERN)]),
		w.gte(coordinate(0), w.num(-90)),
		w.lte(coordinate(0), w.num(90)),
		w.gte(coordinate(1), w.num(-180)),
		w.lte(coordinate(1), w.num(180)),
	);
}
