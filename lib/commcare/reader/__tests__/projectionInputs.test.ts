import { describe, expect, it } from "vitest";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { Form } from "@/lib/domain";
import { readCases } from "../caseManagement/__tests__/caseReading";
import { appPlace } from "../place";
import { readProjectionInputs } from "../projectionInputs";

function app() {
	return buildDoc({
		modules: [
			{
				name: "Patients",
				caseType: "patient",
				forms: [
					{
						name: "Visit",
						type: "followup",
						fields: [
							f({
								kind: "text",
								id: "weight",
								caseWrite: { caseType: "patient", property: "weight" },
							}),
						],
					},
				],
			},
		],
	});
}

/** Re-keys every menu and form of the emitted app with ids none of Nova's derivations gives. */
function foreignIds(app: {
	modules: Array<
		Record<string, unknown> & { forms: Array<Record<string, unknown>> }
	>;
	_attachments?: unknown;
}): void {
	const attachments = app._attachments as Record<string, string>;
	app.modules.forEach((module, m) => {
		module.unique_id = `hq-menu-${m}`;
		module.forms.forEach((form, i) => {
			const oldId = form.unique_id as string;
			const oldXmlns = form.xmlns as string;
			const xmlns = `http://openrosa.org/formdesigner/hq-${m}-${i}`;
			const source = (attachments[`${oldId}.xml`] as string).replaceAll(
				oldXmlns,
				xmlns,
			);
			delete attachments[`${oldId}.xml`];
			attachments[`hq-form-${m}-${i}.xml`] = source;
			form.unique_id = `hq-form-${m}-${i}`;
			form.xmlns = xmlns;
		});
	});
}

describe("what every projection the reader compares is given", () => {
	it("prints each menu and form under the source's own ids and the source's project space", async () => {
		const reading = await readCases(app(), { edit: foreignIds });
		const inputs = readProjectionInputs(reading.ctx);
		const module = reading.ctx.draft.modules[0];
		const form = reading.forms[0];
		if (module === undefined || form === undefined)
			throw new Error("The app holds its form.");
		expect(inputs.identity.moduleUniqueId(module.uuid)).toBe("hq-menu-0");
		expect(inputs.identity.formUniqueId(form.uuid)).toBe("hq-form-0-0");
		expect(inputs.identity.formXmlns({ uuid: form.uuid } as Form)).toBe(
			"http://openrosa.org/formdesigner/hq-0-0",
		);
		expect(inputs.attachmentTarget).toEqual(reading.ctx.input.target);
	});

	it("is built once per reading", async () => {
		const reading = await readCases(app());
		expect(readProjectionInputs(reading.ctx)).toBe(
			readProjectionInputs(reading.ctx),
		);
	});

	it("gives each resolved asset the path the source spells for it", async () => {
		const reading = await readCases(app());
		reading.ctx.facts.mediaReferences.push({
			path: "jr://file/commcare/image/clinic-logo.png",
			assetId: "asset-1",
			mediaKind: "image",
			place: appPlace(),
			slot: "app_logo",
		});
		const asset = readProjectionInputs(reading.ctx).assets.get(
			"asset-1" as never,
		);
		expect(asset?.wirePath).toBe("commcare/image/clinic-logo.png");
		expect(asset?.extension).toBe(".png");
		expect(asset?.mimeType).toBe("image/png");
	});
});
