import type { LanguageTag } from "@/lib/domain/localization";

/** Platform copy is separate from an app's authored translations. Keep this
 * small catalog client/worker safe; unsupported languages fall back honestly. */
const english = {
	required: "This field is required",
	reviewHighlightedQuestion: "Review the highlighted question.",
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
	questionPosition: "Question {position}.",
	sectionPosition: "Section {position}.",
	requiredLabel: "Required.",
	expand: "Expand",
	collapse: "Collapse",
	untitledGroup: "Untitled group",
	repeatPosition: "Repeat {position}.",
	repeat: "Repeat",
	instances: "{count} instances",
	instancePosition: "Instance {position}",
	remove: "Remove",
	entry: "entry",
	addEntry: "Add {label}",
	pickDate: "Pick a date",
	dateLabel: "Date",
	timeLabel: "Time",
	mapUnavailable:
		"The map isn't available here. You can enter coordinates manually below.",
	manualCoordinates: "Enter coordinates manually",
	latitude: "Latitude",
	longitude: "Longitude",
	clearLocation: "Clear location",
	addressSearch: "Search for an address",
	addressSearchPlaceholder: "Search for an address or place",
	addressSearching: "Searching",
	addressSearchMinimum:
		"You can type at least {count} characters to see places",
	addressNoResults: "No matching places",
	yourLocation: "Your location",
	locating: "Locating",
	locationGuidance:
		"You can search for an address, click the map to drop a pin, or use your location",
	locationUnavailable: "Location unavailable",
	locationPermissionDenied:
		"Your browser hasn't allowed location access. You can allow it in its settings or enter coordinates manually.",
	locationPositionUnavailable:
		"Your location is currently unavailable. You can try again or enter coordinates manually.",
	locationTimeout:
		"Getting your location timed out. You can try again or enter coordinates manually.",
	locationUnsupported:
		"This browser can't share your location. You can enter coordinates manually.",
	locationUnexpected:
		"Couldn't get your location. You can try again or enter coordinates manually.",
} as const;

export type RuntimeMessage = keyof typeof english;
const spanish: Record<RuntimeMessage, string> = {
	required: "Este campo es obligatorio",
	reviewHighlightedQuestion: "Revise la pregunta resaltada.",
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
	questionPosition: "Pregunta {position}.",
	sectionPosition: "Sección {position}.",
	requiredLabel: "Obligatoria.",
	expand: "Expandir",
	collapse: "Contraer",
	untitledGroup: "Grupo sin título",
	repeatPosition: "Repetición {position}.",
	repeat: "Repetición",
	instances: "{count} repeticiones",
	instancePosition: "Repetición {position}",
	remove: "Quitar",
	entry: "entrada",
	addEntry: "Añadir {label}",
	pickDate: "Elegir una fecha",
	dateLabel: "Fecha",
	timeLabel: "Hora",
	mapUnavailable:
		"El mapa no está disponible aquí. Puede introducir las coordenadas manualmente abajo.",
	manualCoordinates: "Introducir coordenadas manualmente",
	latitude: "Latitud",
	longitude: "Longitud",
	clearLocation: "Borrar ubicación",
	addressSearch: "Buscar una dirección",
	addressSearchPlaceholder: "Buscar una dirección o un lugar",
	addressSearching: "Buscando",
	addressSearchMinimum: "Puedes buscar con al menos {count} caracteres",
	addressNoResults: "No hay lugares que coincidan",
	yourLocation: "Tu ubicación",
	locating: "Buscando ubicación",
	locationGuidance:
		"Puedes buscar una dirección, tocar el mapa para marcar un punto o usar tu ubicación",
	locationUnavailable: "Ubicación no disponible",
	locationPermissionDenied:
		"El navegador no dio permiso para compartir tu ubicación. Puedes permitirlo en su configuración o introducir las coordenadas manualmente.",
	locationPositionUnavailable:
		"Tu ubicación no está disponible ahora. Puedes intentarlo de nuevo o introducir las coordenadas manualmente.",
	locationTimeout:
		"Se agotó el tiempo para obtener tu ubicación. Puedes intentarlo de nuevo o introducir las coordenadas manualmente.",
	locationUnsupported:
		"Este navegador no puede compartir tu ubicación. Puedes introducir las coordenadas manualmente.",
	locationUnexpected:
		"No pude obtener tu ubicación. Puedes intentarlo de nuevo o introducir las coordenadas manualmente.",
};

export function runtimeLanguage(language: LanguageTag | null | undefined) {
	const base = language?.split("-")[0] ?? "eng";
	const catalogLanguage = base === "spa" ? "spa" : "eng";
	return { catalogLanguage, fallback: base !== catalogLanguage } as const;
}

/** Intl accepts the canonical language tag, including its regional suffix.
 * Calendar text uses the same bounded catalog as the other worker controls. */
export function runtimeDateLocale(language: LanguageTag | null | undefined) {
	return runtimeLanguage(language).fallback ? "eng" : (language ?? "eng");
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
