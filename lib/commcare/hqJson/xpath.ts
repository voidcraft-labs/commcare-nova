/** HQ's expression fields retain their trees and interpolation mode until the
 * complete application crosses this boundary. Public HQ values contain text. */
import type { HqApplication, HqForm, HqFormLink, HqModule } from "../types";
import { serializeWire } from "../xpath/wire/serialize";
import type { WireExpr, WireMode } from "../xpath/wire/tree";

export type HqInterpolation = Extract<
	WireMode,
	{ target: "hq-json" }
>["interpolation"];

export class HqXPath {
	constructor(
		readonly expression: WireExpr,
		readonly interpolation: HqInterpolation,
	) {}
}

export function hqXPath(
	expression: WireExpr,
	interpolation: HqInterpolation = "none",
): HqXPath {
	return new HqXPath(expression, interpolation);
}

/** Every HQ expression carrier holds one resolved wire tree. */
export type HqLinkXPath = HqXPath;
export type HqApplicationTree = HqApplication<HqXPath, HqLinkXPath>;
export type HqModuleTree = HqModule<HqXPath, HqLinkXPath>;
export type HqFormTree = HqForm<HqXPath, HqLinkXPath>;
export type HqFormLinkTree = HqFormLink<HqLinkXPath>;

export function hqXPathText(value: HqXPath): string {
	const printed = serializeWire(value.expression, {
		target: "hq-json",
		interpolation: value.interpolation,
	});
	if (printed === undefined)
		throw new Error(
			"Nova could not print an HQ expression. Only a form-builder shadow may be withheld; check the expression's serialization mode.",
		);
	return printed.text;
}

function serializeValue(value: unknown): unknown {
	if (value instanceof HqXPath) return hqXPathText(value);
	if (Array.isArray(value)) return value.map(serializeValue);
	if (value !== null && typeof value === "object")
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [key, serializeValue(entry)]),
		);
	return value;
}

export function serializeHqApplication(
	value: HqApplicationTree,
): HqApplication {
	// Every XPath-bearing field is typed by HqXPath. The walk preserves every
	// key and its insertion order.
	return serializeValue(value) as HqApplication;
}
