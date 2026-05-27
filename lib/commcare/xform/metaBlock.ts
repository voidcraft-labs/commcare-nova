/**
 * The OpenRosa form metadata block — `<meta>` data element, the eight
 * setvalues that populate it at form load, and the two `<bind>` elements
 * that type its dateTime children.
 *
 * Every Nova-emitted form must carry this block: receiving systems (CCHQ,
 * FormPlayer reports, mobile sync) read `instanceID`, `timeStart`,
 * `timeEnd`, `userID`, etc. for audit and per-submission correlation.
 * Without the block, submissions are accepted on the wire but downstream
 * tooling that filters or joins on these fields falls over.
 *
 * Shape mirrors `commcare-hq/.../app_manager/xform.py::XForm._add_meta_2`.
 * Nova emits unprefixed element names (`<meta>`, `<deviceID>`, …)
 * matching the setvalue ref shape (`/data/meta/...`). Vellum stamps the
 * elements with an `orx:` prefix; JavaRosa's `TreeElement` keys child
 * lookup by local name (`TreeElement::getChild`) and CCHQ's form
 * processor strips namespaces via `xml2json`, so the unprefixed shape
 * resolves to the same TreeElement and JSON key at submission time. The
 * unprefixed shape keeps the data tree consistent with how Nova names
 * every other field.
 *
 * `<setvalue>` does not carry a `type` attribute in XForms 1.0/1.1 —
 * JavaRosa silently ignores unknown attributes there. Datatype hints
 * live on a parallel `<bind type="xsd:dateTime">`, which is what CCHQ's
 * `add_setvalue` actually emits internally (verified against the
 * `tests/data/form_preparation_v2/open_case.xml` Vellum fixture).
 *
 * Known gaps vs. `_add_meta_2`: Nova does not yet model
 * `form.get_auto_gps_capture()` (which would add a `<location>` element
 * and an `xforms-ready` pollsensor action) or `app.enable_auto_gps`
 * (which would emit a pollsensor for any geopoint bind). When auto-GPS
 * lands in Nova's authoring layer, these conditional emissions follow
 * the same shape pattern as the meta block itself.
 */

import type { Element } from "domhandler";
import { el } from "@/lib/commcare/elementBuilders";
import { FormPath } from "@/lib/commcare/xform/formPath";

/**
 * What `buildMetaBlock` produces for the consumer to splice in.
 *
 *   - `dataElement` — the `<meta>` element under the primary `<data>` instance.
 *   - `setvalues` — the eight `<setvalue>` actions that populate its children
 *     at form load / save (`xforms-ready` and `xforms-revalidate` events).
 *   - `binds` — the two `<bind type="xsd:dateTime">` elements that type
 *     `timeStart` and `timeEnd`. Setvalues carry no type attribute in
 *     XForms; the dateTime type lives on a parallel bind.
 */
export interface MetaBlockEmission {
	readonly dataElement: Element;
	readonly setvalues: Element[];
	readonly binds: Element[];
}

/**
 * Build the meta block. Always returns the full shape; emission is
 * unconditional per the CommCare submission contract.
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
	// Children of <meta>. Element list mirrors CCHQ's `_add_meta_2` tag
	// tuple; order has no semantic effect on JavaRosa parsing (the tree
	// is built by element name) but keeps emitted bytes diffable against
	// the canonical Vellum fixture during review.
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

	// One meta-child path per setvalue / bind, constructed via FormPath so the
	// `/data/meta/...` shape is structural rather than string-templated. Every
	// downstream attribute reads the same typed value through `.toXPath()`.
	const meta = FormPath.root().child("meta");
	const deviceIDPath = meta.child("deviceID").toXPath();
	const timeStartPath = meta.child("timeStart").toXPath();
	const timeEndPath = meta.child("timeEnd").toXPath();
	const usernamePath = meta.child("username").toXPath();
	const userIDPath = meta.child("userID").toXPath();
	const instanceIDPath = meta.child("instanceID").toXPath();
	const appVersionPath = meta.child("appVersion").toXPath();
	const driftPath = meta.child("drift").toXPath();

	// One-shot capture at form load (xforms-ready) for everything except
	// timeEnd and drift, which refresh on every revalidate so the closing
	// values reflect the actual submission moment. instanceID uses uuid()
	// (a one-shot per form instance); deviceID/username/userID/appVersion
	// pull from session context; timeStart is now() at load.
	const setvalues = [
		el("setvalue", {
			ref: deviceIDPath,
			value: "instance('commcaresession')/session/context/deviceid",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: timeStartPath,
			value: "now()",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: timeEndPath,
			value: "now()",
			event: "xforms-revalidate",
		}),
		el("setvalue", {
			ref: usernamePath,
			value: "instance('commcaresession')/session/context/username",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: userIDPath,
			value: "instance('commcaresession')/session/context/userid",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: instanceIDPath,
			value: "uuid()",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: appVersionPath,
			value: "instance('commcaresession')/session/context/appversion",
			event: "xforms-ready",
		}),
		el("setvalue", {
			ref: driftPath,
			value:
				"if(count(instance('commcaresession')/session/context/drift) = 1, instance('commcaresession')/session/context/drift, '')",
			event: "xforms-revalidate",
		}),
	];

	// Datatype hints for the two dateTime nodes. JavaRosa's setvalue
	// processor doesn't honor `type` on `<setvalue>`; the bind is the
	// canonical place. Downstream consumers (FormPlayer report queries,
	// mobile sync, CCHQ form-processor metadata extraction) read the bind's
	// declared type to know the field is a timestamp, not a free-form
	// string.
	const binds = [
		el("bind", {
			nodeset: timeStartPath,
			type: "xsd:dateTime",
		}),
		el("bind", {
			nodeset: timeEndPath,
			type: "xsd:dateTime",
		}),
	];

	return { dataElement, setvalues, binds };
}
