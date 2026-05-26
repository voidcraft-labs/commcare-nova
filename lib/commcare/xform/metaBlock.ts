/**
 * The OpenRosa form metadata block — `<meta>` data element + the eight
 * setvalues that populate it at form load.
 *
 * Every submitted XForm carries a `<meta>` block recording submission
 * provenance: the device that ran the form, when the user opened and
 * closed it, the user's id and name, a uuid for this submission instance,
 * the CommCare app version, and any clock drift between device and server.
 * Receiving systems (CCHQ, FormPlayer reports, mobile sync) all read these
 * for audit and integrity. Without the block, submissions are accepted on
 * the wire but downstream tooling that filters/joins on `instanceID`,
 * `timeStart`, or `userID` falls over.
 *
 * Faithful (semantically) to CCHQ's `commcare-hq/.../app_manager/xform.py::
 * XForm._add_meta_2`. Nova emits unprefixed element names (`<meta>`,
 * `<deviceID>`, etc.) matching the setvalue ref shape (`/data/meta/deviceID`)
 * — Vellum stamps the elements with an `orx:` namespace prefix, but
 * JavaRosa strips namespaces during XPath resolution so the two shapes
 * resolve to the same TreeElement at form-fill. The unprefixed shape keeps
 * the data tree consistent with how Nova names every other field.
 *
 * Always-on by design — every form gets the block, no action gating. Same
 * posture as CCHQ; the OpenRosa contract treats `<meta>` as structural
 * rather than optional.
 */

import { Element, type Text } from "domhandler";

/** Construct an XForm element. Mirrors the local `el()` helper in `builder.ts`. */
function el(
	name: string,
	attribs: Record<string, string>,
	children: Element[] = [],
): Element {
	return new Element(name, attribs, children as unknown as Text[]);
}

/**
 * The shape returned to `buildXForm`. The `dataElement` slots into the
 * primary instance's data tree alongside the form's fields; the
 * `setvalues` slot into the model alongside the form's other setvalues.
 *
 * The two arrays are returned separately because the consumer assembles
 * the model and data sections independently — keeping them together in
 * one container would force the caller to re-split.
 */
export interface MetaBlockEmission {
	readonly dataElement: Element;
	readonly setvalues: Element[];
}

/**
 * Build the meta block + its eight setvalues. Always returns the full
 * shape; emission is unconditional per the CommCare submission contract.
 *
 * Each setvalue references `instance('commcaresession')/session/context/...`
 * (the closed CommCare-populated session context — `deviceid`, `username`,
 * `userid`, `appversion`, `drift`) or a one-shot expression (`uuid()`,
 * `now()`). The `xforms-ready` event fires once at form load; the
 * `xforms-revalidate` event re-runs on every form save so the closing
 * timestamp and drift values reflect the actual submission moment, not
 * the form-open moment.
 */
export function buildMetaBlock(): MetaBlockEmission {
	// Children of <meta> — eight empty elements that the setvalues fill.
	// Element ordering matches CCHQ's `_add_meta_2` output for parity.
	const dataElement = el("meta", {}, [
		el("deviceID", {}),
		el("timeStart", {}),
		el("timeEnd", {}),
		el("username", {}),
		el("userID", {}),
		el("instanceID", {}),
		el("appVersion", {}),
		el("drift", {}),
	]);

	// One-shot capture at form load (xforms-ready) for everything except
	// timeEnd and drift, which refresh on every revalidate so the closing
	// values reflect the actual submission moment. instanceID uses uuid()
	// (a one-shot per form instance); deviceID/username/userID/appVersion
	// pull from session context; timeStart is now() at load.
	const setvalues = [
		el("setvalue", {
			ref: "/data/meta/deviceID",
			value: "instance('commcaresession')/session/context/deviceid",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: "/data/meta/timeStart",
			type: "xsd:dateTime",
			value: "now()",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: "/data/meta/timeEnd",
			type: "xsd:dateTime",
			value: "now()",
			event: "xforms-revalidate",
		}),
		el("setvalue", {
			ref: "/data/meta/username",
			value: "instance('commcaresession')/session/context/username",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: "/data/meta/userID",
			value: "instance('commcaresession')/session/context/userid",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: "/data/meta/instanceID",
			value: "uuid()",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: "/data/meta/appVersion",
			value: "instance('commcaresession')/session/context/appversion",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: "/data/meta/drift",
			value:
				"if(count(instance('commcaresession')/session/context/drift) = 1, instance('commcaresession')/session/context/drift, '')",
			event: "xforms-revalidate",
		}),
	];

	return { dataElement, setvalues };
}
