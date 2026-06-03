import render from "dom-serializer";
import { describe, expect, it } from "vitest";
import { RENDER_OPTS } from "@/lib/commcare/elementBuilders";
import { asAssetId } from "@/lib/domain/multimedia";
import type { AssetManifest, ResolvedMediaAsset } from "../assetWirePath";
import { buildLogoProfileProperty, buildLogoRefs } from "../logoEntry";

const HASH = "f".repeat(64);

const MANIFEST: AssetManifest = new Map<
	ReturnType<typeof asAssetId>,
	ResolvedMediaAsset
>([
	[
		asAssetId("logo-1"),
		{
			assetId: asAssetId("logo-1"),
			wirePath: `commcare/${HASH}.png`,
			kind: "image",
			mimeType: "image/png",
			contentHash: HASH,
			extension: ".png",
		},
	],
]);

const REF = `jr://file/commcare/${HASH}.png`;

describe("buildLogoRefs", () => {
	it("is empty when there is no logo", () => {
		expect(buildLogoRefs(undefined, MANIFEST, "t")).toEqual({});
	});

	it("is empty when media emission is off", () => {
		expect(buildLogoRefs("logo-1", undefined, "t")).toEqual({});
	});

	it("maps hq_logo_web_apps to the jr:// path", () => {
		expect(buildLogoRefs("logo-1", MANIFEST, "t")).toEqual({
			hq_logo_web_apps: { path: REF },
		});
	});
});

describe("buildLogoProfileProperty", () => {
	it("is undefined when there is no logo", () => {
		expect(buildLogoProfileProperty(undefined, MANIFEST, "t")).toBeUndefined();
	});

	it("emits an attribute-style forced property keyed brand-banner-web-apps", () => {
		const el = buildLogoProfileProperty("logo-1", MANIFEST, "t");
		if (!el) throw new Error("expected a logo profile property element");
		expect(render(el, RENDER_OPTS)).toBe(
			`<property key="brand-banner-web-apps" value="${REF}" force="true"/>`,
		);
	});
});
