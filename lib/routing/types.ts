/**
 * Builder URL location types.
 *
 * `Location` is a discriminated union over every valid URL shape the builder
 * can occupy. The URL is path-based and navigated via the browser History
 * API (pushState/replaceState) — no server round-trips for intra-builder
 * navigation.
 *
 * URL schema (path segments after /build/[id]):
 *
 *   /build/[id]                                   → home
 *   /build/[id]/{moduleUuid}                      → module
 *   /build/[id]/{moduleUuid}/results              → case-results authoring
 *   /build/[id]/{moduleUuid}/cases/{caseId}       → case detail
 *   /build/[id]/{moduleUuid}/search               → case-search authoring
 *   /build/[id]/{moduleUuid}/details              → case-details authoring
 *   /build/[id]/{formUuid}                        → form
 *   /build/[id]/{formUuid}/{fieldUuid}          → form + selected field
 *
 * All entity UUIDs are globally unique in the doc store. A single UUID
 * segment identifies the entity type by checking `doc.modules[uuid]`,
 * `doc.forms[uuid]`, `doc.fields[uuid]`. For fields, the parent
 * form is derived from the doc's ordering maps.
 */

import { z } from "zod";
import { uuidSchema } from "@/lib/domain";

/**
 * Every valid builder location, as a Zod discriminated union over `kind`.
 * Home is the default when the path is empty or unrecognized. Cases, Form,
 * and SearchConfig require their respective UUID params; a missing or
 * unresolvable UUID collapses to home (resolved by the path parser, not the
 * schema).
 *
 * `cases` / `search-config` / `detail-config` are sibling kinds — the
 * three tabs of the unified case workspace (Results / Search /
 * Details). The internal kinds stay stable for presence compatibility;
 * their serialized URL segments use the user-facing tab nouns. Each
 * tab is its own URL kind so tab switches are ordinary
 * history navigation and the routing dispatch branches on a single
 * discriminator instead of carrying a tab parameter.
 *
 * The schema is the source of truth and `Location` is inferred from it, so
 * the presence wire (`presenceDocSchema` carries `location: locationSchema`)
 * validates a peer's location on read against the exact same shape the
 * routing hooks consume. `uuidSchema` types the entity-uuid slots as the
 * branded `Uuid`.
 */
export const locationSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("home") }).strict(),
	z.object({ kind: z.literal("module"), moduleUuid: uuidSchema }).strict(),
	z
		.object({
			kind: z.literal("cases"),
			moduleUuid: uuidSchema,
			caseId: z.string().optional(),
		})
		.strict(),
	z
		.object({ kind: z.literal("search-config"), moduleUuid: uuidSchema })
		.strict(),
	z
		.object({ kind: z.literal("detail-config"), moduleUuid: uuidSchema })
		.strict(),
	z
		.object({
			kind: z.literal("form"),
			moduleUuid: uuidSchema,
			formUuid: uuidSchema,
			selectedUuid: uuidSchema.optional(),
		})
		.strict(),
]);

export type Location = z.infer<typeof locationSchema>;
