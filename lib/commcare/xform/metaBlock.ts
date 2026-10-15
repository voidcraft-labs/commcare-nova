/**
 * The OpenRosa form metadata block — the `<orx:meta>` data node, the eight
 * setvalues that populate it at form load/save, and the two
 * `<bind type="xsd:dateTime">` elements that type its timestamp children.
 *
 * CCHQ injects this block server-side at app-render time
 * (`commcare-hq/.../app_manager/xform.py::XForm._add_meta_2`, reached for every
 * form via `Form.add_stuff_to_xform` → `add_case_and_meta`), stripping any
 * pre-existing meta first. So the block is NOT part of a form's authored source:
 * a Vellum-edited form never carries it, and CCHQ regenerates it on every build.
 * The HQ-upload path therefore omits it — `expandDoc`'s form source has no meta
 * block, and CCHQ adds it when it renders the app. Only the local `.ccz` path,
 * which has no CCHQ render step, injects the block itself: `addMetaBlock` is that
 * injection, the same build-time-only split as the case transaction blocks (see
 * `caseBlocks.ts`).
 *
 * The split is load-bearing, not cosmetic. CCHQ's form builder (Vellum) parses
 * every `<data>` child as a question and rejects a `<meta>` / `<orx:meta>` node
 * ("'meta' is not a valid Question ID" — `meta` is reserved, and a namespace
 * prefix is an illegal node-name character). A source that carries the block
 * can't be opened in the form builder, even though the build itself strips and
 * re-adds it. The block belongs only where the bytes ship without a CCHQ render
 * step — the `.ccz` — never in the uploaded source.
 *
 * The element shape mirrors `_add_meta_2` exactly: `<orx:meta>` in the OpenRosa
 * namespace (`xmlns:orx` declared on the form root by `xform/builder.ts`) with
 * `<cc:appVersion>` in the CommCare namespace. The setvalue / bind refs stay
 * UNPREFIXED (`/data/meta/...`) because JavaRosa resolves instance paths by local
 * name (`TreeElement::getChild`), so `/data/meta/deviceID` resolves against the
 * namespaced `<orx:meta><orx:deviceID>` at runtime.
 *
 * `<setvalue>` carries no `type` attribute in XForms 1.x — JavaRosa ignores
 * unknown attributes there — so the dateTime datatype hint for `timeStart` /
 * `timeEnd` lives on a parallel `<bind type="xsd:dateTime">`, which is what
 * `_add_meta_2` emits.
 *
 * Location follows `_add_meta_2` too. A form of an app that captures the
 * worker's location (a Connect app, whose HQ JSON sets `auto_gps_capture`)
 * gets `<cc:location/>` as the meta block's last child, and the model's last
 * two children are `<orx:pollsensor event="xforms-ready"
 * ref="/data/meta/location"/>` and its `geopoint` bind: Android starts a
 * location poll when the form opens and writes the fix there. Any other form
 * whose model holds a `geopoint` bind gets the bare `<orx:pollsensor
 * event="xforms-ready"/>` as the model's last child, as HQ's `elif` arm
 * writes it, so Android starts the same poll for a GPS question on both
 * builds. A model holds one pollsensor or none.
 */

import { Element } from "domhandler";
import { getChildren } from "domutils";
import { el } from "@/lib/commcare/elementBuilders";
import {
	appendChildren,
	ensureInstance,
	findDataElement,
	findModelElement,
	insertBeforeItext,
	parseXForm,
	serializeXForm,
} from "@/lib/commcare/xform/domSplice";
import { FormPath } from "@/lib/commcare/xform/formPath";

/**
 * The three sibling groups `buildMetaBlock` produces for `addMetaBlock` to
 * splice into a parsed XForm:
 *
 *   - `dataElement` — the `<orx:meta>` element appended under the primary
 *     `<data>` instance.
 *   - `setvalues` — the eight `<setvalue>` actions populating its children at
 *     form load (`xforms-ready`) and save (`xforms-revalidate`).
 *   - `binds` — the two `<bind type="xsd:dateTime">` elements typing `timeStart`
 *     and `timeEnd` (setvalues carry no XForms type attribute, so the dateTime
 *     type lives on a parallel bind).
 */
interface MetaBlockEmission {
	readonly dataElement: Element;
	readonly setvalues: Element[];
	readonly binds: Element[];
}

/**
 * Build the meta block's three sibling groups. Always returns the full shape;
 * the block is unconditional per the CommCare submission contract.
 *
 * Each setvalue references `instance('commcaresession')/session/context/...`
 * (the closed CommCare-populated session context — `deviceid`, `username`,
 * `userid`, `appversion`, `drift`) or a one-shot expression (`uuid()`, `now()`).
 * The `xforms-ready` event fires once at form load; `xforms-revalidate` re-runs
 * on every form save, so the closing timestamp and drift reflect the actual
 * submission moment, not the form-open moment.
 */
function buildMetaBlock(captureLocation: boolean): MetaBlockEmission {
	// Children of `<orx:meta>`. The meta nodes carry the OpenRosa `orx:`
	// namespace (declared on the `h:html` root), with `appVersion` in the
	// CommCare `cc:` namespace declared on the meta element itself — exactly
	// CCHQ's `_add_meta_2` shape. Element order has no JavaRosa semantics (the
	// tree is keyed by local name) but keeps emitted bytes diffable against the
	// CCHQ fixture.
	const dataElement = el(
		"orx:meta",
		{ "xmlns:cc": "http://commcarehq.org/xforms" },
		[
			el("orx:deviceID", {}),
			el("orx:timeStart", {}),
			el("orx:timeEnd", {}),
			el("orx:username", {}),
			el("orx:userID", {}),
			el("orx:instanceID", {}),
			el("cc:appVersion", {}),
			el("orx:drift", {}),
			...(captureLocation ? [el("cc:location", {})] : []),
		],
	);

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

	// Datatype hints for the two dateTime nodes. JavaRosa's setvalue processor
	// doesn't honor `type` on `<setvalue>`; the bind is the canonical place.
	// Downstream consumers (FormPlayer report queries, mobile sync, CCHQ
	// form-processor metadata extraction) read the bind's declared type to know
	// the field is a timestamp, not a free-form string.
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

/** The location node a capturing form's poll writes its fix into. */
const LOCATION_PATH = FormPath.root().child("meta").child("location").toXPath();

/** Whether the model holds a `geopoint` bind, the shape HQ's `elif` reads. */
function holdsGeopointBind(model: Element): boolean {
	return getChildren(model).some(
		(child) =>
			child instanceof Element &&
			child.name === "bind" &&
			child.attribs.type === "geopoint",
	);
}

/**
 * The pollsensor HQ's `_add_meta_2` appends to the model, as its last
 * children: with location capture, the one that writes `meta/location` and
 * that node's `geopoint` bind; without it, the bare one where the form holds
 * a `geopoint` bind; otherwise none.
 */
function pollsensorNodes(model: Element, captureLocation: boolean): Element[] {
	if (captureLocation) {
		return [
			el("orx:pollsensor", { event: "xforms-ready", ref: LOCATION_PATH }),
			el("bind", { nodeset: LOCATION_PATH, type: "geopoint" }),
		];
	}
	return holdsGeopointBind(model)
		? [el("orx:pollsensor", { event: "xforms-ready" })]
		: [];
}

/**
 * Splice the OpenRosa meta block into a serialized XForm. Mirrors CCHQ's
 * build-time `_add_meta_2`: append `<orx:meta>` under the primary `<data>`
 * instance, insert the eight setvalues + two dateTime binds into `<model>`,
 * declare the `commcaresession` instance the setvalues read from, and append
 * the pollsensor HQ appends (`pollsensorNodes`).
 *
 * `captureLocation` is the local twin of the HQ JSON's `auto_gps_capture`:
 * the compiler sets it for a Connect app, the same condition `expandDoc`
 * writes the HQ value under.
 *
 * Runs only on the local `.ccz` path (after `addCaseBlocks`), never on the
 * HQ-upload source — CCHQ injects its own meta block at render time, and a meta
 * block in the source breaks the CCHQ form builder. See this module's file
 * comment for why the split is load-bearing.
 *
 * `commcaresession` is declared idempotently: a form that already references the
 * session instance (via a case block's setvalue or a field XPath) keeps its one
 * declaration; a survey form with no other session reference gets it here so the
 * meta setvalues' `instance('commcaresession')` refs resolve.
 */
export function addMetaBlock(
	xform: string,
	options: { readonly captureLocation?: boolean } = {},
): string {
	const captureLocation = options.captureLocation === true;
	const meta = buildMetaBlock(captureLocation);
	const doc = parseXForm(xform);

	// Append `<orx:meta>` last under `<data>`. On the `.ccz` path `addCaseBlocks`
	// has already appended the `<case>` transaction block, so appending meta last
	// yields the case-before-meta instance order CCHQ's `_add_meta_2` produces.
	const dataEl = findDataElement(doc, "addMetaBlock");
	appendChildren(dataEl, [meta.dataElement]);

	const modelEl = findModelElement(doc, "addMetaBlock");
	// The meta setvalues read `instance('commcaresession')/session/context/...`,
	// so the form requires the session instance. Mirrors `_add_meta_2`'s
	// `add_instance('commcaresession', src='jr://instance/session')`.
	ensureInstance(modelEl, "commcaresession", "jr://instance/session");
	insertBeforeItext(modelEl, [...meta.binds, ...meta.setvalues]);
	// HQ appends its pollsensor after everything else in the model, itext
	// included.
	appendChildren(modelEl, pollsensorNodes(modelEl, captureLocation));

	return serializeXForm(doc);
}
