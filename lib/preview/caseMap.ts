import type {
	CaseListConfig,
	CaseMapLayerKind,
	Column,
	Platform,
	Uuid,
} from "@/lib/domain";
import { caseMapSources } from "@/lib/domain/caseMap";
import { type ColumnDisplayContext, columnRawText } from "./columnDisplay";
import type { CaseRowWithCalculated } from "./engine/caseDataBindingTypes";
import { parsePoint, parsePointList, parsePolygon } from "./xpath/javaRosaGeo";

/** Both native table views use these inputs for their map rather than drawing
 * them as ordinary cells. Tile cells have their own platform presentation. */
export function ordinaryCaseResultCell(column: Column) {
	return column.kind !== "map-location" && column.kind !== "map-layer";
}

type Sources = ReturnType<typeof caseMapSources>;
export interface CaseMapPoint {
	lat: number;
	lng: number;
}
interface CaseMapGeometry {
	location?: CaseMapPoint;
	boundary: CaseMapPoint[];
	boundaryColor: string;
	points: CaseMapPoint[];
	pointColors: string[];
	invalid: boolean;
}

/** CASE_LIST_MAP is the exact project's Web Apps switch. EntitySelectActivity
 * offers the Android map whenever its short detail carries an address. */
export function workerMapOffered(
	platform: Platform,
	hasLocation: boolean,
	hasCases: boolean,
	confirmed: boolean | null | undefined,
) {
	return (
		hasLocation && hasCases && (platform === "android" || confirmed === true)
	);
}

/** Resolve each location and layer through the same case-row reading used by
 * the list's other columns. Browser and app-test workers see the same map. */
export function caseMapRows(
	platform: Platform,
	config: CaseListConfig,
	rows: readonly CaseRowWithCalculated[],
	reading: ColumnDisplayContext["reading"],
) {
	const sources = caseMapSources(config, "list");
	const columns = new Map(
		config.columns.map((column) => [column.uuid, column]),
	);
	return rows.map((row) => ({
		row,
		geometry: projectCaseMap(platform, sources, (id) => {
			const column = columns.get(id);
			return column &&
				(column.kind === "map-location" || column.kind === "map-layer")
				? columnRawText(column, row, reading)
				: "";
		}),
	}));
}

function coordinate(p: { latitude: number; longitude: number }): CaseMapPoint {
	if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude))
		throw new Error("Non-finite coordinate");
	return { lat: p.latitude, lng: p.longitude };
}

// android.graphics.Color.parseColor accepts color names, #RRGGBB and #AARRGGBB.
const namedColors: Record<string, string> = {
	black: "000000",
	darkgray: "444444",
	gray: "888888",
	lightgray: "cccccc",
	white: "ffffff",
	red: "ff0000",
	green: "00ff00",
	blue: "0000ff",
	yellow: "ffff00",
	cyan: "00ffff",
	magenta: "ff00ff",
	aqua: "00ffff",
	fuchsia: "ff00ff",
	darkgrey: "444444",
	grey: "888888",
	lightgrey: "cccccc",
	lime: "00ff00",
	maroon: "800000",
	navy: "000080",
	olive: "808000",
	purple: "800080",
	silver: "c0c0c0",
	teal: "008080",
};
function androidColor(text: string): string {
	const hex = namedColors[text.toLowerCase()];
	if (typeof hex === "string") return `#${hex}`;
	if (/^#[\da-f]{6}$/i.test(text)) return text;
	if (/^#[\da-f]{8}$/i.test(text))
		return `#${text.slice(3)}${text.slice(1, 3)}`;
	throw new Error("Invalid map color");
}

export function projectCaseMap(
	platform: Platform,
	sources: Sources,
	read: (id: Uuid) => string,
): CaseMapGeometry {
	const result: CaseMapGeometry = {
		boundary: [],
		boundaryColor: "#ffffff",
		points: [],
		pointColors: [],
		invalid: false,
	};
	if (platform === "web-apps") {
		const first = sources.locations[0];
		if (!first) return result;
		const value = read(first);
		if (!value) return result;
		const [lat, lng] = value.split(" ");
		if (
			lng !== undefined &&
			Number.isFinite(Number(lat)) &&
			Number.isFinite(Number(lng))
		)
			result.location = { lat: Number(lat), lng: Number(lng) };
		else result.invalid = true;
		return result;
	}
	const attempt = <T>(
		value: string,
		parse: (s: string) => T,
	): T | undefined => {
		if (!value.trim()) return undefined;
		try {
			return parse(value.trim());
		} catch {
			result.invalid = true;
			return undefined;
		}
	};
	for (const id of sources.locations) {
		result.location = attempt(read(id), (text) => coordinate(parsePoint(text)));
		if (result.location) break;
	}
	const layer = (role: CaseMapLayerKind) => {
		const id = sources.layers[role]?.[0];
		return id ? read(id) : "";
	};
	result.boundary =
		attempt(layer("boundary"), (s) => parsePolygon(s).map(coordinate)) ?? [];
	const boundaryColor = attempt(layer("boundary-color"), androidColor);
	if (boundaryColor) result.boundaryColor = boundaryColor.slice(0, 7);
	result.points =
		attempt(layer("points"), (s) => parsePointList(s).map(coordinate)) ?? [];
	result.pointColors =
		attempt(layer("point-colors"), (s) =>
			s
				.split(/[\s,]+/)
				.filter(Boolean)
				.map(androidColor),
		) ?? [];
	if (
		result.points.length &&
		result.pointColors.length &&
		result.points.length !== result.pointColors.length
	) {
		result.pointColors = [];
		result.invalid = true;
	}
	return result;
}
