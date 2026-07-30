// @vitest-environment happy-dom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { testUuid } from "@/__tests__/helpers/uuid";
import { literal, term } from "@/lib/domain/predicate";
import {
	CaseTargetDraftProvider,
	useCaseTargetDraft,
} from "../CaseTargetDraftContext";

const FORM = testUuid("11111111-1111-4111-8111-111111111111");
const OPERATION = testUuid("22222222-2222-4222-8222-222222222222");
const OTHER_OPERATION = testUuid("33333333-3333-4333-8333-333333333333");

function Probe({
	label,
	operationUuid,
}: {
	readonly label: string;
	readonly operationUuid: typeof OPERATION;
}) {
	const draft = useCaseTargetDraft(FORM, operationUuid);
	return (
		<section aria-label={label}>
			<output>{draft.expression === undefined ? "none" : "draft"}</output>
			<button type="button" onClick={draft.begin}>
				Begin {label}
			</button>
			<button
				type="button"
				onClick={() => draft.update(term(literal("case-id")))}
			>
				Update {label}
			</button>
			<button type="button" onClick={draft.clear}>
				Clear {label}
			</button>
		</section>
	);
}

describe("CaseTargetDraftProvider", () => {
	it("shares one operation-scoped draft across the rail and canvas", () => {
		render(
			<CaseTargetDraftProvider>
				<Probe label="rail" operationUuid={OPERATION} />
				<Probe label="canvas" operationUuid={OPERATION} />
				<Probe label="other" operationUuid={OTHER_OPERATION} />
			</CaseTargetDraftProvider>,
		);

		fireEvent.click(screen.getByRole("button", { name: "Begin rail" }));
		expect(screen.getByRole("region", { name: "rail" }).textContent).toContain(
			"draft",
		);
		expect(
			screen.getByRole("region", { name: "canvas" }).textContent,
		).toContain("draft");
		expect(screen.getByRole("region", { name: "other" }).textContent).toContain(
			"none",
		);

		fireEvent.click(screen.getByRole("button", { name: "Clear canvas" }));
		expect(screen.getByRole("region", { name: "rail" }).textContent).toContain(
			"none",
		);
		expect(
			screen.getByRole("region", { name: "canvas" }).textContent,
		).toContain("none");
	});
});
