/** Actual media command, preflight and canonical reducer behavior over admitted
 * documents and controlled asset rows. JSON clear tests exercise serialization;
 * native persistence and SA/MCP transport are separate proofs. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { buildDoc, caseListConfig, f } from "@/lib/__tests__/docHelpers";
import { expectAdmittedDoc } from "@/lib/agent/__tests__/admittedFixture";
import { makeAuthoringHarness } from "@/lib/agent/__tests__/authoringHarness";
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import { proseText } from "@/lib/domain";
import { getFormTool } from "../../getForm";
import { setAppLogoTool } from "../setAppLogo";
import {
	type SetMenuMediaInput,
	setMenuMediaInputSchema,
	setMenuMediaTool,
} from "../setMenuMedia";
import {
	ASSET_AUDIO,
	ASSET_ICON,
	ASSET_LOGO,
	errorOf,
	FORM_A,
	loadAssetsByIdsMock,
	MOD_A,
	makeMediaDoc,
	makeMediaFixture,
	resetTestAssets,
	seedTestAsset,
} from "./fixtures";

const ASSET_PENDING = testMediaAssetId("asset-pending");
const ASSET_NOPE = testMediaAssetId("asset-nope");
const UNKNOWN_MODULE = testUuid("88888888-8888-4888-8888-888888888888");
const UNKNOWN_FORM = testUuid("99999999-9999-4999-8999-999999999999");

type ModuleMenuItem = Extract<
	SetMenuMediaInput["items"][number],
	{ target: "module" }
>;
type FormMenuItem = Extract<
	SetMenuMediaInput["items"][number],
	{ target: "form" }
>;

vi.mock("@/lib/db/apps", () => ({
	loadAppProjectId: vi.fn(() =>
		Promise.resolve({ kind: "found", projectId: "project-1" }),
	),
}));
// The db-constructing module stubbed at the import boundary; the
// attach verdict's asset reads resolve against the fixtures' in-memory
// table instead.
vi.mock("@/lib/db/mediaAssets", async () => ({
	loadAssetsByIds: (await import("./fixtures")).loadAssetsByIdsMock,
	findSourceAssets: () => {
		throw new Error("Menu media commands must not discover source documents.");
	},
}));

beforeEach(() => {
	resetTestAssets();
});

/** A module-tile item with the fixture module as the target. */
const moduleItem = (
	icon: ModuleMenuItem["icon"],
	audioLabel: ModuleMenuItem["audioLabel"],
): ModuleMenuItem => ({
	target: "module",
	moduleUuid: MOD_A,
	icon,
	audioLabel,
});

/** A form-tile item with the fixture form as the target. */
const formItem = (
	icon: FormMenuItem["icon"],
	audioLabel: FormMenuItem["audioLabel"],
): FormMenuItem => ({
	target: "form",
	moduleUuid: MOD_A,
	formUuid: FORM_A,
	icon,
	audioLabel,
});

describe("setMenuMedia", () => {
	it("sets icon + audio label on a module tile", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(setMenuMediaTool, {
			items: [moduleItem(ASSET_ICON, ASSET_AUDIO)],
		});
		expect(result.kind).toBe("mutate");
		const mod = h.currentDoc().modules[MOD_A];
		expect(mod?.icon).toBe(ASSET_ICON);
		expect(mod?.audioLabel).toBe(ASSET_AUDIO);
	});

	it("sets icon + audio label on a form tile", async () => {
		const h = makeMediaFixture();
		await h.runTool(setMenuMediaTool, {
			items: [formItem(ASSET_ICON, ASSET_AUDIO)],
		});
		const form = h.currentDoc().forms[FORM_A];
		expect(form?.icon).toBe(ASSET_ICON);
		expect(form?.audioLabel).toBe(ASSET_AUDIO);
	});

	it("sets a module tile and a form tile in one batch", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(setMenuMediaTool, {
			items: [moduleItem("household", null), formItem("register", null)],
		});
		expect(h.currentDoc().modules[MOD_A]?.icon).toBe("nova-icon:household");
		expect(loadAssetsByIdsMock).not.toHaveBeenCalled();
		expect(h.currentDoc().forms[FORM_A]?.icon).toBe("nova-icon:register");
		expect(loadAssetsByIdsMock).not.toHaveBeenCalled();
		expect(result.result).toMatchObject({ ok: true, summary: { count: 2 } });
	});

	it("clears a slot when handed null", async () => {
		const h = makeMediaFixture();
		await h.runTool(setMenuMediaTool, {
			items: [moduleItem(ASSET_ICON, ASSET_AUDIO)],
		});
		await h.runTool(setMenuMediaTool, {
			items: [moduleItem(null, ASSET_AUDIO)],
		});
		const mod = h.currentDoc().modules[MOD_A];
		expect(mod?.icon).toBeUndefined();
		expect(mod?.audioLabel).toBe(ASSET_AUDIO);
	});

	it("clears tiles after JSON serialization and reducer application", async () => {
		const h = makeMediaFixture();
		await h.runTool(setMenuMediaTool, {
			items: [
				moduleItem(ASSET_ICON, ASSET_AUDIO),
				formItem(ASSET_ICON, ASSET_AUDIO),
			],
		});
		const seededDoc = h.currentDoc();
		const clear = await h.runTool(setMenuMediaTool, {
			items: [moduleItem(null, ASSET_AUDIO), formItem(null, null)],
		});
		// Apply the clears' mutations through the JSON wire — a clear encoded
		// as `{ icon: undefined }` would be dropped by `JSON.stringify` and
		// the icon would survive; the dedicated `setModuleMedia` /
		// `setFormMedia` mutations carry explicit `null`, so they clear over
		// the wire.
		const overWire = applyOverWire(seededDoc, clear.mutations);
		expect(overWire.modules[MOD_A]?.icon).toBeUndefined();
		expect(overWire.modules[MOD_A]?.audioLabel).toBe(ASSET_AUDIO);
		expect(overWire.forms[FORM_A]?.icon).toBeUndefined();
		expect(overWire.forms[FORM_A]?.audioLabel).toBeUndefined();
	});

	it("writes nothing when one item of a batch doesn't resolve", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(setMenuMediaTool, {
			items: [
				moduleItem("household", null),
				{
					target: "module",
					moduleUuid: UNKNOWN_MODULE,
					icon: "patient",
					audioLabel: null,
				},
			],
		});
		expect(result.mutations).toEqual([]);
		expect(h.currentDoc().modules[MOD_A]?.icon).toBeUndefined();
		const error = errorOf(result);
		expect(error).toContain("items[1]");
		expect(error).toContain(UNKNOWN_MODULE);
	});

	it("returns an Elm-style error when a form target is out of range", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(setMenuMediaTool, {
			items: [
				{
					target: "form",
					moduleUuid: MOD_A,
					formUuid: UNKNOWN_FORM,
					icon: ASSET_ICON,
					audioLabel: null,
				},
			],
		});
		expect(result.mutations).toEqual([]);
		expect(errorOf(result)).toContain(UNKNOWN_FORM);
	});
});

describe("setAppLogo", () => {
	it("sets the app logo", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(setAppLogoTool, { logo: ASSET_LOGO });
		expect(result.kind).toBe("mutate");
		expect(h.currentDoc().logo).toBe(ASSET_LOGO);
		expect(result.result).toContain(ASSET_LOGO);
	});

	it("clears the app logo when handed null", async () => {
		const h = makeMediaFixture();
		await h.runTool(setAppLogoTool, { logo: ASSET_LOGO });
		const cleared = await h.runTool(setAppLogoTool, { logo: null });
		expect(h.currentDoc().logo).toBeUndefined();
		expect(cleared.result).toContain("Cleared");
	});

	it("clears the logo after JSON serialization and reducer application", async () => {
		const h = makeMediaFixture();
		await h.runTool(setAppLogoTool, { logo: ASSET_LOGO });
		const seededDoc = h.currentDoc();
		const clear = await h.runTool(setAppLogoTool, { logo: null });
		const overWire = applyOverWire(seededDoc, clear.mutations);
		expect(overWire.logo).toBeUndefined();
	});
});

describe("menu-media built-in icons", () => {
	// Built-in icons are reserved refs and have no uploaded asset row.
	it("stores the reserved ref for a built-in module-icon slug", async () => {
		const h = makeMediaFixture();
		const result = await h.runTool(setMenuMediaTool, {
			items: [moduleItem("household", null)],
		});
		expect(result.kind).toBe("mutate");
		expect(h.currentDoc().modules[MOD_A]?.icon).toBe("nova-icon:household");
		expect(loadAssetsByIdsMock).not.toHaveBeenCalled();
	});

	it("stores the reserved ref for a built-in form-icon slug", async () => {
		const h = makeMediaFixture();
		await h.runTool(setMenuMediaTool, {
			items: [formItem("register", null)],
		});
		expect(h.currentDoc().forms[FORM_A]?.icon).toBe("nova-icon:register");
		expect(loadAssetsByIdsMock).not.toHaveBeenCalled();
	});

	it("sets a built-in icon alongside an uploaded audio label (audio still verified)", async () => {
		const h = makeMediaFixture();
		await h.runTool(setMenuMediaTool, {
			items: [moduleItem("patient", ASSET_AUDIO)],
		});
		const mod = h.currentDoc().modules[MOD_A];
		expect(mod?.icon).toBe("nova-icon:patient");
		expect(mod?.audioLabel).toBe(ASSET_AUDIO);
	});

	it("still accepts an uploaded asset id for the icon (slug-vs-id disambiguation)", async () => {
		const h = makeMediaFixture();
		// ASSET_ICON is a seeded image asset, not a catalog slug → the upload
		// path: stored verbatim, verified against the library.
		await h.runTool(setMenuMediaTool, {
			items: [moduleItem(ASSET_ICON, null)],
		});
		expect(h.currentDoc().modules[MOD_A]?.icon).toBe(ASSET_ICON);
	});

	it("rejects the stored built-in ref at the tool boundary", () => {
		expect(
			setMenuMediaInputSchema.safeParse({
				items: [
					{
						target: "module",
						moduleUuid: MOD_A,
						icon: "nova-icon:household",
						audioLabel: ASSET_AUDIO,
					},
				],
			}).success,
		).toBe(false);
	});

	it("rejects stale and merely prefixed built-in refs", () => {
		expect(
			setMenuMediaInputSchema.safeParse({
				items: [
					{
						target: "module",
						moduleUuid: MOD_A,
						icon: "nova-icon:not-a-real-slug",
						audioLabel: null,
					},
				],
			}).success,
		).toBe(false);
	});
});

describe("menu media as a client reads it (the read side of the single-slot contract)", () => {
	// A client reads through the authoring projection, never the tool body, so
	// these calls take production's path. Built-in slugs are covered with the
	// rest of the read contract in `authoring/__tests__/readContract.test.ts`;
	// this covers the uploaded-media half that needs the asset table.
	it("reads uploaded icons and audio as their asset ids beside a built-in slug", async () => {
		const h = makeAuthoringHarness(
			{ projectId: "project-1" },
			expectAdmittedDoc(makeMediaDoc()),
		);
		await h.call("setMenuMedia", {
			items: [moduleItem(ASSET_ICON, ASSET_AUDIO), formItem("register", null)],
		});
		expect(await h.call("getModule", { moduleUuid: MOD_A })).toMatchObject({
			icon: ASSET_ICON,
			audio_label: ASSET_AUDIO,
			forms: [{ icon: "register", audio_label: null }],
		});
		expect(
			await h.call("getForm", { moduleUuid: MOD_A, formUuid: FORM_A }),
		).toMatchObject({ form: { icon: "register" } });
	});

	it("keeps the stored identity in the tool body, which the projection alone prints", async () => {
		const h = makeMediaFixture();
		await h.runTool(setMenuMediaTool, {
			items: [formItem("register", null)],
		});
		const read = await h.runTool(getFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
		});
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.form.icon).toBe("nova-icon:register");
	});
});

describe("menu-media attach verdict", () => {
	it("refuses a kind mismatch on either slot", async () => {
		const h = makeMediaFixture();
		// An IMAGE asset placed in the audio-label slot.
		const result = await h.runTool(setMenuMediaTool, {
			items: [moduleItem(ASSET_ICON, ASSET_ICON)],
		});
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("audio label");
		expect(error).toContain("an image");
	});

	it("a verdict failure on one item writes nothing for the whole batch", async () => {
		seedTestAsset(ASSET_PENDING, "image", { status: "pending" });
		const h = makeMediaFixture();
		const result = await h.runTool(setMenuMediaTool, {
			items: [moduleItem("household", null), formItem(ASSET_PENDING, null)],
		});
		expect(result.mutations).toEqual([]);
		expect(h.currentDoc().modules[MOD_A]?.icon).toBeUndefined();
		expect(errorOf(result)).toContain("upload hasn't finished");
	});

	it("setAppLogo refuses an asset id that isn't in the library, and a null clear still passes", async () => {
		const h = makeMediaFixture();
		const missing = await h.runTool(setAppLogoTool, { logo: ASSET_NOPE });
		expect(missing.mutations).toEqual([]);
		if (typeof missing.result === "string") {
			throw new Error("expected error result");
		}
		expect(missing.result.error).toContain("library");

		// A clear carries no expectations — it commits whatever the table holds.
		const cleared = await h.runTool(setAppLogoTool, { logo: null });
		expect(cleared.kind).toBe("mutate");
		expect(typeof cleared.result).toBe("string");
	});
});

const REGISTER_FORM = testUuid("menu-media-register-form");

/** The fixture module as a case list offering another menu's registration
 *  form, with its case list as an item of its menu: every carrier
 *  `setMenuMedia` sets, on one document. */
function fourCarrierDoc({ caseListItem = true } = {}) {
	const doc = buildDoc({
		caseTypes: [{ name: "patient", properties: [] }],
		modules: [
			{
				uuid: "11111111-1111-1111-1111-111111111111",
				name: "Patients",
				caseType: "patient",
				...(caseListItem && { caseListMenuItem: { label: "All patients" } }),
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "22222222-2222-2222-2222-222222222222",
						name: "Visit",
						type: "followup",
						fields: [f({ kind: "text", id: "note", label: proseText("Note") })],
					},
				],
			},
			{
				uuid: "menu-media-registration-menu",
				name: "Registration",
				caseType: "patient",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				forms: [
					{
						uuid: "menu-media-register-form",
						name: "Register patient",
						type: "registration",
						fields: [
							f({
								kind: "text",
								id: "case_name",
								label: proseText("Name"),
								caseWrite: { caseType: "patient", property: "case_name" },
							}),
						],
					},
				],
			},
		],
	});
	doc.modules[MOD_A].caseListRegistrationForm = {
		kind: "always",
		formUuid: REGISTER_FORM,
		label: "New patient",
		afterSubmit: "case-list",
	};
	return doc;
}

type CaseListItemItem = Extract<
	SetMenuMediaInput["items"][number],
	{ target: "case-list-menu-item" }
>;
type RegisterItem = Extract<
	SetMenuMediaInput["items"][number],
	{ target: "case-list-registration" }
>;

const caseListItem = (
	icon: CaseListItemItem["icon"],
	audioLabel: CaseListItemItem["audioLabel"],
): CaseListItemItem => ({
	target: "case-list-menu-item",
	moduleUuid: MOD_A,
	icon,
	audioLabel,
});

const registerButton = (
	icon: RegisterItem["icon"],
	audioLabel: RegisterItem["audioLabel"],
): RegisterItem => ({
	target: "case-list-registration",
	moduleUuid: MOD_A,
	icon,
	audioLabel,
});

describe("setMenuMedia on a case list's menu item and its Register button", () => {
	it("sets all four carriers in one call, keeping the item's label and the arm's other fields", async () => {
		const h = makeMediaFixture({ doc: fourCarrierDoc() });
		const result = await h.runTool(setMenuMediaTool, {
			items: [
				moduleItem("household", null),
				formItem("follow_up", null),
				caseListItem(ASSET_ICON, ASSET_AUDIO),
				registerButton("register", ASSET_AUDIO),
			],
		});
		expect(result.result).toMatchObject({ ok: true, summary: { count: 4 } });
		const mod = h.currentDoc().modules[MOD_A];
		expect(mod?.icon).toBe("nova-icon:household");
		expect(h.currentDoc().forms[FORM_A]?.icon).toBe("nova-icon:follow_up");
		expect(mod?.caseListMenuItem).toEqual({
			label: "All patients",
			icon: ASSET_ICON,
			audioLabel: ASSET_AUDIO,
		});
		expect(mod?.caseListRegistrationForm).toEqual({
			kind: "always",
			formUuid: REGISTER_FORM,
			label: "New patient",
			icon: "nova-icon:register",
			audioLabel: ASSET_AUDIO,
			afterSubmit: "case-list",
		});
	});

	it("clears both new carriers' slots after JSON serialization and reducer application", async () => {
		const h = makeMediaFixture({ doc: fourCarrierDoc() });
		await h.runTool(setMenuMediaTool, {
			items: [
				caseListItem("household", ASSET_AUDIO),
				registerButton(ASSET_ICON, ASSET_AUDIO),
			],
		});
		const seededDoc = h.currentDoc();
		const clear = await h.runTool(setMenuMediaTool, {
			items: [caseListItem(null, null), registerButton(null, ASSET_AUDIO)],
		});
		const overWire = applyOverWire(seededDoc, clear.mutations);
		expect(overWire.modules[MOD_A]?.caseListMenuItem).toEqual({
			label: "All patients",
		});
		expect(overWire.modules[MOD_A]?.caseListRegistrationForm).toEqual({
			kind: "always",
			formUuid: REGISTER_FORM,
			label: "New patient",
			audioLabel: ASSET_AUDIO,
			afterSubmit: "case-list",
		});
	});

	it("refuses a module with no case list item, and writes no other item of the batch", async () => {
		const h = makeMediaFixture({
			doc: fourCarrierDoc({ caseListItem: false }),
		});
		const result = await h.runTool(setMenuMediaTool, {
			items: [
				moduleItem("household", null),
				registerButton("register", null),
				caseListItem("household", null),
			],
		});
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("items[2]");
		expect(error).toContain(
			'Module "Patients" has no case list item in its menu, so there is no item to set media on. You can add one with case_list_menu_item on update_module.',
		);
		expect(h.currentDoc().modules[MOD_A]?.icon).toBeUndefined();
		expect(
			h.currentDoc().modules[MOD_A]?.caseListRegistrationForm,
		).not.toHaveProperty("icon");
	});

	it.each([
		["case list item", caseListItem("household", ASSET_ICON)],
		["Register button", registerButton("register", ASSET_ICON)],
	])(
		"refuses an image in the %s's audio label slot",
		async (_carrier, item) => {
			const h = makeMediaFixture({ doc: fourCarrierDoc() });
			const result = await h.runTool(setMenuMediaTool, { items: [item] });
			expect(result.mutations).toEqual([]);
			const error = errorOf(result);
			expect(error).toContain("audio label");
			expect(error).toContain("an image");
			const mod = h.currentDoc().modules[MOD_A];
			expect(mod?.caseListMenuItem).toEqual({ label: "All patients" });
			expect(mod?.caseListRegistrationForm).toEqual({
				kind: "always",
				formUuid: REGISTER_FORM,
				label: "New patient",
				afterSubmit: "case-list",
			});
		},
	);
});
