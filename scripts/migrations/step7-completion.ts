import { z } from "zod";
import {
	sourceRevision as connectSource,
	convert as convertConnect,
} from "../../lib/db/releasedConnectShape.mjs";
import { uuidSchema } from "../../lib/domain/uuid";
import {
	convert as convertLocation,
	sourceRevision,
} from "./step7-location-capture.mjs";
import { convertMenuLayouts } from "./step7-menu-layouts";

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

export const completionSettingsSchema = z.strictObject({
	locationCapture: z.json(),
	menuLayouts: frozenMenuLayoutsSchema,
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
	return convertMenuLayouts(
		candidate,
		settings.menuLayouts.decisions,
		coordinate,
	);
}
