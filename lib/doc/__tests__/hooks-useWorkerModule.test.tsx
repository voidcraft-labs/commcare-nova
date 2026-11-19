// @vitest-environment happy-dom

import { renderHook } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { expect, it } from "vitest";
import { buildDoc, caseListConfig } from "@/lib/__tests__/docHelpers";
import { useWorkerModule } from "@/lib/doc/hooks/useWorkerModule";
import { BlueprintDocProvider } from "@/lib/doc/provider";
import { assertAdmittedDoc } from "./admittedDoc";

it("hands every render of one document the same projection, a render React repeats before it commits included", () => {
	/* The case list adjusts its own state during render to what its module
	 * holds; it settles only if a render React repeats for that adjustment
	 * reads the module it read before. */
	const doc = buildDoc({
		caseTypes: [{ name: "person", properties: [] }],
		modules: [
			{
				name: "People",
				caseType: "person",
				caseListConfig: caseListConfig([
					{ field: "case_name", header: "Name" },
				]),
				caseListMenuItem: {},
			},
		],
	});
	assertAdmittedDoc(doc);
	const moduleUuid = doc.moduleOrder[0];
	const wrapper = ({ children }: { children: ReactNode }) => (
		<BlueprintDocProvider appId={doc.appId} initialDoc={doc}>
			{children}
		</BlueprintDocProvider>
	);
	const seen: unknown[] = [];
	const { result, rerender } = renderHook(
		() => {
			const mod = useWorkerModule("en", moduleUuid);
			const [repeats, setRepeats] = useState(0);
			seen.push(mod);
			// Two updates during render: React renders again before committing.
			if (repeats < 2) setRepeats(repeats + 1);
			return mod;
		},
		{ wrapper },
	);
	rerender();
	expect(result.current?.name).toBeDefined();
	expect(new Set(seen).size).toBe(1);
});
