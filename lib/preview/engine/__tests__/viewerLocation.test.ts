import { describe, expect, it } from "vitest";
import {
	asUuid,
	type CaseListConfig,
	type ColumnCommonSlots,
	calculatedColumn,
	emptyCaseListConfig,
	plainColumn,
} from "@/lib/domain";
import { literal, term } from "@/lib/domain/expression";
import { javaRosaPointDistance } from "@/lib/preview/xpath/javaRosaGeo";
import {
	columnsReadHere,
	positionSettles,
	shouldReReadForPosition,
	type ViewerLocation,
} from "../viewerLocation";

/* Moves due north along the prime meridian from the equator, where Core's
 * haversine (radius 6,371,009 m) measures a latitude step of `d / R` radians
 * as `d` metres. */
const ORIGIN: ViewerLocation = {
	latitude: 0,
	longitude: 0,
	altitude: null,
	accuracy: 0,
};
const EARTH_RADIUS_METERS = 6_371_009;
function north(metres: number): ViewerLocation {
	return {
		latitude: ((metres / EARTH_RADIUS_METERS) * 180) / Math.PI,
		longitude: 0,
		altitude: null,
		accuracy: 0,
	};
}

describe("shouldReReadForPosition", () => {
	it("re-reads for the first position a list has", () => {
		expect(shouldReReadForPosition(undefined, ORIGIN)).toBe(true);
	});

	it("keeps the list for a move of 29 metres", () => {
		const next = north(29);
		expect(javaRosaPointDistance(ORIGIN, next)).toBeCloseTo(29, 9);
		expect(shouldReReadForPosition(ORIGIN, next)).toBe(false);
	});

	it("keeps the list for a move of exactly 30 metres", () => {
		/* No pair of doubles on this meridian measures 30 exactly; this is
		 * the nearest one that does not exceed it. Android re-reads only
		 * past 30 (`distanceFromLastLocation > REFRESH_METER_DELTA`). */
		const next = { ...ORIGIN, latitude: 0.00026979610064786747 };
		const measured = javaRosaPointDistance(ORIGIN, next);
		expect(measured).toBeLessThanOrEqual(30);
		expect(measured).toBeCloseTo(30, 9);
		expect(shouldReReadForPosition(ORIGIN, next)).toBe(false);
	});

	it("re-reads for a move of 31 metres", () => {
		const next = north(31);
		expect(javaRosaPointDistance(ORIGIN, next)).toBeCloseTo(31, 9);
		expect(shouldReReadForPosition(ORIGIN, next)).toBe(true);
	});

	it("measures from the shown position, not the origin of the walk", () => {
		expect(shouldReReadForPosition(north(20), north(45))).toBe(false);
		expect(shouldReReadForPosition(north(20), north(55))).toBe(true);
	});
});

describe("positionSettles", () => {
	it("stops on 1,600 metres of accuracy or better", () => {
		expect(positionSettles(1600)).toBe(true);
		expect(positionSettles(5)).toBe(true);
	});

	it("keeps watching past 1,600 metres", () => {
		expect(positionSettles(1600.0001)).toBe(false);
		expect(positionSettles(2000)).toBe(false);
	});

	it("keeps watching when the accuracy is unknown", () => {
		expect(positionSettles(Number.NaN)).toBe(false);
		expect(positionSettles(undefined)).toBe(false);
		expect(positionSettles(Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe("columnsReadHere", () => {
	let next = 0;
	const uuid = () =>
		asUuid(`00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`);
	const hereColumn = (slots: ColumnCommonSlots = {}) =>
		calculatedColumn(uuid(), "Where I am", { kind: "here" }, slots);
	/* Only `tile`'s presence matters here; its cells never reach the rule. */
	const TILE = {} as NonNullable<CaseListConfig["tile"]>;
	function config(
		columns: CaseListConfig["columns"],
		tile?: CaseListConfig["tile"],
	): CaseListConfig {
		const order = columns.map((column) => column.uuid);
		return {
			...emptyCaseListConfig(),
			columns,
			listColumnOrder: order,
			detailColumnOrder: order,
			...(tile === undefined ? {} : { tile }),
		};
	}

	it("reads nothing without a list or without a here() column", () => {
		expect(columnsReadHere(undefined, "list")).toBe(false);
		expect(
			columnsReadHere(config([plainColumn(uuid(), "name", "Name")]), "list"),
		).toBe(false);
	});

	it("finds here() inside another expression", () => {
		const nested = calculatedColumn(uuid(), "Where I am", {
			kind: "concat",
			parts: [{ kind: "here" }, term(literal(" (you)"))],
		});
		expect(columnsReadHere(config([nested]), "list")).toBe(true);
	});

	it("follows what each screen shows", () => {
		const detailOnly = hereColumn({ visibleInList: false });
		expect(columnsReadHere(config([detailOnly]), "detail")).toBe(true);
		/* A list without a tile computes every column. */
		expect(columnsReadHere(config([detailOnly]), "list")).toBe(true);
		/* A tile list's Results never show a Details-only column. */
		expect(columnsReadHere(config([detailOnly], TILE), "list")).toBe(false);
		expect(
			columnsReadHere(
				config([hereColumn({ visibleInDetail: false })]),
				"detail",
			),
		).toBe(false);
	});
});
