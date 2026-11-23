"use client";

import { useId, useState } from "react";
import { Button } from "@/components/shadcn/button";
import { Input } from "@/components/shadcn/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/shadcn/select";
import { editCaseRelation } from "@/lib/doc/caseRelationEdit";
import { useBlueprintMutations } from "@/lib/doc/hooks/useBlueprintMutations";
import {
	useCaseTypes,
	useEffectiveCaseTypes,
} from "@/lib/doc/hooks/useCaseTypes";
import { humanizeId } from "@/lib/domain";
import {
	type CaseRelation,
	caseRelationSchema,
	compareCaseRelations,
	declaredCaseRelations,
} from "@/lib/domain/caseRelations";

export function CaseRelationsSection({ caseType }: { caseType: string }) {
	const catalog = useCaseTypes();
	const type = catalog.find((item) => item.name === caseType);
	const effective = useEffectiveCaseTypes().find(
		(item) => item.name === caseType,
	);
	const { commitMany } = useBlueprintMutations();
	const [adding, setAdding] = useState(false);
	const [identifier, setIdentifier] = useState("parent");
	const [target, setTarget] = useState("");
	const [relationship, setRelationship] = useState<"child" | "extension">(
		"child",
	);
	const [error, setError] = useState("");
	const id = useId();
	if (!type || !effective) return null;

	const edges = declaredCaseRelations(effective);
	const held = declaredCaseRelations(type);
	function change(action: "add" | "remove", edge: CaseRelation) {
		if (!type) return;
		const mutations = editCaseRelation(type, action, edge);
		if (action === "add" && mutations.length === 0) {
			setError("This case type already has that link.");
			return;
		}
		const outcome = commitMany(mutations);
		if (!outcome.ok) {
			setError(outcome.messages.join(" "));
			return;
		}
		setAdding(false);
		setError("");
	}
	return (
		<section aria-labelledby={id} className="space-y-2">
			<h3 id={id} className="text-sm font-medium text-nova-text-secondary">
				Related cases
			</h3>
			{edges.length > 0 && (
				<ul className="space-y-2">
					{edges.map((edge) => {
						const declared = held.some(
							(one) => compareCaseRelations(one, edge) === 0,
						);
						return (
							<li
								key={JSON.stringify([
									edge.identifier,
									edge.targetType,
									edge.relationship,
								])}
								className="flex items-start justify-between gap-2"
							>
								<div className="min-w-0">
									<span className="break-words text-sm">
										{humanizeId(edge.targetType)}
									</span>
									<p className="break-words text-xs text-nova-text-muted">
										{edge.identifier}
										{edge.relationship === "extension" ? " · Extension" : ""}
										{!declared ? " · Used in the app" : ""}
									</p>
								</div>
								{declared && (
									<Button
										variant="ghost"
										aria-label={`Remove ${edge.identifier} link to ${humanizeId(edge.targetType)}`}
										onClick={() => change("remove", edge)}
									>
										Remove
									</Button>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{adding ? (
				<div className="space-y-3">
					<label htmlFor={`${id}-name`} className="block space-y-1 text-sm">
						<span>Link name</span>
						<Input
							id={`${id}-name`}
							value={identifier}
							onChange={(event) => setIdentifier(event.target.value)}
						/>
					</label>
					<div>
						<label htmlFor={`${id}-target`} className="text-sm">
							Related case type
						</label>
						<Select
							value={target || null}
							onValueChange={(value) => setTarget(value ?? "")}
						>
							<SelectTrigger id={`${id}-target`} className="w-full">
								<SelectValue>
									{target ? humanizeId(target) : "Choose a case type"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{catalog.map((item) => (
									<SelectItem key={item.name} value={item.name}>
										{humanizeId(item.name)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div>
						<label htmlFor={`${id}-kind`} className="text-sm">
							Relationship
						</label>
						<Select
							value={relationship}
							onValueChange={(value) => {
								if (value === "child" || value === "extension")
									setRelationship(value);
							}}
						>
							<SelectTrigger id={`${id}-kind`} className="w-full">
								<SelectValue>
									{relationship === "extension" ? "Extension" : "Child"}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="child">Child</SelectItem>
								<SelectItem value="extension">Extension</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex gap-2">
						<Button
							disabled={!target}
							onClick={() => {
								const parsed = caseRelationSchema.safeParse({
									identifier,
									targetType: target,
									relationship,
								});
								if (parsed.success) change("add", parsed.data);
								else
									setError(
										"That link name cannot be used in the app. Try a name such as home_site.",
									);
							}}
						>
							Save link
						</Button>
						<Button
							variant="ghost"
							onClick={() => {
								setAdding(false);
								setError("");
							}}
						>
							Cancel
						</Button>
					</div>
				</div>
			) : (
				<Button
					variant="outline"
					onClick={() => {
						setIdentifier("parent");
						setTarget("");
						setRelationship("child");
						setAdding(true);
						setError("");
					}}
				>
					Add a related case
				</Button>
			)}
			{error && (
				<p role="alert" className="text-xs text-nova-rose">
					{error}
				</p>
			)}
		</section>
	);
}
