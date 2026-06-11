/**
 * Behavioral tests for the menu-media tools: `set_module_media`,
 * `set_form_media`, and `set_app_logo`.
 *
 * These three share the nullable-asset-slot shape (asset id sets, `null`
 * clears) and target the menu carriers (module / form tiles, app logo).
 *
 * Coverage per tool: set both slots; clear via null; clear survives the
 * SSE JSON wire (the blocker regression guard); module/form-not-found
 * error; and the cross-surface parity check on one representative tool.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyOverWire } from "@/lib/doc/__tests__/wireRoundTrip";
import { setAppLogoTool } from "../setAppLogo";
import { setFormMediaTool } from "../setFormMedia";
import { setModuleMediaTool } from "../setModuleMedia";
import {
	FORM_A,
	MOD_A,
	makeMediaFixture,
	makeMediaMcpFixture,
	resetTestAssets,
	seedTestAsset,
} from "./fixtures";

vi.mock("@/lib/db/apps", () => ({
	updateApp: vi.fn(() => Promise.resolve()),
	updateAppForRun: vi.fn(() => Promise.resolve()),
	completeApp: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/db/applyBlueprintChange", () => ({
	applyBlueprintChange: vi.fn(() => Promise.resolve()),
}));
// Firestore-constructing module stubbed at the import boundary; the
// attach verdict's asset reads resolve against the fixtures' in-memory
// table instead.
vi.mock("@/lib/db/mediaAssets", async () => ({
	loadAssetsByIds: (await import("./fixtures")).loadAssetsByIdsMock,
}));

beforeEach(() => {
	vi.clearAllMocks();
	resetTestAssets();
});

describe("setModuleMedia", () => {
	it("sets icon + audio label on the module", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setModuleMediaTool.execute(
			{ moduleIndex: 0, icon: "asset-icon", audioLabel: "asset-audio" },
			ctx,
			doc,
		);
		expect(result.kind).toBe("mutate");
		const mod = result.newDoc.modules[MOD_A];
		expect(mod?.icon).toBe("asset-icon");
		expect(mod?.audioLabel).toBe("asset-audio");
	});

	it("clears a slot when handed null", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setModuleMediaTool.execute(
			{ moduleIndex: 0, icon: "asset-icon", audioLabel: "asset-audio" },
			ctx,
			baseDoc,
		);
		const cleared = await setModuleMediaTool.execute(
			{ moduleIndex: 0, icon: null, audioLabel: "asset-audio" },
			ctx,
			seeded.newDoc,
		);
		const mod = cleared.newDoc.modules[MOD_A];
		expect(mod?.icon).toBeUndefined();
		expect(mod?.audioLabel).toBe("asset-audio");
	});

	it("clears the icon AFTER a JSON wire round-trip (blocker guard)", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setModuleMediaTool.execute(
			{ moduleIndex: 0, icon: "asset-icon", audioLabel: "asset-audio" },
			ctx,
			baseDoc,
		);
		const clear = await setModuleMediaTool.execute(
			{ moduleIndex: 0, icon: null, audioLabel: "asset-audio" },
			ctx,
			seeded.newDoc,
		);
		// Apply the clear's mutations through the JSON wire — a clear encoded
		// as `{ icon: undefined }` would be dropped by `JSON.stringify` and
		// the icon would survive; the dedicated `setModuleMedia` mutation
		// carries explicit `null`, so it clears over the wire.
		const overWire = applyOverWire(seeded.newDoc, clear.mutations);
		const mod = overWire.modules[MOD_A];
		expect(mod?.icon).toBeUndefined();
		expect(mod?.audioLabel).toBe("asset-audio");
	});

	it("returns an Elm-style error on out-of-range moduleIndex", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setModuleMediaTool.execute(
			{ moduleIndex: 99, icon: "asset-icon", audioLabel: null },
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("module index 99");
	});

	it("emits the same mutation batch through chat + MCP contexts", async () => {
		const { doc, ctx: chatCtx } = makeMediaFixture();
		const { ctx: mcpCtx } = makeMediaMcpFixture();
		const input = {
			moduleIndex: 0,
			icon: "asset-icon",
			audioLabel: null,
		};
		const r1 = await setModuleMediaTool.execute(input, chatCtx, doc);
		const r2 = await setModuleMediaTool.execute(input, mcpCtx, doc);
		expect(r1.mutations).toEqual(r2.mutations);
	});
});

describe("setFormMedia", () => {
	it("sets icon + audio label on the form", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setFormMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				icon: "asset-icon",
				audioLabel: "asset-audio",
			},
			ctx,
			doc,
		);
		expect(result.kind).toBe("mutate");
		const form = result.newDoc.forms[FORM_A];
		expect(form?.icon).toBe("asset-icon");
		expect(form?.audioLabel).toBe("asset-audio");
	});

	it("clears a slot when handed null", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setFormMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				icon: "asset-icon",
				audioLabel: "asset-audio",
			},
			ctx,
			baseDoc,
		);
		const cleared = await setFormMediaTool.execute(
			{ moduleIndex: 0, formIndex: 0, icon: null, audioLabel: null },
			ctx,
			seeded.newDoc,
		);
		const form = cleared.newDoc.forms[FORM_A];
		expect(form?.icon).toBeUndefined();
		expect(form?.audioLabel).toBeUndefined();
	});

	it("clears both slots AFTER a JSON wire round-trip (blocker guard)", async () => {
		const { doc: baseDoc, ctx } = makeMediaFixture();
		const seeded = await setFormMediaTool.execute(
			{
				moduleIndex: 0,
				formIndex: 0,
				icon: "asset-icon",
				audioLabel: "asset-audio",
			},
			ctx,
			baseDoc,
		);
		const clear = await setFormMediaTool.execute(
			{ moduleIndex: 0, formIndex: 0, icon: null, audioLabel: null },
			ctx,
			seeded.newDoc,
		);
		const overWire = applyOverWire(seeded.newDoc, clear.mutations);
		const form = overWire.forms[FORM_A];
		expect(form?.icon).toBeUndefined();
		expect(form?.audioLabel).toBeUndefined();
	});

	it("returns an Elm-style error when the form is out of range", async () => {
		const { doc, ctx } = makeMediaFixture();
		const result = await setFormMediaTool.execute(
			{ moduleIndex: 0, formIndex: 9, icon: "asset-icon", audioLabel: null },
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("m0-f9");
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

describe("menu-media attach verdict", () => {
	it("setModuleMedia refuses a kind mismatch on either slot", async () => {
		const { doc, ctx } = makeMediaFixture();
		// An IMAGE asset placed in the audio-label slot.
		const result = await setModuleMediaTool.execute(
			{ moduleIndex: 0, icon: "asset-icon", audioLabel: "asset-icon" },
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("audio label");
		expect(result.result.error).toContain("an image");
	});

	it("setFormMedia refuses an asset still uploading", async () => {
		seedTestAsset("asset-pending", "image", { status: "pending" });
		const { doc, ctx } = makeMediaFixture();
		const result = await setFormMediaTool.execute(
			{ moduleIndex: 0, formIndex: 0, icon: "asset-pending", audioLabel: null },
			ctx,
			doc,
		);
		expect(result.mutations).toEqual([]);
		if (typeof result.result === "string") {
			throw new Error("expected error result");
		}
		expect(result.result.error).toContain("upload hasn't finished");
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
