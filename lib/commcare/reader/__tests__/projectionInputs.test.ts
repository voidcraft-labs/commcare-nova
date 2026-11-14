/**
 * What every projection the reader compares is given (`readProjectionInputs`).
 *
 * Contract: over a source whose menu ids, form ids and `xmlns` are none of
 * Nova's derivations, whose form saves a capture's link and reads a table, the
 * reading expanded with its inputs prints the source's ids, the source's
 * project space in the link, and the source's tag and field names; built once
 * per reading; each resolved asset at the path the source spells. The
 * plausible failure: every (R2) failing on an id, an address or a table name,
 * so that every real app reads `unrecognized`.
 */
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, f } from "@/lib/__tests__/docHelpers";
import type { BlueprintDoc, CaseOperation, Form } from "@/lib/domain";
import { term } from "@/lib/domain/expression";
import type { LookupColumnId, LookupTableId } from "@/lib/domain/lookupIds";
import { expandDoc } from "../../expander";
import { lookupWireNaming } from "../../lookup/naming";
import { readCases } from "../caseManagement/__tests__/caseReading";
import { appPlace } from "../place";
import { readProjectionInputs } from "../projectionInputs";
import { provisionalDocument } from "../provisional";

const TABLE = "01890000-0000-7000-8000-000000000201" as LookupTableId;
const NAME = "01890000-0000-7000-8000-000000000202" as LookupColumnId;
const VISIT = testUuid("inputs-visit");
const PICTURE = testUuid("inputs-picture");

/** A follow-up that saves a capture's link to its case and asks for a district from a table. */
function capturingApp(): BlueprintDoc {
	return buildDoc(
		{
			modules: [
				{
					name: "Patients",
					caseType: "patient",
					forms: [
						{
							uuid: "inputs-visit",
							name: "Visit",
							type: "followup",
							fields: [
								f({ kind: "image", id: "picture", uuid: PICTURE }),
								f({
									kind: "single_select",
									id: "district",
									label: "District",
									optionsSource: {
										kind: "lookup",
										tableId: TABLE,
										valueColumnId: NAME,
										labelColumnId: NAME,
									},
								}),
							],
						},
					],
				},
			],
		},
		(built) => {
			built.forms[VISIT] = {
				...built.forms[VISIT],
				caseOperations: [
					{
						uuid: testUuid("inputs-own"),
						id: "patient",
						action: "own",
						writes: [
							{
								property: "picture_link",
								value: term({ kind: "capture-link", field: PICTURE }),
							},
						],
					} as CaseOperation,
				],
			} as never;
		},
	);
}

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

	it("expands the reading with the source's ids, its project space in a capture's link and its table's tag", async () => {
		const naming = lookupWireNaming([
			{
				id: TABLE,
				tag: "hq_districts",
				columns: [
					{
						id: NAME,
						wireName: "district_name",
						label: "Name",
						dataType: "text",
					},
				],
			},
		]);
		const target = { origin: "https://india.commcarehq.org", domain: "clinic" };
		const reading = await readCases(capturingApp(), {
			edit: foreignIds,
			expand: { lookupNaming: naming, attachmentTarget: target },
			input: (input) => ({
				...input,
				lookup: {
					table: (tag) =>
						tag === "hq_districts"
							? {
									tableId: TABLE,
									column: (name) =>
										name === "district_name" ? NAME : undefined,
								}
							: undefined,
					definitions: new Map([
						[
							TABLE,
							{
								id: TABLE,
								name: "Districts",
								tag: "hq_districts",
								columns: [
									{
										id: NAME,
										wireName: "district_name",
										label: "Name",
										dataType: "text",
									},
								],
							},
						],
					]),
				},
			}),
		});
		expect(reading.ctx.input.target).toEqual(target);
		const doc = provisionalDocument(reading.ctx);
		const printed = expandDoc(doc, readProjectionInputs(reading.ctx));
		const module = printed.modules[0];
		expect(module?.unique_id).toBe("hq-menu-0");
		expect(module?.forms[0]?.unique_id).toBe("hq-form-0-0");
		expect(module?.forms[0]?.xmlns).toBe(
			"http://openrosa.org/formdesigner/hq-0-0",
		);
		const source = (printed._attachments as Record<string, string>)[
			"hq-form-0-0.xml"
		];
		expect(source).toContain(
			"https://india.commcarehq.org/a/clinic/api/form_attachment/v1/",
		);
		expect(source).toContain("jr://fixture/item-list:hq_districts");
		expect(source).toContain("district_name");
		// Nothing but the inputs carries these: Nova's derivations print none of them.
		const derived = expandDoc(doc, { lookupNaming: naming });
		expect(derived.modules[0]?.unique_id).not.toBe("hq-menu-0");
		expect(JSON.stringify(derived._attachments)).not.toContain(
			"https://india.commcarehq.org/a/clinic/api/form_attachment",
		);
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
