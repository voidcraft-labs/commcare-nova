/** Actual media command, preflight and canonical reducer behavior over admitted
 * documents and controlled asset rows. JSON clear tests exercise serialization;
 * native persistence and SA/MCP transport are separate proofs. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId, testUuid } from "@/__tests__/helpers/uuid";
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import { getFormTool } from "../../getForm";
import { getModuleTool } from "../../getModule";
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
}));

beforeEach(() => {
	vi.clearAllMocks();
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
		const success = result.result as { message: string; summary: unknown };
		expect(success.message).toContain("2 tiles");
		expect(success.summary).toEqual({ count: 2 });
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

describe("getModule menu-media projection (the read side of the single-slot contract)", () => {
	it("surfaces the stored icon + audio_label on the module and its form summaries", async () => {
		const h = makeMediaFixture();
		await h.runTool(setMenuMediaTool, {
			items: [moduleItem("household", ASSET_AUDIO), formItem("register", null)],
		});
		const read = await h.runTool(getModuleTool, { moduleUuid: MOD_A });
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.icon).toBe("household");
		expect(read.data.audio_label).toBe(ASSET_AUDIO);
		expect(read.data.forms[0]?.icon).toBe("register");
		expect(read.data.forms[0]?.audio_label).toBeNull();
	});

	it("projects a form built-in to its accepted slug on the full-form read", async () => {
		const h = makeMediaFixture();
		await h.runTool(setMenuMediaTool, {
			items: [formItem("register", null)],
		});
		const read = await h.runTool(getFormTool, {
			moduleUuid: MOD_A,
			formUuid: FORM_A,
		});
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.form.icon).toBe("register");
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
