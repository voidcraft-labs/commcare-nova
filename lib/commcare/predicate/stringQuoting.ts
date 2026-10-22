/** CSQL has no concat escape in its server-side value grammar. */
export function isCsqlStringLiteralRepresentable(value: string): boolean {
	return !(value.includes("'") && value.includes('"'));
}

export function quoteLiteral(value: string, _dialect: "csql"): string {
	if (!value.includes("'")) return `'${value}'`;
	if (!isCsqlStringLiteralRepresentable(value)) {
		throw new Error(
			`stringQuoting: CSQL has no portable escape for a string literal containing both ' and ". Got: ${JSON.stringify(value)}.`,
		);
	}
	return `"${value}"`;
}

export { formatNumeric } from "@/lib/domain/expression/numberLiteral";
