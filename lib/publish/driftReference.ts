/**
 * What a change made in CommCare HQ is measured against, and the day a
 * drift sentence names.
 *
 * Client-safe: the server writes these sentences into a publish's refusal
 * and checks, and the publish dialog writes one of its own, so both read
 * the reference and format the day the same way.
 */

/** What a change in CommCare HQ is measured against. `at` is when the app was brought in. */
export type DriftReference =
	| { readonly kind: "published" }
	| { readonly kind: "brought-in"; readonly at: string }
	/** The baseline is CommCare HQ's source as a bring-in of changes left it. */
	| { readonly kind: "changes-brought-in" };

/** Whose calendar day a drift sentence names. Both default to `DEFAULT_DRIFT_DATE`'s. */
export interface DriftDateOptions {
	readonly locale?: string;
	readonly timeZone?: string;
}

export const DEFAULT_DRIFT_DATE = { locale: "en-GB", timeZone: "UTC" } as const;

/** The locale as given where `Intl` accepts it, else the default's. */
function acceptedLocale(locale: string | undefined): string {
	if (locale === undefined) return DEFAULT_DRIFT_DATE.locale;
	try {
		new Intl.DateTimeFormat(locale);
		return locale;
	} catch {
		return DEFAULT_DRIFT_DATE.locale;
	}
}

/** The time zone as given where `Intl` accepts it, else the default's. */
function acceptedTimeZone(timeZone: string | undefined): string {
	if (timeZone === undefined) return DEFAULT_DRIFT_DATE.timeZone;
	try {
		new Intl.DateTimeFormat(DEFAULT_DRIFT_DATE.locale, { timeZone });
		return timeZone;
	} catch {
		return DEFAULT_DRIFT_DATE.timeZone;
	}
}

/**
 * A day, month and year, such as "10 November 2026". A locale or zone
 * `Intl` refuses reads as the default's.
 */
export function driftDate(at: string, options?: DriftDateOptions): string {
	return new Intl.DateTimeFormat(acceptedLocale(options?.locale), {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: acceptedTimeZone(options?.timeZone),
	}).format(new Date(at));
}

/** The reader's own: `navigator.language` and the browser's resolved time zone. Browser only. */
export function viewerDriftDate(): DriftDateOptions {
	return {
		locale: navigator.language,
		timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
	};
}
