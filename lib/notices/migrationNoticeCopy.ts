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

/** What a form's new id means for what HQ already holds that names it. */
const FORM_ID_REPOINT =
	"If an SMS keyword or a scheduled message opens one of these forms, you can point it at the form again in CommCare HQ once you release a build made after that publish.";

export const MIGRATION_NOTICE_COPY = {
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
	"local-archive-changes": () =>
		noticeLine([
			text(
				"A CommCare file downloaded from Nova now needs CommCare 2.57 or later.",
			),
		]),
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
