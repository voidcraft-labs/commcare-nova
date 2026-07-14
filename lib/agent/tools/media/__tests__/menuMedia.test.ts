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
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import { getModuleTool } from "../../getModule";
import { setAppLogoTool } from "../setAppLogo";
import { setMenuMediaTool } from "../setMenuMedia";
import {
	errorOf,
	FORM_A,
	MOD_A,
	makeMediaFixture,
	makeMediaMcpFixture,
	resetTestAssets,
	seedTestAsset,
} from "./fixtures";

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
const moduleItem = (icon: string | null, audioLabel: string | null) =>
	({ target: "module", moduleIndex: 0, icon, audioLabel }) as const;

/** A form-tile item with the fixture's m0-f0 as the target. */
const formItem = (icon: string | null, audioLabel: string | null) =>
	({ target: "form", moduleIndex: 0, formIndex: 0, icon, audioLabel }) as const;

describe("setMenuMedia", () => {
	it("sets icon + audio label on a module tile", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem("asset-icon", "asset-audio")] },
			ctx,
			doc,
		);
		expect(result.kind).toBe("mutate");
		const mod = result.newDoc.modules[MOD_A];
		expect(mod?.icon).toBe("asset-icon");
		expect(mod?.audioLabel).toBe("asset-audio");
	});

	it("sets icon + audio label on a form tile", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{ items: [formItem("asset-icon", "asset-audio")] },
			ctx,
			doc,
		);
		const form = result.newDoc.forms[FORM_A];
		expect(form?.icon).toBe("asset-icon");
		expect(form?.audioLabel).toBe("asset-audio");
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
			{ items: [moduleItem("asset-icon", "asset-audio")] },
			ctx,
			baseDoc,
		);
		const cleared = await setMenuMediaTool.execute(
			{ items: [moduleItem(null, "asset-audio")] },
			ctx,
			seeded.newDoc,
		);
		const mod = cleared.newDoc.modules[MOD_A];
		expect(mod?.icon).toBeUndefined();
		expect(mod?.audioLabel).toBe("asset-audio");
	});

	it("clears tiles AFTER a JSON wire round-trip (blocker guard)", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setMenuMediaTool.execute(
			{
				items: [
					moduleItem("asset-icon", "asset-audio"),
					formItem("asset-icon", "asset-audio"),
				],
			},
			ctx,
			baseDoc,
		);
		const clear = await setMenuMediaTool.execute(
			{ items: [moduleItem(null, "asset-audio"), formItem(null, null)] },
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
		expect(overWire.modules[MOD_A]?.audioLabel).toBe("asset-audio");
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
						icon: "asset-icon",
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
			items: [moduleItem("asset-icon", null), formItem("register", null)],
		};
		const r1 = await setMenuMediaTool.execute(input, chatCtx, doc);
		const r2 = await setMenuMediaTool.execute(input, mcpCtx, doc);
		expect(r1.mutations).toEqual(r2.mutations);
	});
});

describe("setAppLogo", () => {
	it("sets the app logo", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setAppLogoTool.execute(
			{ logo: "asset-logo" },
			ctx,
			doc,
		);
		expect(result.kind).toBe("mutate");
		expect(result.newDoc.logo).toBe("asset-logo");
		expect(result.result).toContain("asset-logo");
	});

	it("clears the app logo when handed null", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setAppLogoTool.execute(
			{ logo: "asset-logo" },
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
			{ logo: "asset-logo" },
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
		const r1 = await setAppLogoTool.execute(
			{ logo: "asset-logo" },
			chatCtx,
			doc,
		);
		const r2 = await setAppLogoTool.execute(
			{ logo: "asset-logo" },
			mcpCtx,
			doc,
		);
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
			{ items: [moduleItem("patient", "asset-audio")] },
			ctx,
			doc,
		);
		const mod = result.newDoc.modules[MOD_A];
		expect(mod?.icon).toBe("nova-icon:patient");
		expect(mod?.audioLabel).toBe("asset-audio");
	});

	it("still accepts an uploaded asset id for the icon (slug-vs-id disambiguation)", async () => {
		const { doc, ctx } = makeMediaFixture();
		// "asset-icon" is a seeded image asset, not a catalog slug → the upload
		// path: stored verbatim, verified against the library.
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem("asset-icon", null)] },
			ctx,
			doc,
		);
		expect(result.newDoc.modules[MOD_A]?.icon).toBe("asset-icon");
	});

	it("round-trips a STORED built-in ref echoed back (single-slot preserve)", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setMenuMediaTool.execute(
			{ items: [moduleItem("household", null)] },
			ctx,
			baseDoc,
		);
		// The SA preserves the icon while setting the audio label by passing
		// back the STORED value it read via getModule — the prefixed ref, not
		// the bare slug. It must resolve without a library expectation ("nova-
		// icon:household" has no `media_assets` row) and store unchanged.
		const preserved = await setMenuMediaTool.execute(
			{ items: [moduleItem("nova-icon:household", "asset-audio")] },
			ctx,
			seeded.newDoc,
		);
		const mod = preserved.newDoc.modules[MOD_A];
		expect(mod?.icon).toBe("nova-icon:household");
		expect(mod?.audioLabel).toBe("asset-audio");
	});

	it("fails closed on a STALE built-in ref (slug gone from the catalog)", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem("nova-icon:not-a-real-slug", null)] },
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		expect(errorOf(result)).toContain("library");
	});
});

describe("getModule menu-media projection (the read side of the single-slot contract)", () => {
	it("surfaces the stored icon + audio_label on the module and its form summaries", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setMenuMediaTool.execute(
			{
				items: [
					moduleItem("household", "asset-audio"),
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
		expect(read.data.icon).toBe("nova-icon:household");
		expect(read.data.audio_label).toBe("asset-audio");
		expect(read.data.forms[0]?.icon).toBe("nova-icon:register");
		expect(read.data.forms[0]?.audio_label).toBeNull();
	});
});

describe("menu-media attach verdict", () => {
	it("refuses a kind mismatch on either slot", async () => {
		const { doc, ctx } = makeMediaFixture();
		// An IMAGE asset placed in the audio-label slot.
		const result = await setMenuMediaTool.execute(
			{ items: [moduleItem("asset-icon", "asset-icon")] },
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		const error = errorOf(result);
		expect(error).toContain("audio label");
		expect(error).toContain("an image");
	});

	it("a verdict failure on one item writes nothing for the whole batch", async () => {
		seedTestAsset("asset-pending", "image", { status: "pending" });
		const { doc, ctx } = makeMediaFixture();
		const result = await setMenuMediaTool.execute(
			{
				items: [moduleItem("household", null), formItem("asset-pending", null)],
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
			{ logo: "asset-nope" },
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
