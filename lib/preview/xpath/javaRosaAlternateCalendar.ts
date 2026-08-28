import { parseCommCareDatePattern } from "@/lib/domain/commCareDatePattern";
import {
	classicWideningTarget,
	iso6391CodeForSet3,
} from "@/lib/domain/languageRegistry/classicRuntime";
import type { XPathDate } from "./types";

/** Pinned from CommCare Android's locale arrays at 79d8418ab2dcd984. */
const ETHIOPIAN_MONTHS: Readonly<Record<string, readonly string[]>> = {
	default: [
		"Mäskäräm",
		"T’ïk’ïmt",
		"Hïdar",
		"Tahsas",
		"T’ïr",
		"Yäkatit",
		"Mägabit",
		"Miyaziya",
		"Gïnbot",
		"Säne",
		"Hämle",
		"Nähäse",
		"P’agume",
	],
	am: [
		"መስከረም",
		"ጥቅምት",
		"ኅዳር",
		"ታኅሣሥ",
		"ጥር",
		"የካቲት",
		"መጋቢት",
		"ሚያዝያ",
		"ግንቦት",
		"ሰኔ",
		"ሐምሌ",
		"ነሐሴ",
		"ጳጐሜን",
	],
	es: [
		"Meskerem",
		"Tikimt",
		"Hidar",
		"Tahsas",
		"Tir",
		"Yekatit",
		"Megabit",
		"Miazia",
		"Ginbot",
		"Senie",
		"Hamlie",
		"Nehasie",
		"Pagumien",
	],
	fr: [
		"Meskerem",
		"Tikimt",
		"Hidar",
		"Tahsas",
		"Tir",
		"Yekatit",
		"Megabit",
		"Miazia",
		"Ginbot",
		"Senie",
		"Hamlie",
		"Nehasie",
		"Pagumien",
	],
	lt: [
		"Meskerem",
		"Tikimt",
		"Hidar",
		"Tahsas",
		"Tir",
		"Yekatit",
		"Megabit",
		"Miazia",
		"Ginbot",
		"Senie",
		"Hamlie",
		"Nehasie",
		"Pagumien",
	],
	no: [
		"Meskerem",
		"Tikimt",
		"Hidar",
		"Tahsas",
		"Tir",
		"Yekatit",
		"Megabit",
		"Miazia",
		"Ginbot",
		"Senie",
		"Hamlie",
		"Nehasie",
		"Pagumien",
	],
	pt: [
		"Meskerem",
		"Tikimt",
		"Hidar",
		"Tahsas",
		"Tir",
		"Yekatit",
		"Megabit",
		"Miazia",
		"Ginbot",
		"Senie",
		"Hamlie",
		"Nehasie",
		"Pagumien",
	],
	sw: [
		"Meskerem",
		"Tikimt",
		"Hidar",
		"Tahsas",
		"Tir",
		"Yekatit",
		"Megabit",
		"Miazia",
		"Ginbot",
		"Senie",
		"Hamlie",
		"Nehasie",
		"Pagumien",
	],
	ti: [
		"መስከረም",
		"ጥቅምቲ",
		"ሕዳር",
		"ታኅሳስ",
		"ጥሪ",
		"ለካቲት",
		"መጋቢት",
		"ምያዝያ",
		"ግንቦት",
		"ሰነ",
		"ሓምለ",
		"ነሓሰ",
		"ጳጐሜን",
	],
};

const NEPALI_MONTHS: Readonly<Record<string, readonly string[]>> = {
	default: [
		"Baishakh",
		"Jestha",
		"Ashadh",
		"Shrawan",
		"Bhadra",
		"Ashwin",
		"Kartik",
		"Mangsir",
		"Poush",
		"Magh",
		"Falgun",
		"Chaitra",
	],
	ne: [
		"बैशाख",
		"जेष्ठ",
		"आषाढ",
		"श्रावण",
		"भाद्र",
		"आश्विन",
		"कार्तिक",
		"मार्ग",
		"पौष",
		"माघ",
		"फाल्गुन",
		"चैत्र",
	],
};

/**
 * Core's complete 1970-2090 Bikram Sambat month table, compacted without
 * changing a value (commcare-core CalendarUtils at 8e9ba8d).
 */
const NEPALI_YEAR_DATA = `1970:31,31,32,31,31,31,30,29,30,29,30,30;1971:31,31,32,31,32,30,30,29,30,29,30,30;1972:31,32,31,32,31,30,30,30,29,29,30,30;1973:30,32,31,32,31,30,30,30,29,30,29,31;1974:31,31,32,30,31,31,30,29,30,29,30,30;1975:31,31,32,32,30,31,30,29,30,29,30,30;1976:31,32,31,32,31,30,30,30,29,29,30,31;1977:31,32,31,32,31,31,29,30,29,30,29,31;1978:31,31,32,31,31,31,30,29,30,29,30,30;1979:31,31,32,32,31,30,30,29,30,29,30,30;1980:31,32,31,32,31,30,30,30,29,29,30,31;1981:31,31,31,32,31,31,29,30,30,29,30,30;1982:31,31,32,31,31,31,30,29,30,29,30,30;1983:31,31,32,32,31,30,30,29,30,29,30,30;1984:31,32,31,32,31,30,30,30,29,29,30,31;1985:31,31,31,32,31,31,29,30,30,29,30,30;1986:31,31,32,31,31,31,30,29,30,29,30,30;1987:31,32,31,32,31,30,30,29,30,29,30,30;1988:31,32,31,32,31,30,30,30,29,29,30,31;1989:31,31,31,32,31,31,30,29,30,29,30,30;1990:31,31,32,31,31,31,30,29,30,29,30,30;1991:31,32,31,32,31,30,30,29,30,29,30,30;1992:31,32,31,32,31,30,30,30,29,30,29,31;1993:31,31,31,32,31,31,30,29,30,29,30,30;1994:31,31,32,31,31,31,30,29,30,29,30,30;1995:31,32,31,32,31,30,30,30,29,29,30,30;1996:31,32,31,32,31,30,30,30,29,30,29,31;1997:31,31,32,31,31,31,30,29,30,29,30,30;1998:31,31,32,31,31,31,30,29,30,29,30,30;1999:31,32,31,32,31,30,30,30,29,29,30,31;2000:30,32,31,32,31,30,30,30,29,30,29,31;2001:31,31,32,31,31,31,30,29,30,29,30,30;2002:31,31,32,32,31,30,30,29,30,29,30,30;2003:31,32,31,32,31,30,30,30,29,29,30,31;2004:30,32,31,32,31,30,30,30,29,30,29,31;2005:31,31,32,31,31,31,30,29,30,29,30,30;2006:31,31,32,32,31,30,30,29,30,29,30,30;2007:31,32,31,32,31,30,30,30,29,29,30,31;2008:31,31,31,32,31,31,29,30,30,29,29,31;2009:31,31,32,31,31,31,30,29,30,29,30,30;2010:31,31,32,32,31,30,30,29,30,29,30,30;2011:31,32,31,32,31,30,30,30,29,29,30,31;2012:31,31,31,32,31,31,29,30,30,29,30,30;2013:31,31,32,31,31,31,30,29,30,29,30,30;2014:31,31,32,32,31,30,30,29,30,29,30,30;2015:31,32,31,32,31,30,30,30,29,29,30,31;2016:31,31,31,32,31,31,29,30,30,29,30,30;2017:31,31,32,31,31,31,30,29,30,29,30,30;2018:31,32,31,32,31,30,30,29,30,29,30,30;2019:31,32,31,32,31,30,30,30,29,30,29,31;2020:31,31,31,32,31,31,30,29,30,29,30,30;2021:31,31,32,31,31,31,30,29,30,29,30,30;2022:31,32,31,32,31,30,30,30,29,29,30,30;2023:31,32,31,32,31,30,30,30,29,30,29,31;2024:31,31,31,32,31,31,30,29,30,29,30,30;2025:31,31,32,31,31,31,30,29,30,29,30,30;2026:31,32,31,32,31,30,30,30,29,29,30,31;2027:30,32,31,32,31,30,30,30,29,30,29,31;2028:31,31,32,31,31,31,30,29,30,29,30,30;2029:31,31,32,31,32,30,30,29,30,29,30,30;2030:31,32,31,32,31,30,30,30,29,29,30,31;2031:30,32,31,32,31,30,30,30,29,30,29,31;2032:31,31,32,31,31,31,30,29,30,29,30,30;2033:31,31,32,32,31,30,30,29,30,29,30,30;2034:31,32,31,32,31,30,30,30,29,29,30,31;2035:30,32,31,32,31,31,29,30,30,29,29,31;2036:31,31,32,31,31,31,30,29,30,29,30,30;2037:31,31,32,32,31,30,30,29,30,29,30,30;2038:31,32,31,32,31,30,30,30,29,29,30,31;2039:31,31,31,32,31,31,29,30,30,29,30,30;2040:31,31,32,31,31,31,30,29,30,29,30,30;2041:31,31,32,32,31,30,30,29,30,29,30,30;2042:31,32,31,32,31,30,30,30,29,29,30,31;2043:31,31,31,32,31,31,29,30,30,29,30,30;2044:31,31,32,31,31,31,30,29,30,29,30,30;2045:31,32,31,32,31,30,30,29,30,29,30,30;2046:31,32,31,32,31,30,30,30,29,29,30,31;2047:31,31,31,32,31,31,30,29,30,29,30,30;2048:31,31,32,31,31,31,30,29,30,29,30,30;2049:31,32,31,32,31,30,30,30,29,29,30,30;2050:31,32,31,32,31,30,30,30,29,30,29,31;2051:31,31,31,32,31,31,30,29,30,29,30,30;2052:31,31,32,31,31,31,30,29,30,29,30,30;2053:31,32,31,32,31,30,30,30,29,29,30,30;2054:31,32,31,32,31,30,30,30,29,30,29,31;2055:31,31,32,31,31,31,30,29,30,29,30,30;2056:31,31,32,31,32,30,30,29,30,29,30,30;2057:31,32,31,32,31,30,30,30,29,29,30,31;2058:30,32,31,32,31,30,30,30,29,30,29,31;2059:31,31,32,31,31,31,30,29,30,29,30,30;2060:31,31,32,32,31,30,30,29,30,29,30,30;2061:31,32,31,32,31,30,30,30,29,29,30,31;2062:30,32,31,32,31,31,29,30,29,30,29,31;2063:31,31,32,31,31,31,30,29,30,29,30,30;2064:31,31,32,32,31,30,30,29,30,29,30,30;2065:31,32,31,32,31,30,30,30,29,29,30,31;2066:31,31,31,32,31,31,29,30,30,29,29,31;2067:31,31,32,31,31,31,30,29,30,29,30,30;2068:31,31,32,32,31,30,30,29,30,29,30,30;2069:31,32,31,32,31,30,30,30,29,29,30,31;2070:31,31,31,32,31,31,29,30,30,29,30,30;2071:31,31,32,31,31,31,30,29,30,29,30,30;2072:31,32,31,32,31,30,30,29,30,29,30,30;2073:31,32,31,32,31,30,30,30,29,29,30,31;2074:31,31,31,32,31,31,30,29,30,29,30,30;2075:31,31,32,31,31,31,30,29,30,29,30,30;2076:31,32,31,32,31,30,30,30,29,29,30,30;2077:31,32,31,32,31,30,30,30,29,30,29,31;2078:31,31,31,32,31,31,30,29,30,29,30,30;2079:31,31,32,31,31,31,30,29,30,29,30,30;2080:31,32,31,32,31,30,30,30,29,29,30,30;2081:31,32,31,32,31,30,30,30,29,30,29,31;2082:31,31,32,31,31,31,30,29,30,29,30,30;2083:31,31,32,31,31,31,30,29,30,29,30,30;2084:31,32,31,32,31,30,30,30,29,29,30,31;2085:30,32,31,32,31,30,30,30,29,30,29,31;2086:31,31,32,31,31,31,30,29,30,29,30,30;2087:31,31,32,32,31,31,30,29,30,29,30,30;2088:31,32,31,32,31,30,30,30,29,29,30,31;2089:30,32,31,32,31,30,30,30,29,30,29,31;2090:31,31,32,31,31,31,30,29,30,29,30,30`;

interface CalendarDate {
	readonly year: number;
	readonly month: number;
	readonly day: number;
}

const NEPALI_YEARS = new Map<number, readonly number[]>(
	NEPALI_YEAR_DATA.split(";").map((row) => {
		const [year, months] = row.split(":");
		return [Number(year), months.split(",").map(Number)] as const;
	}),
);

const NEPALI_EPOCH_DAY = -daysFromNepaliMinimum(2026, 9, 17);

export function javaRosaFormatDateForCalendar(
	value: XPathDate | null,
	calendar: string,
	format = "%e %B %Y",
	locale = "en",
): string {
	if (value === null) return "";
	const gregorian = gregorianFields(value);
	if (calendar === "ethiopian") {
		return formatCalendarDate(
			toEthiopian(gregorian),
			format,
			localizedMonths(ETHIOPIAN_MONTHS, locale),
		);
	}
	if (calendar === "nepali") {
		return formatCalendarDate(
			toNepali(gregorian),
			format,
			localizedMonths(NEPALI_MONTHS, locale),
		);
	}
	throw new Error(`Unsupported calendar type: ${calendar}`);
}

function gregorianFields(value: XPathDate): CalendarDate {
	const date = value.toJSDate();
	return value.time === null
		? {
				year: date.getUTCFullYear(),
				month: date.getUTCMonth() + 1,
				day: date.getUTCDate(),
			}
		: {
				year: date.getFullYear(),
				month: date.getMonth() + 1,
				day: date.getDate(),
			};
}

function toEthiopian(date: CalendarDate): CalendarDate {
	const julianDay = gregorianJulianDay(date.year, date.month, date.day);
	const year = Math.floor((4 * (julianDay - 1_724_221) + 1463) / 1461);
	const yearStart = ethiopianJulianDay(year, 1, 1);
	const month = 1 + Math.floor((julianDay - yearStart) / 30);
	const day = julianDay - ethiopianJulianDay(year, month, 1) + 1;
	return { year, month, day };
}

function toNepali(date: CalendarDate): CalendarDate {
	// Date.UTC remaps years 0-99 into 1900-1999. Setting the full year after
	// construction preserves Core's actual input year and rejects dates before
	// the pinned Bikram Sambat table instead of formatting a plausible century.
	const utcMidnight = new Date(0);
	utcMidnight.setUTCHours(0, 0, 0, 0);
	utcMidnight.setUTCFullYear(date.year, date.month - 1, date.day);
	const unixDay = Math.floor(utcMidnight.getTime() / 86_400_000);
	let remaining = unixDay - NEPALI_EPOCH_DAY;
	if (remaining < 0) throw new Error("Nepali calendar date is out of bounds.");
	for (let year = 1970; year <= 2090; year += 1) {
		const months = NEPALI_YEARS.get(year);
		if (months === undefined) break;
		for (let month = 1; month <= 12; month += 1) {
			const length = months[month - 1];
			if (remaining < length) return { year, month, day: remaining + 1 };
			remaining -= length;
		}
	}
	throw new Error("Nepali calendar date is out of bounds.");
}

function daysFromNepaliMinimum(
	toYear: number,
	toMonth: number,
	toDay: number,
): number {
	let days = -1;
	for (let year = 1970; year <= toYear; year += 1) {
		const months = NEPALI_YEARS.get(year);
		if (months === undefined) throw new Error("Missing pinned Nepali year.");
		for (let month = 1; month <= 12; month += 1) {
			for (let day = 1; day <= months[month - 1]; day += 1) {
				days += 1;
				if (year === toYear && month === toMonth && day === toDay) return days;
			}
		}
	}
	throw new Error("Nepali calendar date is out of bounds.");
}

function gregorianJulianDay(year: number, month: number, day: number): number {
	const a = Math.floor((14 - month) / 12);
	const y = year + 4800 - a;
	const m = month + 12 * a - 3;
	return (
		day +
		Math.floor((153 * m + 2) / 5) +
		365 * y +
		Math.floor(y / 4) -
		Math.floor(y / 100) +
		Math.floor(y / 400) -
		32045
	);
}

function ethiopianJulianDay(year: number, month: number, day: number): number {
	return (
		1_724_221 +
		365 * (year - 1) +
		Math.floor(year / 4) +
		30 * (month - 1) +
		day -
		1
	);
}

function localizedMonths(
	source: Readonly<Record<string, readonly string[]>>,
	locale: string,
): readonly string[] {
	const language = locale.toLowerCase().split(/[-_]/)[0] ?? "";
	// Nova stores canonical ISO 639-3 identities. Classic first widens an
	// individual language where required (for example swh -> swa), while Android
	// resources use the corresponding ISO 639-1 directory (swa -> sw).
	const classicLanguage = classicWideningTarget(language) ?? language;
	const coreLocale = iso6391CodeForSet3(classicLanguage) ?? classicLanguage;
	return source[coreLocale] ?? source.default;
}

function formatCalendarDate(
	date: CalendarDate,
	pattern: string,
	months: readonly string[],
): string {
	const parsed = parseCommCareDatePattern(pattern);
	if (parsed.kind === "unsupported-pattern")
		throw new Error("Unsupported date format pattern.");
	let result = "";
	for (const segment of parsed.segments) {
		if (segment.kind === "literal") {
			result += segment.text;
			continue;
		}
		switch (segment.token) {
			case "%":
				result += "%";
				break;
			case "Y":
				result += String(date.year).padStart(4, "0");
				break;
			case "y":
				result += String(date.year).padStart(4, "0").slice(2);
				break;
			case "m":
				result += String(date.month).padStart(2, "0");
				break;
			case "n":
				result += String(date.month);
				break;
			case "B":
			case "b":
				result += months[date.month - 1];
				break;
			case "d":
				result += String(date.day).padStart(2, "0");
				break;
			case "e":
				result += String(date.day);
				break;
			case "H":
				result += "00";
				break;
			case "h":
				result += "0";
				break;
			case "M":
			case "S":
				result += "00";
				break;
			case "3":
				result += "000";
				break;
			case "w":
				result += "-1";
				break;
			case "Z":
				result += "Z";
				break;
			case "A":
			case "a":
				throw new Error(
					"Day names are unavailable for non-Gregorian calendars.",
				);
		}
	}
	return result;
}
