import { writeFileSync } from "node:fs";
import { it } from "vitest";
import { noMatchesWireFixture } from "@/lib/commcare/__tests__/noMatchesWireFixture";
import { expandDoc } from "@/lib/commcare/expander";

it("emits", () => {
	const hq = expandDoc(noMatchesWireFixture("basic"));
	writeFileSync(
		"/private/tmp/claude-501/-Users-braxtonperry-work-personal-code-commcare-nova/f6427b1b-df73-4bfe-8c38-91ea397b1eae/scratchpad/m1o/nm.json",
		JSON.stringify(hq, null, 1),
	);
});
