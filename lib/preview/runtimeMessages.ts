import type { LanguageTag } from "@/lib/domain/localization";

/** Platform copy is separate from an app's authored translations. Keep this
 * small catalog client/worker safe; unsupported languages fall back honestly. */
const english = {
	required: "This field is required",
	searchRequired: "Fill in this answer before searching.",
	invalid: "Invalid value",
	wholeNumber: "This question needs a whole number.",
	number: "This question needs a number.",
	integerRange:
		"The number needs to be between -2,147,483,648 and 2,147,483,647.",
	numberTooLarge: "The number is too large to save.",
	date: "“{value}” isn't a date. Pick one from the calendar.",
	time: "“{value}” isn't a time yet. Enter a clock time like 2:30 PM.",
	missingTime: "Enter a clock time: this question needs both.",
	missingDate: "Pick a date: this question needs both.",
	dateTime: "“{value}” isn't a date and time.",
	back: "Back",
	goBack: "Go back",
	backToResults: "Back to results",
	next: "Next",
	submit: "Submit",
	submitting: "Submitting",
	clear: "Clear",
	clearAnswers: "Clear answers",
	clearForm: "Clear form",
	startingFresh: "Starting fresh",
	clearing: "Clearing",
	continue: "Continue",
	checkingCases: "Checking cases",
	search: "Search",
	results: "Results",
	sections: "Sections",
	section: "Section {position} of {count}",
} as const;

export type RuntimeMessage = keyof typeof english;
const spanish: Record<RuntimeMessage, string> = {
	required: "Este campo es obligatorio",
	searchRequired: "Complete esta respuesta antes de buscar.",
	invalid: "Valor no válido",
	wholeNumber: "Esta pregunta necesita un número entero.",
	number: "Esta pregunta necesita un número.",
	integerRange: "El número debe estar entre -2,147,483,648 y 2,147,483,647.",
	numberTooLarge: "El número es demasiado grande para guardarlo.",
	date: "«{value}» no es una fecha. Elija una en el calendario.",
	time: "«{value}» no es una hora. Introduzca una hora como 14:30.",
	missingTime: "Introduzca una hora: esta pregunta necesita ambas.",
	missingDate: "Elija una fecha: esta pregunta necesita ambas.",
	dateTime: "«{value}» no es una fecha y hora.",
	back: "Atrás",
	goBack: "Volver",
	backToResults: "Volver a los resultados",
	next: "Siguiente",
	submit: "Enviar",
	submitting: "Enviando",
	clear: "Borrar",
	clearAnswers: "Borrar respuestas",
	clearForm: "Borrar formulario",
	startingFresh: "Empezando de nuevo",
	clearing: "Borrando",
	continue: "Continuar",
	checkingCases: "Comprobando registros",
	search: "Buscar",
	results: "Resultados",
	sections: "Secciones",
	section: "Sección {position} de {count}",
};

export function runtimeLanguage(language: LanguageTag | null | undefined) {
	const base = language?.split("-")[0] ?? "eng";
	const catalogLanguage = base === "spa" ? "spa" : "eng";
	return { catalogLanguage, fallback: base !== catalogLanguage } as const;
}

export function runtimeMessage(
	language: LanguageTag | null | undefined,
	key: RuntimeMessage,
	values: Readonly<Record<string, string | number>> = {},
): string {
	let text: string =
		runtimeLanguage(language).catalogLanguage === "spa"
			? spanish[key]
			: english[key];
	for (const [name, value] of Object.entries(values))
		text = text.replaceAll(`{${name}}`, String(value));
	return text;
}
