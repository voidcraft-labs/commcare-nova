import { describe, expect, it } from "vitest";
import doubleTextOracle from "@/lib/preview/xpath/__tests__/fixtures/double-text-openjdk17.json";
import {
	previewCaseStoreBindings,
	ViewerLocationError,
	viewerLocationText,
} from "../runtimeBindings";

const SESSION = { context: {}, user: {}, userPropertySlugs: {} } as const;

/** The double whose IEEE-754 bits the oracle row names. */
function doubleFromBits(hex: string): number {
	const view = new DataView(new ArrayBuffer(8));
	view.setBigUint64(0, BigInt(`0x${hex}`));
	return view.getFloat64(0);
}

describe("viewerLocationText", () => {
	it("spells each coordinate as Java's Double.toString does", () => {
		/* `GeoPointData.getDisplayText` over two values joins
		 * `Double.toString(lat)` and `Double.toString(lon)` with a space. */
		expect(viewerLocationText({ latitude: 40, longitude: -0.187 })).toBe(
			"40.0 -0.187",
		);
		expect(viewerLocationText({ latitude: 5e-4, longitude: 32.58 })).toBe(
			"5.0E-4 32.58",
		);
		expect(viewerLocationText({ latitude: -5e-4, longitude: 0 })).toBe(
			"-5.0E-4 0.0",
		);
	});

	it("agrees with OpenJDK 17 on the oracle's in-range coordinates", () => {
		const rows = (doubleTextOracle as [string, string][])
			.map(([bits, text]) => ({ value: doubleFromBits(bits), text }))
			.filter(({ value }) => Number.isFinite(value) && Math.abs(value) <= 90);
		expect(rows.length).toBeGreaterThan(20);
		for (const { value, text } of rows) {
			expect(viewerLocationText({ latitude: value, longitude: value })).toBe(
				`${text} ${text}`,
			);
		}
	});

	it("reads no position as null, which here() reads as blank", () => {
		expect(viewerLocationText(null)).toBeNull();
		expect(viewerLocationText(undefined)).toBeNull();
	});

	it("refuses a position that is not a place on Earth", () => {
		for (const location of [
			{ latitude: 90.0000001, longitude: 0 },
			{ latitude: -91, longitude: 0 },
			{ latitude: 0, longitude: 180.5 },
			{ latitude: 0, longitude: -181 },
			{ latitude: Number.NaN, longitude: 0 },
			{ latitude: 0, longitude: Number.POSITIVE_INFINITY },
			{ latitude: "40", longitude: 0 } as unknown as {
				latitude: number;
				longitude: number;
			},
		]) {
			expect(() => viewerLocationText(location)).toThrow(ViewerLocationError);
		}
		expect(viewerLocationText({ latitude: 90, longitude: -180 })).toBe(
			"90.0 -180.0",
		);
	});
});

describe("previewCaseStoreBindings", () => {
	it("binds the viewer's position as here() text", () => {
		const bindings = previewCaseStoreBindings(SESSION, [], new Map(), "UTC", {
			latitude: 40,
			longitude: -0.187,
		});
		expect(bindings.viewerLocation).toBe("40.0 -0.187");
	});

	it("binds null when no position was shared", () => {
		expect(previewCaseStoreBindings(SESSION).viewerLocation).toBeNull();
		expect(
			previewCaseStoreBindings(SESSION, [], new Map(), "UTC", null)
				.viewerLocation,
		).toBeNull();
	});
});
