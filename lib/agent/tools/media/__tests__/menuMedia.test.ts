/**
 * Behavioral tests for the menu-media tools: `set_menu_media` and
 * `set_app_logo`.
 *
 * Both use nullable asset slots (asset id sets, `null` clears) and target
 * the menu carriers (module / form tiles, app logo). `set_menu_media` is
 * batch-shaped: one call sets any mix of module and form tiles,
 * all-or-nothing.
 *
 * Coverage: set both slots (module + form arms); a mixed multi-tile
 * batch; clear via null; clear survives the SSE JSON wire (the blocker
 * regression guard); a batch with one unresolvable item writes nothing
 * and names it; and the cross-surface parity check on one representative
 * tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { testMediaAssetId } from "@/__tests__/helpers/uuid";
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
	MOD_A,
	makeMediaFixture,
	makeMediaMcpFixture,
	resetTestAssets,
	seedTestAsset,
} from "./fixtures";

const ASSET_PENDING = testMediaAssetId("asset-pending");
const ASSET_NOPE = testMediaAssetId("asset-nope");

type ModuleMenuItem = Extract<
	SetMenuMediaInput["items"][number],
	{ target: "module" }
>;
type FormMenuItem = Extract<
	SetMenuMediaInput["items"][number],
	{ target: "form" }
>;

vi.mock("@/lib/db/apps", () => ({
	completeApp: vi.fn(() => Promise.resolve()),
	loadAppProjectId: vi.fn(() => Promise.resolve("project-1")),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve({ seq: 0 })),
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

/** A module-tile item with the fixture's module 0 as the target. */
const moduleItem = (
	icon: ModuleMenuItem["icon"],
	audioLabel: ModuleMenuItem["audioLabel"],
): ModuleMenuItem => ({ target: "module", moduleIndex: 0, icon, audioLabel });

/** A form-tile item with the fixture's m0-f0 as the target. */
const formItem = (
	icon: FormMenuItem["icon"],
	audioLabel: FormMenuItem["audioLabel"],
): FormMenuItem => ({
	target: "form",
	moduleIndex: 0,
	formIndex: 0,
	icon,
	audioLabel,
});

describe("setMenuMedia", () => {
	it("sets icon + audio label on a module tile", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem(ASSET_ICON, ASSET_AUDIO)] },
			ctx,
			doc,
		);
		expect(result.kind).toBe("mutate");
		const mod = result.newDoc.modules[MOD_A];
		expect(mod?.icon).toBe(ASSET_ICON);
		expect(mod?.audioLabel).toBe(ASSET_AUDIO);
	});

	it("sets icon + audio label on a form tile", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{ items: [formItem(ASSET_ICON, ASSET_AUDIO)] },
			ctx,
			doc,
		);
		const form = result.newDoc.forms[FORM_A];
		expect(form?.icon).toBe(ASSET_ICON);
		expect(form?.audioLabel).toBe(ASSET_AUDIO);
	});

	it("sets a module tile and a form tile in one batch", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{
				items: [moduleItem("household", null), formItem("register", null)],
			},
			ctx,
			doc,
		);
		expect(result.newDoc.modules[MOD_A]?.icon).toBe("nova-icon:household");
		expect(result.newDoc.forms[FORM_A]?.icon).toBe("nova-icon:register");
		const success = result.result as { message: string; summary: unknown };
		expect(success.message).toContain("2 tiles");
		expect(success.summary).toEqual({ count: 2 });
	});

	it("clears a slot when handed null", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setMenuMediaTool.execute(
			{ items: [moduleItem(ASSET_ICON, ASSET_AUDIO)] },
			ctx,
			baseDoc,
		);
		const cleared = await setMenuMediaTool.execute(
			{ items: [moduleItem(null, ASSET_AUDIO)] },
			ctx,
			seeded.newDoc,
		);
		const mod = cleared.newDoc.modules[MOD_A];
		expect(mod?.icon).toBeUndefined();
		expect(mod?.audioLabel).toBe(ASSET_AUDIO);
	});

	it("clears tiles AFTER a JSON wire round-trip (blocker guard)", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setMenuMediaTool.execute(
			{
				items: [
					moduleItem(ASSET_ICON, ASSET_AUDIO),
					formItem(ASSET_ICON, ASSET_AUDIO),
				],
			},
			ctx,
			baseDoc,
		);
		const clear = await setMenuMediaTool.execute(
			{ items: [moduleItem(null, ASSET_AUDIO), formItem(null, null)] },
			ctx,
			seeded.newDoc,
		);
		// Apply the clears' mutations through the JSON wire — a clear encoded
		// as `{ icon: undefined }` would be dropped by `JSON.stringify` and
		// the icon would survive; the dedicated `setModuleMedia` /
		// `setFormMedia` mutations carry explicit `null`, so they clear over
		// the wire.
		const overWire = applyOverWire(seeded.newDoc, clear.mutations);
		expect(overWire.modules[MOD_A]?.icon).toBeUndefined();
		expect(overWire.modules[MOD_A]?.audioLabel).toBe(ASSET_AUDIO);
		expect(overWire.forms[FORM_A]?.icon).toBeUndefined();
		expect(overWire.forms[FORM_A]?.audioLabel).toBeUndefined();
	});

	it("writes nothing when one item of a batch doesn't resolve", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{
				items: [
					moduleItem("household", null),
					{
						target: "module",
						moduleIndex: 99,
						icon: "patient",
						audioLabel: null,
					},
				],
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		expect(result.newDoc.modules[MOD_A]?.icon).toBeUndefined();
		const error = errorOf(result);
		expect(error).toContain("items[1]");
		expect(error).toContain("no module at index 99");
	});

	it("returns an Elm-style error when a form target is out of range", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{
				items: [
					{
						target: "form",
						moduleIndex: 0,
						formIndex: 9,
						icon: ASSET_ICON,
						audioLabel: null,
					},
				],
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		expect(errorOf(result)).toContain("m0-f9");
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = makeMediaFixture();
		const { ctx: mcpCtx } = makeMediaMcpFixture();
		const input = {
			items: [moduleItem(ASSET_ICON, null), formItem("register", null)],
		};
		const r1 = await setMenuMediaTool.execute(input, chatCtx, doc);
		const r2 = await setMenuMediaTool.execute(input, mcpCtx, doc);
		expect(r1.mutations).toEqual(r2.mutations);
	});
});

describe("setAppLogo", () => {
	it("sets the app logo", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setAppLogoTool.execute({ logo: ASSET_LOGO }, ctx, doc);
		expect(result.kind).toBe("mutate");
		expect(result.newDoc.logo).toBe(ASSET_LOGO);
		expect(result.result).toContain(ASSET_LOGO);
	});

	it("clears the app logo when handed null", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setAppLogoTool.execute(
			{ logo: ASSET_LOGO },
			ctx,
			baseDoc,
		);
		const cleared = await setAppLogoTool.execute(
			{ logo: null },
			ctx,
			seeded.newDoc,
		);
		expect(cleared.newDoc.logo).toBeUndefined();
		expect(cleared.result).toContain("Cleared");
	});

	it("clears the logo AFTER a JSON wire round-trip (blocker guard)", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setAppLogoTool.execute(
			{ logo: ASSET_LOGO },
			ctx,
			baseDoc,
		);
		const clear = await setAppLogoTool.execute(
			{ logo: null },
			ctx,
			seeded.newDoc,
		);
		const overWire = applyOverWire(seeded.newDoc, clear.mutations);
		expect(overWire.logo).toBeUndefined();
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = makeMediaFixture();
		const { ctx: mcpCtx } = makeMediaMcpFixture();
		const r1 = await setAppLogoTool.execute({ logo: ASSET_LOGO }, chatCtx, doc);
		const r2 = await setAppLogoTool.execute({ logo: ASSET_LOGO }, mcpCtx, doc);
		expect(r1.mutations).toEqual(r2.mutations);
	});
});

describe("menu-media built-in icons", () => {
	// A built-in slug (e.g. "household") is NOT in the in-memory asset table, so
	// these passing at all proves the built-in path resolves WITHOUT the at-source
	// asset verdict — an uploaded id that wasn't seeded would error "not in library".
	it("stores the reserved ref for a built-in module-icon slug", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem("household", null)] },
			ctx,
			doc,
		);
		expect(result.kind).toBe("mutate");
		expect(result.newDoc.modules[MOD_A]?.icon).toBe("nova-icon:household");
	});

	it("stores the reserved ref for a built-in form-icon slug", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{ items: [formItem("register", null)] },
			ctx,
			doc,
		);
		expect(result.newDoc.forms[FORM_A]?.icon).toBe("nova-icon:register");
	});

	it("sets a built-in icon alongside an uploaded audio label (audio still verified)", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem("patient", ASSET_AUDIO)] },
			ctx,
			doc,
		);
		const mod = result.newDoc.modules[MOD_A];
		expect(mod?.icon).toBe("nova-icon:patient");
		expect(mod?.audioLabel).toBe(ASSET_AUDIO);
	});

	it("still accepts an uploaded asset id for the icon (slug-vs-id disambiguation)", async () => {
		const { doc, ctx } = makeMediaFixture();
		// ASSET_ICON is a seeded image asset, not a catalog slug → the upload
		// path: stored verbatim, verified against the library.
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem(ASSET_ICON, null)] },
			ctx,
			doc,
		);
		expect(result.newDoc.modules[MOD_A]?.icon).toBe(ASSET_ICON);
	});

	it("rejects the stored built-in ref at the tool boundary", () => {
		expect(
			setMenuMediaInputSchema.safeParse({
				items: [
					{
						target: "module",
						moduleIndex: 0,
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
						moduleIndex: 0,
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
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setMenuMediaTool.execute(
			{
				items: [
					moduleItem("household", ASSET_AUDIO),
					formItem("register", null),
				],
			},
			ctx,
			baseDoc,
		);
		const read = await getModuleTool.execute(
			{ moduleIndex: 0 },
			ctx,
			seeded.newDoc,
		);
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.icon).toBe("household");
		expect(read.data.audio_label).toBe(ASSET_AUDIO);
		expect(read.data.forms[0]?.icon).toBe("register");
		expect(read.data.forms[0]?.audio_label).toBeNull();
	});

	it("projects a form built-in to its accepted slug on the full-form read", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setMenuMediaTool.execute(
			{ items: [formItem("register", null)] },
			ctx,
			baseDoc,
		);
		const read = await getFormTool.execute(
			{ moduleIndex: 0, formIndex: 0 },
			ctx,
			seeded.newDoc,
		);
		if ("error" in read.data) throw new Error(read.data.error);
		expect(read.data.form.icon).toBe("register");
	});
});

describe("menu-media attach verdict", () => {
	it("refuses a kind mismatch on either slot", async () => {
		const { doc, ctx } = makeMediaFixture();
		// An IMAGE asset placed in the audio-label slot.
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem(ASSET_ICON, ASSET_ICON)] },
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("audio label");
		expect(error).toContain("an image");
	});

	it("a verdict failure on one item writes nothing for the whole batch", async () => {
		seedTestAsset(ASSET_PENDING, "image", { status: "pending" });
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{
				items: [moduleItem("household", null), formItem(ASSET_PENDING, null)],
			},
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		expect(result.newDoc.modules[MOD_A]?.icon).toBeUndefined();
		expect(errorOf(result)).toContain("upload hasn't finished");
	});

	it("setAppLogo refuses an asset id that isn't in the library, and a null clear still passes", async () => {
		const { doc, ctx } = makeMediaFixture();
		const missing = await setAppLogoTool.execute(
			{ logo: ASSET_NOPE },
			ctx,
			doc,
		);
		expect(missing.mutations).toEqual([]);
		if (typeof missing.result === "string") {
			throw new Error("expected error result");
		}
		expect(missing.result.error).toContain("library");

		// A clear carries no expectations — it commits whatever the table holds.
		const cleared = await setAppLogoTool.execute({ logo: null }, ctx, doc);
		expect(cleared.kind).toBe("mutate");
		expect(typeof cleared.result).toBe("string");
	});
});
