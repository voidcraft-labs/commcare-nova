import { z } from "zod";
import {
	sourceRevision as connectSource,
	convert as convertConnect,
} from "../../lib/db/releasedConnectShape.mjs";
import { searchResultsNameSchema } from "../../lib/domain/modules";
import { uuidSchema } from "../../lib/domain/uuid";
import {
	convert as convertLocation,
	sourceRevision,
} from "./step7-location-capture.mjs";
import { convertMenuLayouts } from "./step7-menu-layouts";
import { convertSearchResults } from "./step7-search-results.mjs";

export { sourceRevision };

const frozenMenuLayoutsSchema = z.strictObject({
	digest: z.string().regex(/^[a-f0-9]{64}$/),
	decisions: z.array(
		z.strictObject({
			appId: z.string().min(1),
			projectId: z.string().min(1),
			deploymentId: z.string().min(1),
			remoteId: z.string().min(1),
			mappingToken: z.string().min(1),
			sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
			headSeq: z.number().int().nonnegative(),
			settings: z.strictObject({
				firstMenuLayout: z.literal("grid").optional(),
				formMenuLayout: z.enum(["grid", "individual"]).optional(),
			}),
			gridMenus: z.array(uuidSchema),
		}),
	),
});

const frozenSearchResultsSchema = z.strictObject({
	targets: z.array(
		z.strictObject({
			id: uuidSchema,
			mapping_id: uuidSchema,
			app_id: z.string().min(1),
			project_id: z.string().min(1),
			server: z.string().min(1),
			domain: z.string().min(1),
			remote_id: z.string().min(1),
			push_token: uuidSchema,
			adopted_by: z.string().min(1),
			pushed_revision: z.union([z.string(), z.number(), z.null()]),
			remote_app_id: z.string().min(1),
			origin: z.enum(["read", "changes", "push"]),
			source_bytes: z.number().int().positive(),
			source_digest: z.string().regex(/^[a-f0-9]{64}$/),
			nova_revision: z.union([z.string(), z.number()]),
			observed_by: z.string().min(1),
			menus: z.array(
				z.strictObject({
					menu: uuidSchema,
					uniqueId: z.string().min(1),
					name: searchResultsNameSchema.nullable(),
				}),
			),
		}),
	),
});

export const completionSettingsSchema = z.strictObject({
	locationCapture: z.json(),
	menuLayouts: frozenMenuLayoutsSchema,
	searchResults: frozenSearchResultsSchema,
});

/** Each current, published, historical and private snapshot takes the same
 * order. GPS needs the old scalar role. Layout needs the adopted app and
 * Project identities, which the Connect conversion preserves. */
export function convert(
	snapshot: unknown,
	settings: z.infer<typeof completionSettingsSchema>,
	coordinate: { appId: string; projectId: string; purpose?: string },
) {
	if (sourceRevision !== connectSource)
		throw new Error(
			"The completion conversions require the same released source.",
		);
	const location = convertLocation(snapshot, settings, coordinate);
	const candidate = convertConnect(location, settings, coordinate);
	const layouts = convertMenuLayouts(
		candidate,
		settings.menuLayouts.decisions,
		coordinate,
	);
	return convertSearchResults(layouts, settings, coordinate);
}
