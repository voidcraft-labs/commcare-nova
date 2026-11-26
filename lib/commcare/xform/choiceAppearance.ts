import type { ChoiceLayout } from "@/lib/domain/choicePresentation";

const namedLayout = {
	dropdown: "minimal",
	row: "list",
	"row-without-label": "list-nolabel",
	headings: "label",
	buttons: "button-select",
	"advance-on-choice": "quick",
} as const;

/** Only a final compact count is an Android fixed grid. The Android-only
 * combobox matching recipes put the mode before the widget so Web Apps'
 * second literal-space-delimited word leaves its search at the default. */
type PlatformLayout = Extract<ChoiceLayout, { kind: "platforms" }>;
function platformLayoutWords({ web, android }: PlatformLayout): string {
	const words: string[] = [];
	// The Web Apps match rule is the second word. Android checks substrings,
	// and takes a fixed grid count only at the very end of the full string.
	if (web.kind === "search") {
		words.push("combobox");
		if (web.matchWords) words.push(web.matchWords);
	} else if (web.kind !== "ordinary") words.push(namedLayout[web.kind]);
	if (android.kind === "search") {
		if (web.kind !== "search") words.push("combobox");
		if (
			android.matchWords &&
			android.matchWords !== (web.kind === "search" && web.matchWords)
		) {
			if (web.kind === "search" && !web.matchWords)
				words.unshift(android.matchWords);
			else words.push(android.matchWords);
		}
	}
	if (android.kind === "grid") words.push(writeChoiceLayout(android));
	if (
		android.kind === "ordinary" &&
		["minimal", "label", "list-nolabel"].includes(words.join(" "))
	)
		words.push("list");
	return words.join(" ");
}
export function writeChoiceLayout(layout: ChoiceLayout): string {
	switch (layout.kind) {
		case "platforms":
			return platformLayoutWords(layout);
		case "grid": {
			const grid =
				layout.columns === undefined ? "compact" : `compact-${layout.columns}`;
			return layout.advanceOnChoice ? `quick ${grid}` : grid;
		}
		case "search":
			switch (layout.matchWords) {
				case "android-fuzzy":
					return "fuzzy combobox";
				case "android-multiword":
					return "multiword combobox";
				case undefined:
					return "combobox";
				default:
					return `combobox ${layout.matchWords}`;
			}
		default:
			return namedLayout[layout.kind];
	}
}

/** Recognizes just the simple palette choices and their equivalent spellings.
 * A composition that changes another aspect of a control needs its own
 * complete decoder. Never consume the rest as if it were inert. */
export function readChoiceLayout(
	value: string,
	single: boolean,
): ChoiceLayout | undefined {
	for (const [kind, spelling] of Object.entries(namedLayout))
		if (
			value === spelling &&
			(single || (kind !== "buttons" && kind !== "advance-on-choice"))
		)
			return { kind: kind as keyof typeof namedLayout };
	if (single && value === "combobox") return { kind: "search" };
	if (single) {
		for (const mode of ["multiword", "fuzzy"] as const) {
			if (value === `combobox ${mode}`)
				return { kind: "search", matchWords: mode };
			if (value === `${mode} combobox`)
				return { kind: "search", matchWords: `android-${mode}` };
		}
	}
	const grid = /^(quick )?compact(?:-([0-9]+))?( quick)?$/.exec(value);
	if (!grid || (grid[1] && grid[3]) || (!single && (grid[1] || grid[3])))
		return undefined;
	const parsed = grid[2] === undefined || grid[3] ? NaN : Number(grid[2]);
	return {
		kind: "grid",
		...(Number.isInteger(parsed) &&
			parsed > 0 &&
			parsed <= 2_147_483_647 && { columns: parsed }),
		...((grid[1] || grid[3]) && { advanceOnChoice: true }),
	};
}
