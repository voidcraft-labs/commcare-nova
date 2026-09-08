/**
 * A heading outline of a prompt, so a long system prompt reads as a table of
 * contents with a weight per section instead of one wall of text.
 *
 * Sections open at markdown ATX headings (`#` through `######`) and at
 * horizontal rules (`---`), both only outside fenced code blocks: a `#` line
 * inside a fence is code, and the prompts carry fenced examples. Text before
 * the first heading is a section of its own titled by its first line.
 */

export interface OutlineSection {
	/** Stable within one outline: the section's index and a slug of its title. */
	readonly id: string;
	/** 0 for the preamble and rule-separated text, 1..6 for a heading. */
	readonly level: number;
	readonly title: string;
	/** The section's text including its heading line. */
	readonly text: string;
	/** Zero-based line of the heading (or first line) in the source. */
	readonly line: number;
}

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t#]*$/;
const RULE = /^[ \t]{0,3}(-{3,}|\*{3,}|_{3,})[ \t]*$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function slug(title: string): string {
	const base = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return base.length > 0 ? base : "section";
}

function firstLineTitle(text: string): string {
	const first = text.split("\n").find((line) => line.trim().length > 0) ?? "";
	const trimmed = first.trim();
	return trimmed.length > 72 ? `${trimmed.slice(0, 71)}…` : trimmed;
}

/** Splits `text` into heading-delimited sections, fence-aware. */
export function outlineText(text: string): readonly OutlineSection[] {
	const lines = text.split("\n");
	const sections: OutlineSection[] = [];
	let openFence: string | null = null;
	let current: {
		level: number;
		title: string | null;
		line: number;
		lines: string[];
	} | null = null;

	const close = () => {
		if (!current) return;
		const body = current.lines.join("\n");
		if (body.trim().length === 0) {
			current = null;
			return;
		}
		const title = current.title ?? firstLineTitle(body);
		sections.push({
			id: `${sections.length}-${slug(title)}`,
			level: current.level,
			title,
			text: body,
			line: current.line,
		});
		current = null;
	};

	lines.forEach((line, index) => {
		const fence = FENCE.exec(line);
		if (fence) {
			const marker = fence[1] ?? "";
			if (openFence === null) {
				openFence = marker;
			} else if (
				marker[0] === openFence[0] &&
				marker.length >= openFence.length
			) {
				openFence = null;
			}
			current ??= { level: 0, title: null, line: index, lines: [] };
			current.lines.push(line);
			return;
		}
		if (openFence === null) {
			const heading = HEADING.exec(line);
			if (heading) {
				close();
				current = {
					level: (heading[1] ?? "#").length,
					title: (heading[2] ?? "").trim(),
					line: index,
					lines: [line],
				};
				return;
			}
			if (RULE.test(line)) {
				close();
				current = { level: 0, title: null, line: index + 1, lines: [] };
				return;
			}
		}
		current ??= { level: 0, title: null, line: index, lines: [] };
		current.lines.push(line);
	});
	close();
	return sections;
}
