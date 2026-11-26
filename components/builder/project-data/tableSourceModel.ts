/**
 * The state of the two table-source confirmations (`TableSourceActions.tsx`)
 * as pure transitions, so what each dialog shows follows from the answers it
 * took and never from the order the server's answers came back in.
 */

/** A confirmation's reading of the change, as the server answers it. */
export interface TableSourceReview {
	readonly title: string;
	readonly lines: readonly string[];
	readonly reviewDigest: string;
}

/**
 * Use the table from CommCare HQ: the project space chosen, the read in
 * flight (by the project space it asked about), and what the last answer for
 * the chosen project space said.
 */
export interface TakeHqTableState {
	readonly chosen: string | null;
	readonly reading: string | null;
	readonly confirming: boolean;
	readonly review: TableSourceReview | null;
	readonly refusal: string | null;
}

export const TAKE_HQ_TABLE_UNCHOSEN: TakeHqTableState = {
	chosen: null,
	reading: null,
	confirming: false,
	review: null,
	refusal: null,
};

export type TakeHqTableEvent =
	/** The person chose a project space, and its table is read. */
	| { readonly kind: "choose"; readonly key: string }
	/** The answer of a read of `key`'s table. */
	| {
			readonly kind: "read";
			readonly key: string;
			readonly review: TableSourceReview | null;
			readonly refusal: string | null;
	  }
	| { readonly kind: "confirm" }
	/** The confirmation's answer for `key`, with the review read again where it moved. */
	| {
			readonly kind: "confirmed";
			readonly key: string;
			readonly refusal: string;
			readonly review?: TableSourceReview | null;
	  };

export function takeHqTableReducer(
	state: TakeHqTableState,
	event: TakeHqTableEvent,
): TakeHqTableState {
	switch (event.kind) {
		case "choose":
			return {
				chosen: event.key,
				reading: event.key,
				confirming: false,
				review: null,
				refusal: null,
			};
		case "read":
			/* An answer for a project space the person has since moved off says
			 * nothing about the one now chosen. */
			if (event.key !== state.reading) return state;
			return {
				...state,
				reading: null,
				review: event.review,
				refusal: event.refusal,
			};
		case "confirm":
			return { ...state, confirming: true, refusal: null };
		case "confirmed":
			if (event.key !== state.chosen) return { ...state, confirming: false };
			return {
				...state,
				confirming: false,
				refusal: event.refusal,
				...(event.review === undefined ? {} : { review: event.review }),
			};
	}
}

/** Whether the dialog is waiting on the server. */
export function takeHqTableWorking(state: TakeHqTableState): boolean {
	return state.reading !== null || state.confirming;
}

/** What the dialog says under its title before a review is on screen. */
export function takeHqTablePending(
	state: TakeHqTableState,
	choose: string,
): string {
	if (state.chosen === null) return choose;
	if (state.reading !== null) return "Reading the table";
	return "";
}

/**
 * The apps a separate table's confirmation still has chosen once its review
 * is read again: only those the new review lists, since an app that stopped
 * reading the table has no box left to clear, and the server refuses a choice
 * that names it.
 */
export function appsStillListed(
	chosen: readonly string[],
	listed: readonly { readonly appId: string }[],
): readonly string[] {
	const ids = new Set(listed.map((app) => app.appId));
	return chosen.filter((id) => ids.has(id));
}
