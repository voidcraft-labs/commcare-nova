// HQ's XPath validator (corehq/apps/app_manager/xpath_validator), one
// long-lived process for every expression instead of one node process per
// expression (proof/hq/speed.py::XPathValidator).
//
// It loads HQ's own xpathConfig.js from the validator directory named by its
// one argument, and answers each request line as HQ's xpathValidator.js would
// answer the same bytes on its standard input:
//
// - request: {"text": <base64 of the bytes HQ's wrapper writes to stdin>,
//   "caseHashtags": <whether the wrapper passes --allow-case-hashtags>}
// - answer: {"code": <the script's exit code>, "stdout": <base64 of what it
//   prints>}
//
// The script decodes its input as UTF-8 (Buffer#toString), configures a new
// parser, and parses: on success it exits 0 having printed nothing; when the
// parse throws it prints the error's message with console.log and exits 1.
// An error escaping the script itself (configuring the parser, or reading the
// message of what the parse threw) also exits 1, having printed nothing. Each
// request gets a parser of its own, as each run of the script does.

import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { format } from "node:util";

const validatorDirectory = process.argv[2];
const requireFromValidator = createRequire(
	path.join(validatorDirectory, "xpathValidator.js"),
);
const { configureHashtags } = requireFromValidator("./xpathConfig");

function answer(request) {
	const data = Buffer.from(request.text, "base64").toString();
	let parser;
	try {
		parser = configureHashtags(Boolean(request.caseHashtags));
	} catch {
		return { code: 1, stdout: "" };
	}
	try {
		parser.parse(data);
	} catch (error) {
		let printed;
		try {
			// What console.log(e.message) writes to a pipe.
			printed = `${format(error.message)}\n`;
		} catch {
			return { code: 1, stdout: "" };
		}
		return {
			code: 1,
			stdout: Buffer.from(printed, "utf8").toString("base64"),
		};
	}
	return { code: 0, stdout: "" };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
	process.stdout.write(`${JSON.stringify(answer(JSON.parse(line)))}\n`);
});
