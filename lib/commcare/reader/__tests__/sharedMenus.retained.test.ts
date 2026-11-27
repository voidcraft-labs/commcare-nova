import { expect, it } from "vitest";
import { laneInputOf, retainedBase } from "@/__tests__/helpers/retainedHqApps";
import {
	retainedBodyJson,
	retainedReadingRead,
} from "@/__tests__/helpers/retainedHqReads";
import { storedDocument } from "@/proof/corpus/documents";
import { readForLane } from "@/proof/reader/laneReading";
import { expandDoc } from "../../expander";
import { targetWireIdentity } from "../../wireIdentity";

/** HQ scrubs form ids in exported forms and in declared FormIdProperty references.
 * ShadowModule.excluded_form_ids and ShadowFormEndpoint.form_id aren't declared references,
 * so they still name the application resource's actual form ids. */
it("adopts, republishes and rereads a second route using HQ's actual form ids after two independent source downloads", async () => {
	const base = retainedBase("hq-plain");
	const input = laneInputOf(base);
	if (!base.source.body || !base.application.body)
		throw new Error("Missing retained HQ responses.");
	const download = JSON.parse(base.source.body);
	const resource = JSON.parse(base.application.body);
	const owner = download.modules[0];
	const real = resource.modules[0];
	const [first, second] = real.forms as { unique_id: string; xmlns: string }[];
	expect(first.unique_id).not.toBe(owner.forms[0].unique_id);
	expect(second.unique_id).not.toBe(owner.forms[1].unique_id);
	const routeId = "00000000000000000000000000000017";
	const nativeMenus = retainedBodyJson(retainedReadingRead("source-shadow"))
		.modules as Record<string, unknown>[];
	const native = nativeMenus.find(
		(menu) => menu.doc_type === "ShadowModule" && menu.source_module_id,
	);
	if (!native)
		throw new Error("The real HQ capture has no source-backed menu.");
	download.modules.push({
		...native,
		name: { en: "At home" },
		doc_type: "ShadowModule",
		module_type: "shadow",
		unique_id: routeId,
		forms: [],
		shadow_module_version: 2,
		source_module_id: owner.unique_id,
		case_type: null,
		case_details: structuredClone(owner.case_details),
		excluded_form_ids: [first.unique_id],
		session_endpoint_id: "at-home",
		form_session_endpoints: [
			{
				doc_type: "ShadowFormEndpoint",
				form_id: second.unique_id,
				session_endpoint_id: "home-followup",
			},
		],
	});
	resource.modules.push({
		...real,
		unique_id: routeId,
		name: { en: "At home" },
		forms: [],
	});
	const answers = {
		...input,
		source: { ...base.source, body: JSON.stringify(download) },
		application: { ...base.application, body: JSON.stringify(resource) },
	};
	const adopted = await readForLane(answers);
	if (adopted.kind !== "read")
		throw new Error(
			JSON.stringify(adopted.kind === "account" ? adopted.findings : adopted),
		);
	const route = Object.values(adopted.doc.modules).find(
		(menu) => menu.name === "At home",
	);
	if (!route)
		throw new Error("The second menu was missing from the adopted app.");
	const link = route.formsFromMenu?.entryPoints?.[0];
	if (!link) throw new Error("The second menu lost its form link.");
	expect(link?.entryPoint.id).toBe("home-followup");
	expect(adopted.doc.forms[link.formUuid].name).toBe("Followup Form");
	const emitted = expandDoc(adopted.doc, {
		identity: targetWireIdentity(adopted.identity),
	});
	expect(emitted.modules[1]).toMatchObject({
		unique_id: routeId,
		source_module_id: owner.unique_id,
		excluded_form_ids: [first.unique_id],
		form_session_endpoints: [
			{ form_id: second.unique_id, session_endpoint_id: "home-followup" },
		],
	});
	for (const [i, form] of owner.forms.entries()) {
		const next = `0000000000000000000000000000000${i}`;
		download._attachments[`${next}.xml`] =
			download._attachments[`${form.unique_id}.xml`];
		delete download._attachments[`${form.unique_id}.xml`];
		form.unique_id = next;
	}
	const back = await readForLane({
		...answers,
		source: { ...base.source, body: JSON.stringify(download) },
		identity: "match",
		document: {
			doc: storedDocument(adopted.doc),
			hqAuthored: { identity: adopted.identity },
		},
	});
	if (back.kind !== "read")
		throw new Error(
			JSON.stringify(back.kind === "account" ? back.findings : back),
		);
	expect(back.doc.modules[route.uuid].formsFromMenu).toEqual(
		route.formsFromMenu,
	);
	expect(back.doc.forms[link.formUuid].uuid).toBe(link.formUuid);
});
