import fs from "node:fs";

const diagnosticsPath = process.argv[2];
if (!diagnosticsPath) {
	throw new Error("usage: node scripts/codemod-prose-fixtures.mjs <tsc-log>");
}

const diagnostics = fs.readFileSync(diagnosticsPath, "utf8").split(/\r?\n/);
const targetLines = new Map();
for (const diagnostic of diagnostics) {
	const match = diagnostic.match(/^(.+)\((\d+),(\d+)\): error .+$/);
	if (!match) continue;
	if (
		!diagnostic.includes(
			"Type 'string' is not assignable to type '{ parts:",
		) ||
		diagnostic.includes("raw-ref") ||
		diagnostic.includes("path-ref")
	) {
		continue;
	}
	const file = match[1];
	const line = Number(match[2]);
	const lines = targetLines.get(file) ?? new Set();
	lines.add(line);
	targetLines.set(file, lines);
}

function expressionEnd(line, start) {
	let quote = null;
	let escaped = false;
	let parens = 0;
	let brackets = 0;
	let braces = 0;
	for (let index = start; index < line.length; index++) {
		const char = line[index];
		if (quote !== null) {
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") parens++;
		else if (char === ")") parens--;
		else if (char === "[") brackets++;
		else if (char === "]") brackets--;
		else if (char === "{") braces++;
		else if (char === "}") {
			if (parens === 0 && brackets === 0 && braces === 0) return index;
			braces--;
		} else if (
			char === "," &&
			parens === 0 &&
			brackets === 0 &&
			braces === 0
		) {
			return index;
		}
	}
	return line.length;
}

function wrapProseValues(line) {
	const keyPattern = /\b(?:label|hint|help|validate_msg|msg):\s*/g;
	const edits = [];
	for (const match of line.matchAll(keyPattern)) {
		const start = (match.index ?? 0) + match[0].length;
		const end = expressionEnd(line, start);
		const expression = line.slice(start, end).trim();
		if (
			expression.length === 0 ||
			expression.startsWith("proseText(") ||
			expression.startsWith("{ parts:")
		) {
			continue;
		}
		const leading = line.slice(start, end).match(/^\s*/)?.[0] ?? "";
		const trailing = line.slice(start, end).match(/\s*$/)?.[0] ?? "";
		edits.push({
			start,
			end,
			value: `${leading}proseText(${expression})${trailing}`,
		});
	}
	let result = line;
	for (const edit of edits.reverse()) {
		result =
			result.slice(0, edit.start) + edit.value + result.slice(edit.end);
	}
	return result;
}

let changedFiles = 0;
for (const [file, linesToChange] of targetLines) {
	if (!fs.existsSync(file)) continue;
	const lines = fs.readFileSync(file, "utf8").split("\n");
	let changed = false;
	for (const lineNumber of linesToChange) {
		const index = lineNumber - 1;
		const next = wrapProseValues(lines[index] ?? "");
		if (next !== lines[index]) {
			lines[index] = next;
			changed = true;
		}
	}
	if (!changed) continue;
	let source = lines.join("\n");
	if (!source.includes('from "@/lib/domain/prose"')) {
		const firstImport = source.search(/^import /m);
		if (firstImport < 0) {
			throw new Error(`no import insertion point in ${file}`);
		}
		source =
			source.slice(0, firstImport) +
			'import { proseText } from "@/lib/domain/prose";\n' +
			source.slice(firstImport);
	}
	fs.writeFileSync(file, source);
	changedFiles++;
}

console.log(`updated ${changedFiles} files`);
