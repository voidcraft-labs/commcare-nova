/**
 * Finding 34: a GPS question on an app that is not a Connect app.
 *
 * `targeted-gps-question` is one survey menu whose one form holds one GPS
 * question. Location capture is off, since the app is not a Connect app,
 * and the form holds a `geopoint` bind, so HQ's build adds a bare
 * `<orx:pollsensor event="xforms-ready"/>` as the model's last child
 * (`xform.py::XForm._add_meta_2`, its `_add_pollsensor` `elif` arm), with
 * which Android starts a location poll when the form opens. The local
 * archive writes the same element (`lib/commcare/xform/metaBlock.ts::addMetaBlock`),
 * and the manifest holds it as a use HQ's build derives
 * (`questions/hq-generated-pollsensor`).
 *
 * Fixed values: the form holds the place the worker gives.
 */

import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import { proseText } from "@/lib/domain";
import { targetedDocument, targetedUuid } from "../build";
import { answerHeld } from "./echo";

export function gpsQuestion() {
	const id = "targeted-gps-question";
	const uuid = (name: string) => targetedUuid(id, name);
	const form = uuid("form");
	const doc = buildDoc({
		appId: id,
		appName: "Water points",
		modules: [
			{
				uuid: uuid("module"),
				name: "Water points",
				forms: [
					{
						uuid: form,
						name: "Record a water point",
						type: "survey",
						fields: [
							f({
								kind: "geopoint",
								uuid: uuid("place"),
								id: "place",
								label: proseText("Where is the water point?"),
							}),
						],
					},
				],
			},
		],
	});
	return targetedDocument({
		id,
		rows: ["34"],
		doc,
		expected: {
			intent: [
				answerHeld("place-held", form, "/data/place", "1.5 2.5 0.0 4.0"),
			],
		},
	});
}
