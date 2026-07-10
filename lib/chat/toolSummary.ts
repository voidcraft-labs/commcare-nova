// Friendly presentation of the SA's tool calls for the chat transcript.
//
// The Solutions Architect emits many fine-grained tool calls per turn
// (addFields, addCaseListColumns, …). `ChatMessage` groups each consecutive RUN
// of edit-tool calls into a collapsed "N changes" summary; this module is the
// vocabulary that summary speaks.
//
// Each mutating tool returns a prose `message` (the contract the SA + MCP
// clients read) AND a structured `summary` (`{ location, subject }`) — the
// names the tool already resolved, exposed as discrete fields. We render the
// summary, NOT the prose: the prose buries the location at the end and leaks
// uuids / "index 0". A call without a `summary` (a read tool, or one not yet
// wired) falls back to its prose so it still reads sensibly.

import type { ToolUIPart } from "ai";
import type { ToolCallSummary } from "@/lib/agent/tools/shared/toolCallSummary";

/** The two tenses a row can read in: `doing` while the call is in flight (or
 *  failed — the act never completed, so the past tense would claim a change
 *  that didn't land), `done` once it succeeded. */
interface ActionPhrases {
	doing: string;
	done: string;
}

/** Friendly "<verb> <noun>" action phrases, keyed by tool name, in both tenses
 *  ("Adding fields" spinning → "Added fields" once committed). The transcript
 *  appends the call's `summary.subject` in quotes when present, so these stay
 *  as the bare verb+noun ("Added column" → `Added column "Age"`) — and since a
 *  summary only exists once the call returns, the `doing` form always stands
 *  alone. */
const TOOL_ACTIONS: Record<string, ActionPhrases> = {
	addFields: { doing: "Adding fields", done: "Added fields" },
	editField: { doing: "Updating field", done: "Updated field" },
	removeField: { doing: "Removing field", done: "Removed field" },
	createForm: { doing: "Creating form", done: "Created form" },
	updateForm: { doing: "Updating form", done: "Updated form" },
	removeForm: { doing: "Removing form", done: "Removed form" },
	createModule: { doing: "Creating module", done: "Created module" },
	updateModule: { doing: "Renaming module", done: "Renamed module" },
	removeModule: { doing: "Removing module", done: "Removed module" },
	addCaseListColumns: { doing: "Adding columns", done: "Added columns" },
	updateCaseListColumn: { doing: "Updating column", done: "Updated column" },
	removeCaseListColumn: { doing: "Removing column", done: "Removed column" },
	reorderCaseListColumns: {
		doing: "Reordering columns",
		done: "Reordered columns",
	},
	addSearchInputs: {
		doing: "Adding search inputs",
		done: "Added search inputs",
	},
	updateSearchInput: {
		doing: "Updating search input",
		done: "Updated search input",
	},
	removeSearchInput: {
		doing: "Removing search input",
		done: "Removed search input",
	},
	reorderSearchInputs: {
		doing: "Reordering search inputs",
		done: "Reordered search inputs",
	},
	setCaseListFilter: {
		doing: "Setting the case-list filter",
		done: "Set the case-list filter",
	},
	setCaseSearchAdvanced: {
		doing: "Updating advanced search",
		done: "Updated advanced search",
	},
	setCaseSearchDisplay: {
		doing: "Updating the search screen",
		done: "Updated the search screen",
	},
	attachFieldMedia: { doing: "Setting field media", done: "Set field media" },
	attachOptionMedia: {
		doing: "Setting option media",
		done: "Set option media",
	},
	setMenuMedia: { doing: "Setting menu media", done: "Set menu media" },
	updateApp: { doing: "Updating app settings", done: "Updated app settings" },
	// Historical threads only — these tools are retired, but runs
	// persisted before their retirement still carry these parts.
	completeBuild: { doing: "Finishing the app", done: "Finished the app" },
	validateApp: { doing: "Validating the app", done: "Validated the app" },
	setModuleMedia: { doing: "Setting module media", done: "Set module media" },
	setFormMedia: { doing: "Setting form media", done: "Set form media" },
	searchBlueprint: { doing: "Searching the app", done: "Searched the app" },
	getModule: { doing: "Inspecting a module", done: "Inspected a module" },
	getForm: { doing: "Inspecting a form", done: "Inspected a form" },
	getField: { doing: "Inspecting a field", done: "Inspected a field" },
};

/** Verb phrases for the app-level Connect flip, keyed by the resulting state
 *  the tool reported (`summary.connect`). The fact is the RESULT, not the
 *  transition, so the set/switch cases share one honest "Set …" phrasing. */
const CONNECT_ACTIONS: Record<string, string> = {
	learn: "Set CommCare Connect to Learn",
	deliver: "Set CommCare Connect to Deliver",
	off: "Turned off CommCare Connect",
};

/** `updateApp` has exactly two slots (name, connect type), so its row names the
 *  act itself — "Named the app" / "Renamed the app" / a Connect phrase — instead
 *  of the generic "Updated app settings". The name renders on the secondary "→"
 *  line (see `toolLocation`), never inline where a long title truncates the
 *  headline. Falls back to the generic phrase for a row recorded before the
 *  tool reported these facts. */
const updateAppAction = (
	summary: ToolCallSummary | undefined,
	tense: keyof ActionPhrases,
): string => {
	if (summary?.nameChange) {
		return summary.nameChange === "named" ? "Named the app" : "Renamed the app";
	}
	if (summary?.connect) return CONNECT_ACTIONS[summary.connect];
	return TOOL_ACTIONS.updateApp[tense];
};

/** Tools whose single call performs a MULTI-ITEM action — the friendly action
 *  folds in `summary.count` ("Added 3 fields", "Reordered 5 columns"), each
 *  pluralizing its own noun. Falls back to the static `TOOL_ACTIONS` phrase when
 *  the count is absent (e.g. a read tool, or a call not carrying a summary). */
const COUNTABLE_ACTIONS: Record<string, (n: number) => string> = {
	addFields: (n) => `Added ${n} ${n === 1 ? "field" : "fields"}`,
	addCaseListColumns: (n) => `Added ${n} ${n === 1 ? "column" : "columns"}`,
	addSearchInputs: (n) =>
		`Added ${n} ${n === 1 ? "search input" : "search inputs"}`,
	reorderCaseListColumns: (n) =>
		`Reordered ${n} ${n === 1 ? "column" : "columns"}`,
	reorderSearchInputs: (n) =>
		`Reordered ${n} ${n === 1 ? "search input" : "search inputs"}`,
	/* "Set" covers both directions of the media tools — a batch can mix
	 * attaches and clears, and either way the slot was set to a stated
	 * value. `attachFieldMedia`'s count is DISTINCT fields (several slots
	 * of one field is still one field to the reader); the other two count
	 * their items. */
	attachFieldMedia: (n) => `Set media on ${n} ${n === 1 ? "field" : "fields"}`,
	attachOptionMedia: (n) =>
		`Set media on ${n} ${n === 1 ? "option" : "options"}`,
	setMenuMedia: (n) => `Set media on ${n} menu ${n === 1 ? "tile" : "tiles"}`,
};

export type ToolStatus = "pending" | "done" | "failed";

/** Tool name without the AI SDK `tool-` part-type prefix. */
const toolName = (part: ToolUIPart): string => part.type.replace(/^tool-/, "");

/** Whether a part is an edit-tool call that groups into the change summary.
 *  Excludes the specially-rendered tools: `askQuestions` (its own card) and the
 *  build-mode generators (the signal grid + GenerationProgress own that). */
export const isEditToolPart = (part: { type: string }): boolean =>
	part.type.startsWith("tool-") &&
	part.type !== "tool-askQuestions" &&
	part.type !== "tool-generateSchema" &&
	// Historical threads only — retired build-mode tools.
	part.type !== "tool-generateScaffold" &&
	part.type !== "tool-planAppDesign";

/** The mutating-tool success shape we read for presentation. All fields are
 *  optional here because we narrow defensively off the part's `unknown`
 *  output — a failed call carries `{ error }` instead, a read tool carries its
 *  own payload, and an in-flight call carries nothing yet. */
interface MutationOutput {
	message?: string;
	summary?: ToolCallSummary;
	error?: string;
}

/** Narrow a part's output to the mutating-success shape, or null. */
const outputOf = (part: ToolUIPart): MutationOutput | null => {
	if (part.state !== "output-available") return null;
	const out = part.output;
	return typeof out === "object" && out !== null
		? (out as MutationOutput)
		: null;
};

/** Tools whose OUTCOME is `{ success, errors? }` — both retired, both
 *  still present on threads persisted before their retirement. */
const COMPLETION_TOOLS = new Set(["completeBuild", "validateApp"]);

/** A refused completion OUTCOME: the call returns `{ success:false, errors }`.
 *  This is the one case where a completed tool call must read as a failure —
 *  the app isn't finished. Returns the finding list, or null when not
 *  applicable. Exported so the transcript can render the list as collapsed
 *  bullets rather than dumping the joined string. */
export const completionErrors = (part: ToolUIPart): string[] | null => {
	if (
		!COMPLETION_TOOLS.has(toolName(part)) ||
		part.state !== "output-available"
	) {
		return null;
	}
	const out = part.output as
		| { success?: boolean; errors?: string[] }
		| undefined;
	if (out?.success === false) {
		return out.errors?.length ? out.errors : ["The app isn't finished yet."];
	}
	return null;
};

/** Per-call status, treating a refused completion outcome and an `{ error }`
 *  result as failures even though the call itself executed. */
export const toolStatus = (part: ToolUIPart): ToolStatus => {
	if (part.state === "input-streaming" || part.state === "input-available") {
		return "pending";
	}
	if (part.state === "output-error" || completionErrors(part)) return "failed";
	if (outputOf(part)?.error !== undefined) return "failed";
	return "done";
};

/** The headline action for a call: the friendly verb+noun in the tense the
 *  call's status earns — "Adding fields" while the spinner runs, "Added
 *  fields" once it lands, and back to the gerund for a failure (the change
 *  never happened, so "Added" would lie). The call's subject is appended in
 *  quotes when the tool reported one. Falls back to the raw tool name so a
 *  newly-added tool still reads before it's mapped here. */
export const toolAction = (part: ToolUIPart): string => {
	const name = toolName(part);
	const tense: keyof ActionPhrases =
		toolStatus(part) === "done" ? "done" : "doing";
	const summary = outputOf(part)?.summary;
	if (name === "updateApp") return updateAppAction(summary, tense);
	// Multi-item actions fold the count into the verb+noun ("Added 3 fields").
	// Count lives on the summary, which only a completed call carries — so the
	// past tense these phrases speak is always earned.
	const countable = COUNTABLE_ACTIONS[name];
	if (countable && typeof summary?.count === "number") {
		return countable(summary.count);
	}
	const action = TOOL_ACTIONS[name]?.[tense] ?? name;
	return summary?.subject ? `${action} "${summary.subject}"` : action;
};

/** The secondary "→" line beneath the action: the container breadcrumb
 *  ("Clients") for a scoped edit, or — for the app-level `updateApp`, which has
 *  no container — the app's new name, so the row reads "Named the app →
 *  Client Registration" with the full title on its own line. Null when the act
 *  is top-level with nothing to point at or the call carries no summary. */
export const toolLocation = (part: ToolUIPart): string | null => {
	const summary = outputOf(part)?.summary;
	if (!summary) return null;
	if (toolName(part) === "updateApp") return summary.subject ?? null;
	return summary.location ?? null;
};

/** Secondary line beneath the action: an error to surface, a completion
 *  outcome, or — for a call without a structured summary (read tools, or one
 *  not yet wired) — its raw prose so nothing renders blank. Null when the
 *  action + location already say everything. */
export const toolDetail = (part: ToolUIPart): string | null => {
	const cerrors = completionErrors(part);
	if (cerrors) return cerrors.join("\n");
	if (COMPLETION_TOOLS.has(toolName(part)) && toolStatus(part) === "done") {
		return "App complete and ready to use.";
	}
	// A tool that threw, or whose input the schema rejected, surfaces as
	// `output-error` with the AI SDK's raw `errorText` (e.g. an
	// "AI_ToolExecutionError: …"). That text is recorded server-side — the run's
	// event log plus a warn line, see `generationContext.ts`'s
	// `handleAgentStep` — but must never face the user, so show a friendly line.
	// (Tools that catch their own failures return a friendly `{ error }` string,
	// handled just below — that path is intentionally preserved.)
	if (part.state === "output-error") return "This change couldn't be applied.";

	const out = part.output;
	if (typeof out === "object" && out !== null && "error" in out) {
		return String((out as { error: unknown }).error);
	}
	// updateApp's headline carries the name verb when BOTH slots changed —
	// surface the Connect flip on the detail line so neither change is hidden.
	if (toolName(part) === "updateApp") {
		const summary = outputOf(part)?.summary;
		if (summary?.nameChange && summary.connect) {
			return CONNECT_ACTIONS[summary.connect];
		}
	}
	// A structured summary already drives the action + breadcrumb — no prose
	// needed. Only fall back to the prose `message` (or a bare-string result)
	// when there's no summary to render from.
	if (outputOf(part)?.summary) return null;
	if (typeof out === "string") return out;
	if (typeof out === "object" && out !== null && "message" in out) {
		return String((out as { message: unknown }).message);
	}
	return null;
};

/** Roll a run of tool calls up to one status for the collapsed header: failed if
 *  any failed, else pending if any in-flight, else done. */
export const runStatus = (parts: ToolUIPart[]): ToolStatus => {
	if (parts.some((p) => toolStatus(p) === "failed")) return "failed";
	if (parts.some((p) => toolStatus(p) === "pending")) return "pending";
	return "done";
};
