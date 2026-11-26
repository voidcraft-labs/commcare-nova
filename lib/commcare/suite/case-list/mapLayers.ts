import type { CaseMapLayerKind } from "@/lib/domain";

export const CASE_MAP_FORMATS = {
	boundary: { hq: "geo-boundary", suite: "geo_boundary" },
	"boundary-color": {
		hq: "geo-boundary-color",
		suite: "geo_boundary_color_hex",
	},
	points: { hq: "geo-points", suite: "geo_points" },
	"point-colors": { hq: "geo-points-colors", suite: "geo_points_colors_hex" },
} as const satisfies Record<CaseMapLayerKind, { hq: string; suite: string }>;
