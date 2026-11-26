import { z } from "zod";

export const MANUAL_LOOKUP_MANIFEST = "lookup-install.json";
export const MANUAL_LOOKUP_INSTALL_PATH = "/build/install-lookup-data";

export const manualLookupManifestSchema = z.strictObject({
	version: z.literal(1),
	appId: z.string().min(1).max(128),
	documentRevision: z.number().int().nonnegative(),
	dataRevision: z.string().regex(/^\d{1,19}$/),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
});

export type ManualLookupManifest = z.infer<typeof manualLookupManifestSchema>;
