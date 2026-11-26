import { isValid, parseISO } from "date-fns";

/** Wire-form calendar date accepted by CommCare's daterange encoding. */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isValidCalendarDate(value: string): boolean {
	return ISO_DATE_PATTERN.test(value) && isValid(parseISO(value));
}
