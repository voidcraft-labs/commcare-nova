"use client";

import { useId } from "react";
import { Button } from "@/components/shadcn/button";
import { Textarea } from "@/components/shadcn/textarea";
import type {
	LookupColumn,
	LookupMember,
	LookupOccurrence,
	LookupRowContent,
} from "@/lib/lookup/types";

type RichRowFieldsProps = {
	columns: readonly LookupColumn[];
	attributes: readonly LookupMember[];
	content: LookupRowContent;
	onChange?: (next: LookupRowContent) => void;
};

function TextValue({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string | undefined;
	onChange?: (value: string) => void;
}) {
	const id = useId();
	return (
		<div className="space-y-1 text-[13px] text-nova-text">
			{onChange ? (
				<>
					<label htmlFor={id}>{label}</label>
					<Textarea
						id={id}
						rows={2}
						value={value ?? ""}
						onChange={(event) => onChange(event.target.value)}
					/>
				</>
			) : (
				<dl>
					<dt>{label}</dt>
					<dd className="whitespace-pre-wrap text-nova-text-secondary [overflow-wrap:anywhere]">
						{value === undefined
							? "No value"
							: value === ""
								? "Empty text"
								: value}
					</dd>
				</dl>
			)}
		</div>
	);
}

export function RichRowFields({
	columns,
	attributes,
	content,
	onChange,
}: RichRowFieldsProps) {
	return (
		<>
			{attributes.map((member) => (
				<TextValue
					key={member.id}
					label={member.label}
					value={content.attributes?.[member.id]}
					onChange={
						onChange &&
						((text) =>
							onChange({
								...content,
								attributes: { ...content.attributes, [member.id]: text },
							}))
					}
				/>
			))}
			{columns
				.filter((column) => column.repeated)
				.map((column) => {
					const items = content.occurrences?.[column.id];
					const setItems = (next: LookupOccurrence[] | undefined) => {
						const occurrences = { ...content.occurrences };
						if (next === undefined) delete occurrences[column.id];
						else occurrences[column.id] = next;
						onChange?.({ ...content, occurrences });
					};
					return (
						<fieldset
							key={column.id}
							className="space-y-2 rounded-lg border border-nova-border p-3"
						>
							<legend className="px-1 text-[13px] font-medium">
								{column.label}
							</legend>
							{items === undefined && (
								<p className="text-xs text-nova-text-muted">
									No list supplied. Workers read one empty value.
								</p>
							)}
							{items?.length === 0 && (
								<p className="text-xs text-nova-text-muted">Empty list</p>
							)}
							{items?.map((item, index) => {
								const replace = (next: LookupOccurrence) =>
									setItems(
										items.map((other, i) => (i === index ? next : other)),
									);
								return (
									<fieldset
										// biome-ignore lint/suspicious/noArrayIndexKey: An occurrence is identified by its position in this ordered list, including equal adjacent values.
										key={index}
										className="space-y-2 border-b border-nova-border pb-2"
									>
										<legend className="text-xs font-medium">
											Value {index + 1}
										</legend>
										<TextValue
											label={`${column.label}, value ${index + 1}`}
											value={item.text}
											onChange={
												onChange && ((text) => replace({ ...item, text }))
											}
										/>
										{column.properties?.map((member) => (
											<div key={member.id}>
												<TextValue
													label={member.label}
													value={item.properties[member.id]}
													onChange={
														onChange &&
														((text) =>
															replace({
																...item,
																properties: {
																	...item.properties,
																	[member.id]: text,
																},
															}))
													}
												/>
												{onChange &&
													(Object.hasOwn(item.properties, member.id) ? (
														<Button
															variant="ghost"
															onClick={() => {
																const properties = { ...item.properties };
																delete properties[member.id];
																replace({ ...item, properties });
															}}
														>
															Remove {member.label}
														</Button>
													) : (
														<Button
															variant="ghost"
															onClick={() =>
																replace({
																	...item,
																	properties: {
																		...item.properties,
																		[member.id]: "",
																	},
																})
															}
														>
															Set {member.label} to empty text
														</Button>
													))}
											</div>
										))}
										{onChange && (
											<div className="flex flex-wrap gap-1">
												{index > 0 && (
													<Button
														variant="ghost"
														onClick={() => {
															const next = items.slice();
															next.splice(
																index - 1,
																0,
																...next.splice(index, 1),
															);
															setItems(next);
														}}
													>
														Move value {index + 1} up
													</Button>
												)}
												<Button
													variant="ghost"
													onClick={() =>
														setItems(items.filter((_, i) => i !== index))
													}
												>
													Remove value {index + 1}
												</Button>
											</div>
										)}
									</fieldset>
								);
							})}
							{onChange && (
								<div className="flex flex-wrap gap-1">
									<Button
										variant="outline"
										onClick={() =>
											setItems([...(items ?? []), { text: "", properties: {} }])
										}
									>
										Add value
									</Button>
									{items === undefined ? (
										<Button variant="ghost" onClick={() => setItems([])}>
											Use an empty list
										</Button>
									) : (
										<Button variant="ghost" onClick={() => setItems(undefined)}>
											Leave list unspecified
										</Button>
									)}
								</div>
							)}
						</fieldset>
					);
				})}
		</>
	);
}
