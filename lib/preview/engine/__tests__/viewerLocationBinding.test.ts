import { describe, expect, it } from "vitest";
import doubleTextOracle from "@/lib/preview/xpath/__tests__/fixtures/double-text-openjdk17.json";
import {
	previewCaseStoreBindings,
	ViewerLocationError,
	viewerLocationText,
} from "../runtimeBindings";
import { ANDROID_RULES, WEB_APPS_RULES } from "./fixtures/previewDevices";

const SESSION = { context: {}, user: {}, userPropertySlugs: {} } as const;

/** A fix with no altitude and no reported accuracy, the shape a desktop
 * browser most often gives. */
function at(latitude: number, longitude: number) {
	return { latitude, longitude, altitude: null, accuracy: 0 };
}

/** The double whose IEEE-754 bits the oracle row names. */
function doubleFromBits(hex: string): number {
	const view = new DataView(new ArrayBuffer(8));
	view.setBigUint64(0, BigInt(`0x${hex}`));
	return view.getFloat64(0);
}

describe("viewerLocationText", () => {
	it("spells each coordinate as Java's Double.toString does, two numbers on Web Apps", () => {
		/* `FormplayerHereFunctionHandler.eval` builds a two-value
		 * `GeoPointData`, whose `getDisplayText` joins `Double.toString(lat)`
		 * and `Double.toString(lon)` with a space. */
		expect(viewerLocationText(at(40, -0.187), WEB_APPS_RULES)).toBe(
			"40.0 -0.187",
		);
		expect(viewerLocationText(at(5e-4, 32.58), WEB_APPS_RULES)).toBe(
			"5.0E-4 32.58",
		);
		expect(viewerLocationText(at(-5e-4, 0), WEB_APPS_RULES)).toBe(
			"-5.0E-4 0.0",
		);
	});

	it("gives Android's four numbers, altitude and accuracy floored to hundredths", () => {
		/* `AndroidHereFunctionHandler.toGeoPointData` passes latitude,
		 * longitude, altitude and accuracy; `GeoPointData.fillArray` floors
		 * the last two with `roundDecimalUp`. */
		expect(
			viewerLocationText(
				{ latitude: 40, longitude: -0.187, altitude: 12.349, accuracy: 7.999 },
				ANDROID_RULES,
			),
		).toBe("40.0 -0.187 12.34 7.99");
		/* A fix without an altitude reads 0, as `Location.getAltitude` gives. */
		expect(viewerLocationText(at(40, -74), ANDROID_RULES)).toBe(
			"40.0 -74.0 0.0 0.0",
		);
		/* Flooring, not rounding: a negative altitude moves away from zero. */
		expect(
			viewerLocationText(
				{ latitude: 0, longitude: 0, altitude: -3.001, accuracy: 1e-4 },
				ANDROID_RULES,
			),
		).toBe("0.0 0.0 -3.01 0.0");
	});

	it("agrees with OpenJDK 17 on the oracle's in-range coordinates", () => {
		const rows = (doubleTextOracle as [string, string][])
			.map(([bits, text]) => ({ value: doubleFromBits(bits), text }))
			.filter(({ value }) => Number.isFinite(value) && Math.abs(value) <= 90);
		expect(rows.length).toBeGreaterThan(20);
		for (const { value, text } of rows) {
			expect(viewerLocationText(at(value, value), WEB_APPS_RULES)).toBe(
				`${text} ${text}`,
			);
		}
	});

	it("reads no position as null, which here() reads as blank", () => {
		for (const rules of [WEB_APPS_RULES, ANDROID_RULES]) {
			expect(viewerLocationText(null, rules)).toBeNull();
			expect(viewerLocationText(undefined, rules)).toBeNull();
		}
	});

	it("refuses a position that is not a place on Earth", () => {
		for (const location of [
			at(90.0000001, 0),
			at(-91, 0),
			at(0, 180.5),
			at(0, -181),
			at(Number.NaN, 0),
			at(0, Number.POSITIVE_INFINITY),
			{ ...at(0, 0), altitude: Number.NaN },
			{ ...at(0, 0), accuracy: -1 },
			{ ...at(0, 0), accuracy: Number.POSITIVE_INFINITY },
			{ ...at(0, 0), latitude: "40" } as unknown as ReturnType<typeof at>,
		]) {
			expect(() => viewerLocationText(location, ANDROID_RULES)).toThrow(
				ViewerLocationError,
			);
		}
		expect(viewerLocationText(at(90, -180), WEB_APPS_RULES)).toBe(
			"90.0 -180.0",
		);
	});
});

describe("previewCaseStoreBindings", () => {
	it("binds the viewer's position as here() text in the platform's spelling", () => {
		const fix = { latitude: 40, longitude: -0.187, altitude: 3, accuracy: 20 };
		expect(
			previewCaseStoreBindings(
				SESSION,
				WEB_APPS_RULES,
				[],
				new Map(),
				"UTC",
				fix,
			).viewerLocation,
		).toBe("40.0 -0.187");
		expect(
			previewCaseStoreBindings(
				SESSION,
				ANDROID_RULES,
				[],
				new Map(),
				"UTC",
				fix,
			).viewerLocation,
		).toBe("40.0 -0.187 3.0 20.0");
	});

	it("binds null when no position was shared", () => {
		expect(
			previewCaseStoreBindings(SESSION, ANDROID_RULES).viewerLocation,
		).toBeNull();
		expect(
			previewCaseStoreBindings(
				SESSION,
				ANDROID_RULES,
				[],
				new Map(),
				"UTC",
				null,
			).viewerLocation,
		).toBeNull();
	});
});
