import { z } from "zod";

/** One authored lifecycle across embedded and external hosts. Hosts bind their
 * own work and request identities; MCP adds those transport arguments. */
const empty = z.strictObject({});
const expectedRevision = z
	.string()
	.min(1)
	.describe(
		"Opaque revision from the current private work. A save or discard applies only to that exact pending candidate.",
	);

export const WORK_TOOL_DEFINITIONS = {
	beginWork: {
		description:
			"Open private work for an existing app or begin a new app. A new app appears only after its first valid save. Reuse the returned work ID across checkpoints.",
		inputSchema: z
			.strictObject({
				app_id: z.string().min(1).optional(),
				new_app: z
					.strictObject({
						name: z.string().trim().min(1),
						project_id: z.string().min(1).optional(),
					})
					.optional(),
			})
			.refine(
				(value) =>
					(value.app_id !== undefined) !== (value.new_app !== undefined),
				{
					message: "Choose either app_id or new_app.",
				},
			),
		strict: false,
	},
	getWork: {
		description:
			"Read the current private app, pending changes, validation findings, and revision needed to save or discard. Reports when saved app changes have made this work stale.",
		inputSchema: empty,
		strict: false,
	},
	listWork: {
		description:
			"Find your private work, with pending work first. Only work belonging to this authoring surface is returned.",
		inputSchema: z.strictObject({
			app_id: z.string().min(1).optional(),
			project_id: z.string().min(1).optional(),
			limit: z.number().int().min(1).max(100).default(20),
			offset: z.number().int().min(0).default(0),
		}),
		strict: false,
	},
	saveWork: {
		description:
			"Save a complete, valid checkpoint from private work. The first save creates the app. A refused save preserves pending work for correction; newer saved changes require restarting from current state.",
		inputSchema: z.strictObject({ expectedRevision }),
		strict: false,
	},
	discardWork: {
		description:
			"Discard the exact pending candidate while retaining saved checkpoints and history. The same work ID can begin fresh changes from the current saved app. Separate data and deployment effects are not undone.",
		inputSchema: z.strictObject({ expectedRevision }),
		strict: false,
	},
} as const;
