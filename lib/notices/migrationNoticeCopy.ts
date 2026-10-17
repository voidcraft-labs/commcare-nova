/**
 * Every sentence a migration notice says: one renderer per reason, one lead
 * per cutover, the builder chip, and the home page's line about a member's
 * saved CommCare HQ key.
 *
 * A renderer returns the line twice over: as plain text (what `get_app`
 * returns) and as runs (what the dialog draws, linking each entity that
 * still exists). The text is always the runs' texts joined, so the two can
 * never say different things.
 *
 * Dates are rendered as day and month in the viewer's locale and time zone,
 * and never written into a stored entry. Client-safe.
 */

import { CASE_SEARCH_BUTTON_LABEL } from "@/lib/domain/modules";
import {
	isReservedName,
	RESERVED_CONNECT_BLOCK_IDS,
} from "@/lib/domain/questionId";
import {
	isPlanFeatureId,
	PLAN_FEATURE_IDS,
	PLAN_FEATURES,
} from "@/lib/publish/planFeatures";
import {
	PROJECT_SPACE_CAPABILITIES,
	type ProjectSpaceCapabilityId,
} from "@/lib/publish/projectSpaceCompatibility";
import type {
	DeploymentNoticeEntry,
	DocumentNoticeEntry,
	KeyReaderNotice,
	MigrationNoticeCutover,
	MigrationNoticeEntry,
	MigrationNoticeReason,
	NoticeEntityRef,
} from "./migrationNotice";

export type NoticeLinePart =
	| { readonly kind: "text"; readonly text: string }
	| {
			readonly kind: "entity";
			readonly entity: NoticeEntityRef;
			/** The entity's name today where it exists, else its `nameAtMigration`. */
			readonly text: string;
			readonly exists: boolean;
	  };

export interface NoticeLine {
	/** The whole line as plain text: the parts' texts joined. */
	readonly text: string;
	/** The same line in runs: the dialog links each entity part that exists. */
	readonly parts: readonly NoticeLinePart[];
}

export interface NoticeRenderContext {
	/** The entity's current name in the app's document, or null where it is gone. */
	readonly nameOf: (entity: NoticeEntityRef) => string | null;
}

function noticeLine(parts: readonly NoticeLinePart[]): NoticeLine {
	return { text: parts.map((part) => part.text).join(""), parts };
}

function text(value: string): NoticeLinePart {
	return { kind: "text", text: value };
}

/** An entity run: its name today, or the name it had when the cutover ran. */
export function entityPart(
	entity: NoticeEntityRef,
	ctx: NoticeRenderContext,
): NoticeLinePart {
	const current = ctx.nameOf(entity);
	return {
		kind: "entity",
		entity,
		text: current ?? entity.nameAtMigration,
		exists: current !== null,
	};
}

/** The project space a deployment entry is about, named by its domain. */
function projectSpace(entry: DeploymentNoticeEntry): string {
	return entry.deployment.domain;
}

/** Names joined as a sentence lists them: "a, b and c". */
function joinedNames(names: readonly string[]): string {
	if (names.length <= 1) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A project space's name with its possessive: "field-ops'", "acme's". */
function possessive(space: string): string {
	return space.endsWith("s") ? `${space}'` : `${space}'s`;
}

/** The CommCare version Nova's apps need, as a person reads it. */
const COMMCARE_VERSION_FLOOR_TEXT = "2.57";

/** The ids a `detail` list stores, separated by commas. */
function detailIds(value: string | undefined): string[] {
	return value === undefined ? [] : value.split(",").filter(Boolean);
}

function isCapabilityId(value: string): value is ProjectSpaceCapabilityId {
	return Object.hasOwn(PROJECT_SPACE_CAPABILITIES, value);
}

/** Entities joined as a sentence lists them: "Register, Visit and Follow-up". */
function entityList(
	entities: readonly NoticeEntityRef[],
	ctx: NoticeRenderContext,
): NoticeLinePart[] {
	return entities.flatMap((entity, index) => [
		...(index === 0
			? []
			: [text(index === entities.length - 1 ? " and " : ", ")]),
		entityPart(entity, ctx),
	]);
}

/** "on" or "off", as a stored `detail` value names a list's setting. */
function onOff(value: string | undefined): "on" | "off" | undefined {
	return value === "on" || value === "off" ? value : undefined;
}

/** "Intake: " where the entry names its form, else nothing. */
function formLead(form: string | undefined): NoticeLinePart[] {
	return form === undefined ? [] : [text(`${form}: `)];
}

/** "Intake, " where the entry names its form, else nothing. */
function formBeside(form: string | undefined): NoticeLinePart[] {
	return form === undefined ? [] : [text(`${form}, `)];
}

/** "Households, " where the entry names its menu, else nothing. */
function menuBeside(menu: string | undefined): NoticeLinePart[] {
	return menu === undefined ? [] : [text(`${menu}, `)];
}

/**
 * A line that opens with its menu: "Households: <rest>" where the entry
 * names its menu, else the rest alone, opening with a capital.
 */
function menuLead(
	menu: string | undefined,
	rest: string,
	restCapitalized: string,
): NoticeLinePart[] {
	return [text(menu === undefined ? restCapitalized : `${menu}: ${rest}`)];
}

/** The noun a renamed field takes, from `detail.kind`. */
function containerNoun(
	kind: string | undefined,
): "group" | "repeat" | "section" | undefined {
	return kind === "group" || kind === "repeat" || kind === "section"
		? kind
		: undefined;
}

/**
 * What a renamed Connect block means to CommCare Connect, by the block's
 * kind (`detail.block`), after the sentence that names the rename.
 */
const CONNECT_BLOCK_RENAME_CONSEQUENCE: Readonly<
	Record<
		string,
		{
			readonly noun: string;
			readonly says: (to: string, from: string) => string;
		}
	>
> = {
	deliver_unit: {
		noun: "deliver unit",
		says: (to) =>
			` CommCare Connect reads it as a new deliver unit and turns away each delivery until an opportunity manager adds ${to} to a payment unit. It helps to ask them to do that before your next publish: CommCare HQ doesn't send a turned-away delivery again, so deliveries made in between stay unpaid.`,
	},
	learn_module: {
		noun: "learn module",
		says: () =>
			" CommCare Connect reads it as a second module and keeps the old one, so a learner who had not finished the course before this stays short of finished. A learner who had finished stays finished.",
	},
	task: {
		noun: "task",
		says: (_to, from) =>
			` CommCare Connect reads it as a new task type. A task assigned under ${from} is never completed by this form, and CommCare Connect rejects that worker's deliveries while it stays assigned.`,
	},
	assessment: {
		noun: "assessment",
		says: () =>
			" CommCare Connect keeps no record under an assessment's ID, so scoring is unchanged.",
	},
};

/** What a form's new id means for what HQ already holds that names it. */
const FORM_ID_REPOINT =
	"If an SMS keyword or a scheduled message opens one of these forms, you can point it at the form again in CommCare HQ once you release a build made after that publish.";

/** "the previous screen" or "its module": where a moved destination went. */
function formerDestination(from: string | undefined): string {
	return from === "module" ? "its module" : "the previous screen";
}

/** "this module" or "this form", for the item a notice entry names. */
function itemNoun(entity: NoticeEntityRef): string {
	return entity.type === "form" ? "this form" : "this module";
}

export const MIGRATION_NOTICE_COPY = {
	/* The entity is the module whose search button changed text;
	 * `detail.from` is the text it read before in the default language. */
	"search-button-text-changed": (entry: DocumentNoticeEntry, ctx) => {
		const from = entry.detail?.from;
		return noticeLine([
			entityPart(entry.entity, ctx),
			text(
				`: the search button now reads “${CASE_SEARCH_BUTTON_LABEL}”.${
					from === undefined ? "" : ` It read “${from}” before.`
				} CommCare HQ always shows its own text there.`,
			),
		]);
	},
	/* The entity is the field, by its ID; `detail.form` names its form,
	 * `detail.kind` its kind (`question`, `group`, `repeat` or `section`) and
	 * `detail.from` the ID it had. */
	"question-renamed": (entry: DocumentNoticeEntry, ctx) => {
		const from = entry.detail?.from;
		const field = entityPart(entry.entity, ctx);
		const container = containerNoun(entry.detail?.kind);
		const renamed =
			from === undefined
				? [
						text(`the ${container ?? "question"} `),
						field,
						text(" has a new ID"),
					]
				: [text(`the ${container ?? "question"} ${from} is now `), field];
		const readsOld = from === undefined ? "the old ID" : from;
		return noticeLine([
			...formLead(entry.detail?.form),
			...renamed,
			text(
				container === undefined
					? `, because CommCare HQ's form builder can't keep the old ID. Submissions use the new name from your next publish. In CommCare HQ, a form export column or report that reads ${readsOld} stops filling and a new ${field.text} column starts.`
					: `, because CommCare HQ's form builder can't keep the old ID. Every question inside it moves with it, so submissions use the new paths from your next publish. In CommCare HQ, a form export column or report that reads a question under ${readsOld} stops filling and a new column starts.`,
			),
		]);
	},
	/* The entity is the form; `detail.from` and `detail.to` the change's
	 * IDs. */
	"case-operation-renamed": (entry: DocumentNoticeEntry, ctx) => {
		const from = entry.detail?.from;
		const to = entry.detail?.to;
		return noticeLine([
			entityPart(entry.entity, ctx),
			text(
				from === undefined || to === undefined
					? ": a case change has a new name. Its place in each submission moves with the name from your next publish."
					: `: the case change ${from} is now ${to}. Its place in each submission moves with the name from your next publish.`,
			),
		]);
	},
	/* The entity is the form; `detail.block` the block's kind
	 * (`deliver_unit`, `learn_module`, `task` or `assessment`), and
	 * `detail.from` and `detail.to` its IDs. A block renamed from one of the
	 * names CommCare Connect keeps for itself first says Connect could not
	 * receive the form. */
	"connect-block-renamed": (entry: DocumentNoticeEntry, ctx) => {
		const from = entry.detail?.from;
		const to = entry.detail?.to;
		const block = CONNECT_BLOCK_RENAME_CONSEQUENCE[entry.detail?.block ?? ""];
		const refused =
			from !== undefined && isReservedName(from, RESERVED_CONNECT_BLOCK_IDS)
				? `CommCare Connect could not receive this form while its block was called ${from}. Forms sent before this change are not in CommCare Connect, and CommCare HQ's retries of them keep failing, because each still carries the old name. `
				: "";
		const noun = block?.noun ?? "Connect block";
		const lead = refused === "" ? "the" : "The";
		const renamed =
			from === undefined || to === undefined
				? `${lead} ${noun} has a new ID.`
				: `${lead} ${noun} ${from} is now ${to}.`;
		const says =
			block === undefined || from === undefined || to === undefined
				? ""
				: block.says(to, from);
		return noticeLine([
			entityPart(entry.entity, ctx),
			text(`: ${refused}${renamed}${says}`),
		]);
	},
	/* The entity is the form that held both blocks; `detail.task` the task's
	 * ID and `detail.newForm` the name of the form it moved to. */
	"connect-task-moved-to-own-form": (entry: DocumentNoticeEntry, ctx) => {
		const task = entry.detail?.task;
		const newForm = entry.detail?.newForm;
		return noticeLine([
			entityPart(entry.entity, ctx),
			text(
				`: its task ${task === undefined ? "" : `${task} `}is now in a form of its own${newForm === undefined ? "" : `, ${newForm},`} in the same menu. CommCare Connect turned away the visit in a form that also completed a task the worker was assigned. The task keeps its ID, so tasks already assigned are completed by the new form from your next publish.`,
			),
		]);
	},
	/* The entity is the deep link, by its ID; `detail.from` the ID it had. */
	"entry-point-renamed": (entry: DocumentNoticeEntry, ctx) => {
		const from = entry.detail?.from;
		return noticeLine([
			text(
				from === undefined
					? "A deep link is now "
					: `The deep link ${from} is now `,
			),
			entityPart(entry.entity, ctx),
			text(
				". Links shared with the old ID stop working after your next publish.",
			),
		]);
	},
	/* The entity is the form, with `detail.question` the select, or the app
	 * for a case property's own list, with `detail.caseType` and
	 * `detail.property`. `detail.value` is the value both choices stored,
	 * `detail.to` the second's new one, and `detail.keptLabel` and
	 * `detail.label` the labels of the choice that kept it and the one that
	 * moved. */
	"option-value-split": (entry: DocumentNoticeEntry, ctx) => {
		const detail = entry.detail ?? {};
		const first = detail.keptLabel ?? "the first choice";
		const second = detail.label ?? "the second choice";
		const catalog = entry.entity.type === "app";
		const where: NoticeLinePart[] = catalog
			? [
					text(
						detail.caseType !== undefined && detail.property !== undefined
							? `${detail.caseType}, ${detail.property}: `
							: "A case property's choices: ",
					),
				]
			: [
					entityPart(entry.entity, ctx),
					text(detail.question === undefined ? ": " : `, ${detail.question}: `),
				];
		const stored = detail.value ?? "the same value";
		const now =
			detail.to === undefined
				? `${second} now stores a value of its own.`
				: `${second} now stores ${detail.to}.`;
		return noticeLine([
			...where,
			text(
				`the choices ${first} and ${second} both stored ${stored}. ${now} ${catalog ? "Values" : "Answers"} saved before this show as ${first}.`,
			),
		]);
	},
	/* The entity is the form. */
	"empty-form-label-added": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			entityPart(entry.entity, ctx),
			text(
				" had no questions, and CommCare HQ won't build a form like that. It now has one label to replace with your first question.",
			),
		]),
	/* The entity is the question; `detail.form` its form and `detail.datum`
	 * the session value it read. */
	"session-read-removed": (entry: DocumentNoticeEntry, ctx) => {
		const datum = entry.detail?.datum;
		return noticeLine([
			...formBeside(entry.detail?.form),
			entityPart(entry.entity, ctx),
			text(
				`: it read ${datum ?? "a value"} from the session, which no menu of this app supplies, so the form could not open. It now reads nothing there, and the form opens. You can set what it should read.`,
			),
		]);
	},
	/* The entity is the form; `detail.question` names the select and
	 * `detail.value` the option's value, now also its label. */
	"option-label-filled": (entry: DocumentNoticeEntry, ctx) => {
		const question = entry.detail?.question;
		const value = entry.detail?.value;
		return noticeLine([
			entityPart(entry.entity, ctx),
			text(
				`: the choice ${value === undefined ? "" : `with the value ${value} `}in ${question ?? "a question"} had no label, so it now shows its value. Give it the wording you want workers to read.`,
			),
		]);
	},
	/* The entity is the Search question; `detail.menu` names its module, and
	 * `detail.from` and `detail.to` are its names before and after. */
	"search-input-renamed": (entry: DocumentNoticeEntry) => {
		const from = entry.detail?.from;
		const to = entry.detail?.to;
		return noticeLine([
			...menuLead(
				entry.detail?.menu,
				from === undefined || to === undefined
					? "a search input has a new name."
					: `the search input ${from} is now ${to}.`,
				from === undefined || to === undefined
					? "A search input has a new name."
					: `The search input ${from} is now ${to}.`,
			),
			text(" CommCare reads the earlier name as part of the search itself."),
		]);
	},
	/* The entity is the removed Search question, named by its own name;
	 * `detail.menu` names its module and `detail.expressions` counts the
	 * expressions that read it. */
	"search-input-removed": (entry: DocumentNoticeEntry, ctx) => {
		const count = Number(entry.detail?.expressions ?? "0");
		const reads =
			Number.isInteger(count) && count > 0
				? count === 1
					? " 1 expression that read it now treats it as empty."
					: ` ${count} expressions that read it now treat it as empty.`
				: "";
		return noticeLine([
			...menuLead(entry.detail?.menu, "the search input ", "The search input "),
			entityPart(entry.entity, ctx),
			text(
				` was removed. CommCare reads that name as part of the search request, so it never searched a property.${reads}`,
			),
		]);
	},
	/* The entity is the module or the form now off the menu. */
	"hidden-from-menu-set": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			entityPart(entry.entity, ctx),
			text(
				`: ${itemNoun(entry.entity)} is now marked as not on the menu, because its display condition could never be true. Its settings show what can still open it.`,
			),
		]),
	/* The entity is the form; `detail.from` is `previous` or `module`,
	 * `detail.to` is `module` or `firstMenu`, `detail.cause` is
	 * `multi-select-menu`, `multi-select-parent` or `off-the-menu`, and
	 * `detail.menu` names the form's module. */
	"after-submit-destination-moved": (entry: DocumentNoticeEntry, ctx) => {
		const before = formerDestination(entry.detail?.from);
		const menu = entry.detail?.menu ?? "its module";
		const toFirstMenu =
			": after submitting, workers now go to the app's first menu (First menu in its settings).";
		const rest = (() => {
			switch (entry.detail?.cause) {
				case "multi-select-menu":
					return ": after submitting, workers now go back to this module's case list. It was set to the previous screen, which CommCare HQ doesn't offer in a module that selects several cases.";
				case "multi-select-parent":
					return `${toFirstMenu} It was set to ${before}, which CommCare HQ doesn't offer in a module under one that selects several cases.`;
				case "off-the-menu":
					return `${toFirstMenu} It was set to ${before}, and ${menu} is now off the menu, so there is no screen of it to go back to.`;
				default:
					return entry.detail?.to === "module"
						? ": after submitting, workers now go back to this module's case list."
						: toFirstMenu;
			}
		})();
		return noticeLine([entityPart(entry.entity, ctx), text(rest)]);
	},
	/* The entity is the ID mapping column; `detail.menu` names its menu and
	 * `detail.value` the saved value whose entry went. */
	"id-mapping-entry-removed": (entry: DocumentNoticeEntry, ctx) => {
		const value = entry.detail?.value;
		return noticeLine([
			...menuBeside(entry.detail?.menu),
			entityPart(entry.entity, ctx),
			text(
				`: the mapping for ${value ?? "a saved value"} is gone. CommCare HQ's ID mapping can't hold that value, so cases with it now show nothing in this column.`,
			),
		]);
	},
	/* The entity is the date column; `detail.menu` names its menu. */
	"date-pattern-apostrophe-replaced": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			...menuBeside(entry.detail?.menu),
			entityPart(entry.entity, ctx),
			text(
				": the date format's straight apostrophe is now a curved one (’). CommCare HQ's date column can't hold a straight one, and an app holding one could not be installed from CommCare HQ.",
			),
		]),
	/* The entity is the column hidden from Results whose rule went;
	 * `detail.menu` names its menu and `detail.shape` is `calculated` or
	 * `case_id`. */
	"tile-order-rule-removed": (entry: DocumentNoticeEntry, ctx) => {
		const shape = entry.detail?.shape;
		const why =
			shape === "calculated"
				? " A tile list can't order by a calculation that isn't on the tile."
				: shape === "case_id"
					? " A tile list can't order by Record ID unless the column is on the tile."
					: " A tile list can't order by that column while it isn't on the tile.";
		return noticeLine([
			...menuLead(entry.detail?.menu, "the list", "The list"),
			text(" no longer orders by "),
			entityPart(entry.entity, ctx),
			text(`.${why}`),
		]);
	},
	/* The entity is the column whose rule was removed; `detail.menu` names
	 * its menu and `detail.kept` the column whose rule stayed. */
	"order-rule-removed-same-property": (entry: DocumentNoticeEntry, ctx) => {
		const kept = entry.detail?.kept;
		return noticeLine([
			...menuLead(entry.detail?.menu, "removed", "Removed"),
			text(" the order rule on "),
			entityPart(entry.entity, ctx),
			text(
				`. It ordered by the same value as the rule on ${kept ?? "another column"}, and a list keeps one for each value. Apps installed from CommCare HQ followed the removed rule, so their order may change.`,
			),
		]);
	},
	/* The entity is the column the rule moved from; `detail.menu` names its
	 * menu and `detail.to` the first column with that value, which holds the
	 * rule now. */
	"order-rule-moved-to-first-column": (entry: DocumentNoticeEntry, ctx) => {
		const to = entry.detail?.to;
		return noticeLine([
			...menuLead(entry.detail?.menu, "the", "The"),
			text(" order rule on "),
			entityPart(entry.entity, ctx),
			text(
				` moved to ${to ?? "the first column with that value"}. CommCare gives an order rule to the first column with that value. Downloaded apps and Preview now order as apps installed from CommCare HQ do.`,
			),
		]);
	},
	/* The entity is the menu whose tile list holds a filled cell. */
	"tile-cell-defaults-set": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			entityPart(entry.entity, ctx),
			text(
				": each tile cell now states its size and alignment. On Android, tile text is slightly smaller and an image sits at the start of its cell, not its centre. In Web Apps, tile text is larger: it no longer follows the list's size. In a right-to-left language, text that followed the reading direction now aligns left.",
			),
		]),
	/* `detail.saved` and `detail.incomplete`: the app's two settings after the
	 * cutover, each "on" or "off". */
	"android-form-lists-setting-stored": (entry: DocumentNoticeEntry) => {
		const saved = onOff(entry.detail?.saved);
		const incomplete = onOff(entry.detail?.incomplete);
		const values =
			saved === undefined || incomplete === undefined
				? ""
				: `: saved forms ${saved}, incomplete forms ${incomplete}`;
		return noticeLine([
			text(
				`This app now states whether workers see saved forms and incomplete forms on their home screen${values}. Android reads both settings, and Web Apps reads the incomplete forms one. Nova kept each list on wherever a project space of this app shows it today. They are yours to change in App settings.`,
			),
		]);
	},
	/* The entity is the question; `detail.form` its form's name and
	 * `detail.kind` its kind, `barcode` or `secret`. */
	"validation-now-enforced": (entry: DocumentNoticeEntry, ctx) => {
		const form = entry.detail?.form;
		const kind = entry.detail?.kind;
		const noun =
			kind === "barcode" || kind === "secret"
				? `this ${kind} question`
				: "this question";
		return noticeLine([
			...(form === undefined ? [] : [text(`${form}, `)]),
			entityPart(entry.entity, ctx),
			text(
				`: its validation now runs on ${noun}. Workers see its message when an answer doesn't pass.`,
			),
		]);
	},
	/* The entity is a follow-up form that writes nothing to its case. */
	"follow-up-now-touches-case": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			entityPart(entry.entity, ctx),
			text(
				": submitting it now updates its case's last-modified date, even when nothing changes. Case update rules and data forwarding in CommCare HQ see that.",
			),
		]),
	/* The entity is the follow-up form a link opens; `detail.source` names the
	 * form that holds the link. */
	"linked-follow-up-now-writes-case": (entry: DocumentNoticeEntry, ctx) => {
		const source = entry.detail?.source;
		return noticeLine([
			entityPart(entry.entity, ctx),
			text(
				`, when ${source ?? "another form"} opens it: submitting it now updates the case that link names. If the link's case value is empty, Android can't save the form, and if it names no case, CommCare HQ creates one. The value is yours to change in ${source === undefined ? "that form's" : `${source}'s`} link.`,
			),
		]);
	},
	/* The entity is the close form whose condition HQ's tab cannot state. */
	"close-moves-to-save-to-case": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			entityPart(entry.entity, ctx),
			text(
				": its close is now written as a case change in the form. CommCare HQ shows no close on its Case Management tab, and the next publish asks about one more plan feature.",
			),
		]),
	/* The entity is the lookup-backed Search question; `detail.menu` names
	 * its module. */
	"lookup-choices-order-changes": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			...menuBeside(entry.detail?.menu),
			entityPart(entry.entity, ctx),
			text(
				": its choices are now listed by label, not in the table's row order.",
			),
		]),
	/* The entity is the survey-only module; `detail.caseType` is its case
	 * type. */
	"survey-menu-takes-case-type": (entry: DocumentNoticeEntry, ctx) => {
		const caseType = entry.detail?.caseType;
		return noticeLine([
			entityPart(entry.entity, ctx),
			text(
				caseType === undefined
					? ": CommCare HQ shows this module's case type from the next publish."
					: `: CommCare HQ shows this module's case type, ${caseType}, from the next publish.`,
			),
		]);
	},
	/* The entity is the menu; `detail.cause` is the first of `id-mapping`,
	 * `image-map`, `interval`, `option-label` and `unsorted` that holds for
	 * the field the list's first rule lands on, `detail.column` names that
	 * field for the first four, and `detail.kind` is its column kind. */
	"case-list-order-changes": (entry: DocumentNoticeEntry, ctx) => {
		const menu = entityPart(entry.entity, ctx);
		const column = entry.detail?.column ?? "its first column";
		switch (entry.detail?.cause) {
			case "id-mapping":
				return noticeLine([
					menu,
					text(
						`: the list now orders ${column} by the order of its mapping table. Apps installed from CommCare HQ ordered it by label, and downloaded apps and Preview by the stored value. Where fuzzy search is on, a near miss of a label no longer finds its case in apps installed from CommCare HQ.`,
					),
				]);
			case "image-map":
				return noticeLine([
					menu,
					text(
						`: downloaded apps and Preview now order ${column} by the order of its image table, as apps installed from CommCare HQ already do.`,
					),
				]);
			case "interval":
				return noticeLine([
					menu,
					text(
						`: downloaded apps and Preview now order ${column} by the text it shows, not by its date, as apps installed from CommCare HQ already do.`,
					),
				]);
			case "option-label":
				return noticeLine([
					menu,
					text(
						`: downloaded apps and Preview now order ${column} by its labels, not by the stored values, as apps installed from CommCare HQ already do.`,
					),
				]);
			default:
				return noticeLine([
					menu,
					text(
						`: with no order rule, Preview now lists cases by the first column, as devices do.${
							entry.detail?.kind === "date"
								? " Downloaded apps now order that column by date, not by the text it shows."
								: ""
						}`,
					),
				]);
		}
	},
	/* The entity is the menu whose list has no tile layout and holds a
	 * column hidden from Results. */
	"case-list-search-matches-hidden-fields": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			entityPart(entry.entity, ctx),
			text(
				": the list's search now also matches the fields hidden from Results.",
			),
		]),
	/* The entity is the column hidden from Results that carries an order
	 * rule; `detail.menu` names its menu. */
	"hidden-order-column-not-in-sort-menu": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			...menuLead(
				entry.detail?.menu,
				"Android's Sort menu",
				"Android's Sort menu",
			),
			text(" no longer offers "),
			entityPart(entry.entity, ctx),
			text(
				" in a downloaded app, because the column is hidden. The list's own order still follows it.",
			),
		]),
	/* The entity is the column over `case_id`; `detail.menu` names its menu
	 * and `detail.kind` is `plain`, `phone` or `image-map`. */
	"record-id-column-now-shows": (entry: DocumentNoticeEntry, ctx) =>
		noticeLine([
			...menuBeside(entry.detail?.menu),
			entityPart(entry.entity, ctx),
			text(
				`: this column was blank in apps installed from CommCare HQ. After the next publish it shows ${
					entry.detail?.kind === "image-map"
						? "the image mapped to each case's ID"
						: "each case's ID"
				}.`,
			),
		]),
	"local-archive-changes": () =>
		noticeLine([
			text(
				"A CommCare file downloaded from Nova now needs CommCare 2.57 or later.",
			),
		]),
	/* The entity is the form; `detail.question` names the question its case
	 * name comes from. */
	"case-name-now-checked": (entry: DocumentNoticeEntry, ctx) => {
		const question = entry.detail?.question;
		return noticeLine([
			entityPart(entry.entity, ctx),
			text(
				`: workers now see a message when the case name from ${question ?? "its question"} is blank or longer than 255 characters. CommCare can't save a case with a name like that.`,
			),
		]);
	},
	"unsaved-assistant-work-discarded": () =>
		noticeLine([
			text(
				"Changes the assistant was still working on here were not saved before this update. The saved app is unchanged. Ask again to pick the work back up.",
			),
		]),
	"ccz-needs-project-space": () =>
		noticeLine([
			text(
				"A CCZ of this app can be downloaded once the app is published to a project space. A CCZ downloaded earlier named no CommCare HQ server, so a phone that holds one cannot sign in or send forms with it.",
			),
		]),
	"hq-app-deleted": (entry) =>
		noticeLine([
			text(
				`The app Nova made on ${projectSpace(entry)} was deleted in CommCare HQ, so the next publish there makes a new app in its place. If it was deleted by mistake, you can restore it in CommCare HQ and then choose Check status for ${projectSpace(entry)}, and the next publish updates it again.`,
			),
		]),
	"hq-app-not-nova-made": (entry) =>
		noticeLine([
			text(
				`The app on ${projectSpace(entry)} is a linked app in CommCare HQ, so Nova can't publish to it there. You can publish to another project space.`,
			),
		]),
	"ids-change-once-unreadable": (entry) =>
		noticeLine([
			text(
				`Nova couldn't read the app on ${projectSpace(entry)} during this update, so the next publish there asks before it writes over that copy. Once you confirm, every menu and form of the app there gets a new ID in CommCare HQ, once. Forms submitted before then stay under each form's earlier ID in CommCare HQ. If an SMS keyword or a scheduled message opens one of its forms, you can point it at the form again in CommCare HQ once you release a build made after that publish.`,
			),
		]),
	"menu-id-changes-once": (entry: DeploymentNoticeEntry, ctx) => {
		const entities = entry.entities ?? [];
		const formAmong = entities.some((entity) => entity.type === "form");
		return noticeLine([
			text(
				`At the next publish to ${projectSpace(entry)}, CommCare HQ gets new IDs for `,
			),
			...entityList(entities, ctx),
			text(
				`, once, because Nova couldn't match them to what that project space holds.${
					formAmong
						? ` Forms submitted before then stay under each form's earlier ID in CommCare HQ. ${FORM_ID_REPOINT}`
						: ""
				}`,
			),
		]);
	},
	"form-ids-change-once": (entry: DeploymentNoticeEntry, ctx) =>
		noticeLine([
			text(
				`At the next publish to ${projectSpace(entry)}, the CommCare HQ IDs of `,
			),
			...entityList(entry.entities ?? [], ctx),
			text(
				` change once, because Nova couldn't read the ones that project space holds. Their submissions stay together. ${FORM_ID_REPOINT}`,
			),
		]),
	"data-paths-move-once": (entry) =>
		noticeLine([
			text(
				`The next publish to ${projectSpace(entry)} moves the form data that Nova adds to each form to new names, once. Form exports in CommCare HQ show those columns under the new names from then on.`,
			),
		]),
	"deep-links-need-republish": (entry) =>
		noticeLine([
			text(
				`Links to ${projectSpace(entry)} that you already shared keep working. New ones are ready after the next publish there.`,
			),
		]),
	"next-publish-overwrites-hq-edits": (entry) =>
		noticeLine([
			text(
				`The next publish to ${projectSpace(entry)} replaces any change made to this app in CommCare HQ before this update, without asking. For a change made there after this update, Nova asks first.`,
			),
		]),
	"next-publish-asks-before-overwriting": (
		entry: DeploymentNoticeEntry,
		ctx,
	) => {
		const entities = entry.entities ?? [];
		/* No entities: the app's own baseline is the one Nova couldn't read. */
		if (entities.length === 0) {
			return noticeLine([
				text(
					`Nova couldn't read this app on ${projectSpace(entry)}, so the next publish there asks before it writes over what CommCare HQ holds.`,
				),
			]);
		}
		return noticeLine([
			text("Nova couldn't read "),
			...entityList(entities, ctx),
			text(
				` on ${projectSpace(entry)}, so the next publish there asks before it writes over them.`,
			),
		]);
	},
	/* `detail.planFeatures` holds the plan feature ids, `detail.settings`
	 * `flat-location-fixture` and `connect-forwarder` where each is asked,
	 * and `detail.capabilities` the capability ids the probe newly checks,
	 * each comma-joined and absent where empty. Each is named in today's
	 * words, in the order every surface lists them; an id Nova no longer
	 * knows is left out. */
	"next-publish-asks-more": (entry: DeploymentNoticeEntry) => {
		const space = projectSpace(entry);
		const planFeatures = new Set(
			detailIds(entry.detail?.planFeatures).filter(isPlanFeatureId),
		);
		const settings = detailIds(entry.detail?.settings);
		const fixture = settings.includes("flat-location-fixture");
		const forwarder = settings.includes("connect-forwarder");
		const capabilities = detailIds(entry.detail?.capabilities).filter(
			isCapabilityId,
		);
		const labels = [
			...PLAN_FEATURE_IDS.filter((id) => planFeatures.has(id)).map(
				(id) => PLAN_FEATURES[id].label,
			),
			...(fixture ? ["the flat location list"] : []),
			...(forwarder ? ["a Connect forwarder"] : []),
			...capabilities.map((id) => PROJECT_SPACE_CAPABILITIES[id].label),
		];
		const sentences = [
			labels.length === 0
				? `The next publish to ${space} asks you to confirm what the project space has.`
				: `The next publish to ${space} asks you to confirm what the project space has: ${joinedNames(labels)}.`,
			...(fixture
				? [
						`Phones and Web Apps both take the location list by ${possessive(space)} own setting from then on, so Nova asks whether it still sends it. Until that publish, phones get the list whatever that setting says, so places working on phones today don't show that it's on. It's on unless someone turned it off in the project space's Location Fixture settings.`,
					]
				: []),
			...(forwarder
				? [
						`This app's forms reach CommCare Connect only through CommCare HQ's data forwarding, so Nova asks whether ${space} has Data Forwarding and a Connect forwarder.`,
					]
				: []),
		];
		return noticeLine([text(sentences.join(" "))]);
	},
	/* `detail.version` is the CommCare version the cutover's read of the app
	 * there gave, as CommCare HQ spells it. */
	"commcare-version-below-floor": (entry: DeploymentNoticeEntry) => {
		const space = projectSpace(entry);
		const version = entry.detail?.version;
		const setTo =
			version === undefined
				? `The app on ${space} is set to an older CommCare version`
				: `The app on ${space} is set to CommCare ${version}`;
		return noticeLine([
			text(
				`${setTo}, and Nova's apps now need ${COMMCARE_VERSION_FLOOR_TEXT} or later. The next publish there waits until you raise its CommCare version in that app's settings in CommCare HQ. Phones on an older CommCare can no longer install or update the app after that. Saving that page also sets the app's other settings there, so the publish after it first shows you what changed.`,
			),
		]);
	},
	"logo-upload-in-hq": (entry) =>
		noticeLine([
			text(
				`From the next publish to ${projectSpace(entry)}, Nova doesn't send this app's logo with it. Apps built on CommCare HQ show the logo once it is added in that app's settings there; until then they carry none, and Web Apps shows its own icon. After that publish, Nova offers the logo to download.`,
			),
		]),
	/* `detail.setting` is `saved` or `incomplete`, and `detail.readers` the
	 * readers that gain the list there: `android`, or `android-and-webapps`.
	 * Every entry is a list workers gain; none turns one off. */
	"setting-changes-at-next-publish": (entry: DeploymentNoticeEntry) => {
		const space = projectSpace(entry);
		const turnOff = "You can turn them off in App settings.";
		if (entry.detail?.setting === "saved") {
			return noticeLine([
				text(
					`Workers on ${space} will see saved forms on Android after the next publish there. They don't today, and another project space of this app shows them. ${turnOff}`,
				),
			]);
		}
		if (entry.detail?.readers === "android") {
			return noticeLine([
				text(
					`Workers on ${space} will see incomplete forms on Android after the next publish there, as they already do in Web Apps. ${turnOff}`,
				),
			]);
		}
		return noticeLine([
			text(
				`Workers on ${space} will see incomplete forms on Android and in Web Apps after the next publish there. They don't today, and another project space of this app shows them. ${turnOff}`,
			),
		]);
	},
	"settings-unknown-unreadable": (entry) =>
		noticeLine([
			text(
				`Nova couldn't read ${projectSpace(entry)}, so it could not tell whether workers see saved and incomplete forms there. The next publish there sets them to this app's settings. They are yours to change in App settings.`,
			),
		]),
	"worker-settings-reset-at-next-publish": (entry) =>
		noticeLine([
			text(
				`After the next publish to ${projectSpace(entry)}, each app update resets three of a worker's own settings: fuzzy search, automatic updates and text to speech.`,
			),
		]),
} satisfies {
	readonly [R in MigrationNoticeReason]: (
		entry: Extract<MigrationNoticeEntry, { reason: R }>,
		ctx: NoticeRenderContext,
	) => NoticeLine;
};

type AnyRenderer = (
	entry: MigrationNoticeEntry,
	ctx: NoticeRenderContext,
) => NoticeLine;

/** Render one entry through its reason's renderer. */
export function renderNoticeEntry(
	entry: MigrationNoticeEntry,
	ctx: NoticeRenderContext,
): NoticeLine {
	/* The table above is keyed so each renderer receives exactly its own
	 * reason's entry; the lookup by `entry.reason` keeps that pairing, which
	 * TypeScript cannot follow through an indexed access. */
	const render = MIGRATION_NOTICE_COPY[entry.reason] as AnyRenderer;
	return render(entry, ctx);
}

// ── Dates ────────────────────────────────────────────────────────────────

/** The viewer's locale and time zone. Both default to the runtime's. */
export interface NoticeDateOptions {
	readonly locale?: string;
	readonly timeZone?: string;
}

function dayMonthFormat(options: NoticeDateOptions): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat(options.locale, {
		day: "numeric",
		month: "long",
		timeZone: options.timeZone,
	});
}

/** A day and month, such as "6 October", in the viewer's locale and zone. */
export function formatNoticeDay(
	at: string | Date,
	options: NoticeDateOptions = {},
): string {
	return dayMonthFormat(options).format(new Date(at));
}

function calendarDay(at: Date, options: NoticeDateOptions) {
	const parts = new Intl.DateTimeFormat("en-US", {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		timeZone: options.timeZone,
	}).formatToParts(at);
	const value = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? "";
	return { year: value("year"), month: value("month"), day: value("day") };
}

/**
 * "on 6 October" when both instants fall on one day in the viewer's zone,
 * else "between 6 and 7 October", or "between 31 October and 1 November"
 * across a month.
 */
export function noticeDaySpan(
	first: string | Date,
	last: string | Date,
	options: NoticeDateOptions = {},
): string {
	const from = new Date(first);
	const to = new Date(last);
	const a = calendarDay(from, options);
	const b = calendarDay(to, options);
	if (a.year === b.year && a.month === b.month && a.day === b.day) {
		return `on ${formatNoticeDay(from, options)}`;
	}
	const format = dayMonthFormat(options);
	if (a.year === b.year && a.month === b.month) {
		/* One month: the later date's own spelling with its day replaced by
		 * both days, so the locale keeps its order ("6 and 7 October",
		 * "October 6 and 7"). */
		const fromDay = format
			.formatToParts(from)
			.find((part) => part.type === "day")?.value;
		const joined = format
			.formatToParts(to)
			.map((part) =>
				part.type === "day" && fromDay !== undefined
					? `${fromDay} and ${part.value}`
					: part.value,
			)
			.join("");
		return `between ${joined}`;
	}
	return `between ${format.format(from)} and ${format.format(to)}`;
}

// ── The dialog, the chip and the Publishing card ─────────────────────────

/**
 * The dialog's lead, one per cutover, each naming the day the notice was
 * written. A cutover that writes notices adds its lead here.
 */
export const MIGRATION_NOTICE_LEADS = {
	"hq-round-trip-emission": (day: string) =>
		`Nova changed how it writes apps for CommCare HQ on ${day}. Here is what that means for this app.`,
} satisfies Readonly<Record<MigrationNoticeCutover, (day: string) => string>>;

export function noticeLead(
	cutover: MigrationNoticeCutover,
	createdAt: string,
	options: NoticeDateOptions = {},
): string {
	return MIGRATION_NOTICE_LEADS[cutover](formatNoticeDay(createdAt, options));
}

export const NOTICE_DIALOG_TITLE = "What changed in this app";
export const NOTICE_DIALOG_BUTTON = "Got it";
export const PUBLISHING_CARD_NOTICE_LEAD =
	"The next publish here does a few things once.";

/** The builder chip, counting notices. */
export function noticeChipLabel(count: number): string {
	return count === 1 ? "1 update to review" : `${count} updates to review`;
}

/** The heading over one project space's lines in the dialog. */
export function projectSpaceGroupHeading(domain: string): string {
	return `At the next publish to ${domain}`;
}

/** What `dismiss_app_notice` answers once it has dismissed. */
export const MCP_NOTICE_DISMISSED =
	"Dismissed for you. Other members still see it.";

// ── The home page's line ────────────────────────────────────────────────

/**
 * The home page's one line for a member whose own saved key a cutover sent
 * to CommCare HQ. It names the project spaces and never an app. The span is
 * the least first use and the greatest last use of the rows shown.
 */
export function keyReaderNoticeLine(
	rows: readonly KeyReaderNotice[],
	options: NoticeDateOptions = {},
): string {
	const first = rows[0];
	if (first === undefined) {
		throw new Error(
			"The saved-key line needs at least one project space to name.",
		);
	}
	const spaces = new Set(rows.map((row) => `${row.server}\u0000${row.domain}`));
	const firstUsedAt = rows
		.map((row) => row.firstUsedAt)
		.reduce((least, at) => (Date.parse(at) < Date.parse(least) ? at : least));
	const lastUsedAt = rows
		.map((row) => row.lastUsedAt)
		.reduce((greatest, at) =>
			Date.parse(at) > Date.parse(greatest) ? at : greatest,
		);
	const when = noticeDaySpan(firstUsedAt, lastUsedAt, options);
	const more = spaces.size - 1;
	if (more === 0) {
		return `Nova read ${first.domain} on CommCare HQ with your saved key ${when}, to keep its apps' IDs steady through an update.`;
	}
	const others =
		more === 1 ? "1 more project space" : `${more} more project spaces`;
	return `Nova read ${first.domain} and ${others} on CommCare HQ with your saved key ${when}, to keep their apps' IDs steady through an update.`;
}
