/** Java String.trim(): remove only leading/trailing UTF-16 code units <= U+0020. */
export function javaTrim(value: string): string {
	let start = 0;
	let end = value.length;
	while (start < end && value.charCodeAt(start) <= 0x20) start += 1;
	while (end > start && value.charCodeAt(end - 1) <= 0x20) end -= 1;
	return value.slice(start, end);
}

/** CommCare Core DataUtil.splitOnSpaces(): split only U+0020 runs, preserve a
 * leading empty item, and discard the trailing empty items Java String.split
 * removes with its default limit. */
export function javaRosaSplitOnSpaces(value: string): string[] {
	if (value === "") return [];
	const values = value.split(/ +/);
	while (values.at(-1) === "") values.pop();
	return values;
}
