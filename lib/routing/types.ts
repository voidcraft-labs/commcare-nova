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
 *   /build/[id]/setup/{section}                   → app setup workspace
 *   /build/[id]/project-data                      → Project data workspace
 *   /build/[id]/project-data/{tableId}            → one Project data table
 *   /build/[id]/{moduleUuid}                      → module
 *   /build/[id]/{moduleUuid}/results              → case-results authoring
 *   /build/[id]/{moduleUuid}/cases/{caseId}       → case detail
 *   /build/[id]/{moduleUuid}/search               → case-search authoring
 *   /build/[id]/{moduleUuid}/details              → case-details authoring
 *   /build/[id]/{moduleUuid}/data-review          → data review screen
 *   /build/[id]/{moduleUuid}/condition            → module display condition
 *   /build/[id]/{formUuid}                        → form
 *   /build/[id]/{formUuid}/condition              → form display condition
 *   /build/[id]/{formUuid}/operations             → form case operations
 *   /build/[id]/{formUuid}/operations/{opUuid}    → …with one selected
 *   /build/[id]/{formUuid}/{fieldUuid}          → form + selected field
 *
 * All entity UUIDs are globally unique in the doc store. A single UUID
 * segment identifies the entity type by checking `doc.modules[uuid]`,
 * `doc.forms[uuid]`, `doc.fields[uuid]`. For fields, the parent
 * form is derived from the doc's ordering maps. `setup` and `project-data`
 * are the two reserved first segments, so the parser matches each before any
 * uuid lookup.
 */

import { z } from "zod";
import { uuidSchema } from "@/lib/domain";
import { lookupTableIdSchema } from "@/lib/domain/lookupIds";

/** The Project data workspace's own name, wherever it is named as a whole. */
export const PROJECT_DATA_LABEL = "Project data";

/**
 * The one sentence every Project data surface states, because a lookup
 * table is Project-shared: an edit here is not scoped to the app the
 * author happens to have open.
 */
export const PROJECT_DATA_SHARED_NOTICE =
	"These tables are shared with every app in this Project. A change here affects all of them.";

/**
 * The App setup workspace's sections, in the order they appear.
 *
 * App setup is app administration, not app content: it never appears as a
 * child of the structure tree, which represents the runnable app. All four
 * sections are named here because the workspace's shape is a product
 * contract; each one either has a body or says plainly that it does not
 * yet.
 */
export const APP_SETUP_SECTIONS = [
	"users",
	"organization",
	"languages",
	"automations",
	"publishing",
] as const;
export type AppSetupSection = (typeof APP_SETUP_SECTIONS)[number];

/** Where `/build/{id}/setup` and any unrecognized section land. */
export const DEFAULT_APP_SETUP_SECTION: AppSetupSection = "users";

/**
 * Each section's name, in the author's words. Lives beside the enum so the
 * breadcrumb, the section strip, and the navigation entries cannot drift
 * into three different names for one destination.
 */
export const APP_SETUP_SECTION_LABELS: Readonly<
	Record<AppSetupSection, string>
> = {
	users: "Users and personas",
	organization: "Organization",
	languages: "Languages",
	automations: "Automations",
	publishing: "Publishing",
};

/** The workspace's own name, wherever it is referred to as a whole. */
export const APP_SETUP_LABEL = "App setup";

/**
 * Every valid builder location, as a Zod discriminated union over `kind`.
 * Home is the default when the path is empty or unrecognized. Cases, Form,
 * and SearchConfig require their respective UUID params; a missing or
 * unresolvable UUID collapses to home (resolved by the path parser, not the
 * schema).
 *
 * `module-condition` / `form-condition` are the two navigation
 * display-condition surfaces. Each is its own URL because the condition
 * editor is a full-width centre-canvas screen with its own breadcrumb,
 * deep link, and Preview target, and because the module's and the form's
 * conditions are evaluated in different places by CommCare.
 *
 * `form-operations` carries its selected operation IN the URL rather than in
 * local state, unlike the case workspace's row selection: a form can hold
 * twenty operations, and "look at this one" is a thing an author needs to be
 * able to send someone.
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
	/* App setup carries no `moduleUuid` — it names no blueprint entity, which
	 * is exactly what keeps it out of the structure tree's world. Every
	 * module-keyed helper must therefore branch on it explicitly rather than
	 * reading a uuid that isn't there. */
	z
		.object({
			kind: z.literal("app-setup"),
			section: z.enum(APP_SETUP_SECTIONS),
		})
		.strict(),
	/* Project data carries no `moduleUuid` either, and for a stronger reason:
	 * a lookup table belongs to the PROJECT, shared by every app in it. Its
	 * `tableId` addresses one, which the blueprint has no authority over — the
	 * doc can neither validate nor invalidate it, so the workspace itself owns
	 * the "that table is gone" state. */
	z
		.object({
			kind: z.literal("project-data"),
			tableId: lookupTableIdSchema.optional(),
		})
		.strict(),
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
	z.object({ kind: z.literal("data-review"), moduleUuid: uuidSchema }).strict(),
	z
		.object({ kind: z.literal("module-condition"), moduleUuid: uuidSchema })
		.strict(),
	z
		.object({
			kind: z.literal("form-condition"),
			moduleUuid: uuidSchema,
			formUuid: uuidSchema,
		})
		.strict(),
	z
		.object({
			kind: z.literal("form-operations"),
			moduleUuid: uuidSchema,
			formUuid: uuidSchema,
			operationUuid: uuidSchema.optional(),
		})
		.strict(),
	// `/build/[id]/{formUuid}/links[/{linkUuid}]` — the form's after-submit
	// links, with one selected link in the URL for the same reason
	// `form-operations` carries its operation: a link must be sendable, and
	// the rail body is keyed by it.
	z
		.object({
			kind: z.literal("form-links"),
			moduleUuid: uuidSchema,
			formUuid: uuidSchema,
			linkUuid: uuidSchema.optional(),
		})
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
