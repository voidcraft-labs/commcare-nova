import type { CaseType } from '@/lib/schemas/blueprint'
import type { DummyCaseRow } from './types'

const FIRST_NAMES = ['Amara', 'Carlos', 'Fatima', 'Jin', 'Priya', 'Kofi', 'Elena', 'Omar']
const LAST_NAMES = ['Okafor', 'Mendez', 'Al-Hassan', 'Nakamura', 'Sharma', 'Mensah', 'Petrova', 'Ibrahim']

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function randomDate(daysBack: number): string {
  const d = new Date()
  d.setDate(d.getDate() - Math.floor(Math.random() * daysBack))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** Generate a value for a case property based on its metadata. */
function generateValue(name: string, dataType: string | undefined, options?: { value: string; label: string }[]): string {
  // If options are defined, pick from them
  if (options && options.length > 0) {
    return pick(options).value
  }

  const type = dataType ?? 'text'
  const lowerName = name.toLowerCase()

  // Heuristic based on property name
  if (lowerName.includes('name') || lowerName === 'case_name') {
    return `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`
  }
  if (lowerName.includes('first_name') || lowerName.includes('fname')) {
    return pick(FIRST_NAMES)
  }
  if (lowerName.includes('last_name') || lowerName.includes('lname')) {
    return pick(LAST_NAMES)
  }
  if (lowerName.includes('phone') || lowerName.includes('mobile')) {
    return `+1${randomInt(200, 999)}${randomInt(100, 999)}${randomInt(1000, 9999)}`
  }
  if (lowerName.includes('email')) {
    return `${pick(FIRST_NAMES).toLowerCase()}@example.com`
  }
  if (lowerName.includes('age')) {
    return String(randomInt(18, 75))
  }
  if (lowerName.includes('gender') || lowerName.includes('sex')) {
    return pick(['male', 'female'])
  }
  if (lowerName.includes('address') || lowerName.includes('location')) {
    return `${randomInt(1, 999)} ${pick(['Main', 'Oak', 'River', 'Lake', 'Hill'])} St`
  }
  if (lowerName.includes('status')) {
    return pick(['active', 'inactive', 'pending'])
  }

  // Based on data type
  switch (type) {
    case 'int':
      return String(randomInt(1, 100))
    case 'decimal':
      return (Math.random() * 100).toFixed(1)
    case 'date':
      return randomDate(365)
    case 'time':
      return `${String(randomInt(8, 17)).padStart(2, '0')}:${String(randomInt(0, 59)).padStart(2, '0')}`
    case 'datetime':
      return `${randomDate(365)}T${String(randomInt(8, 17)).padStart(2, '0')}:${String(randomInt(0, 59)).padStart(2, '0')}`
    case 'phone':
      return `+1${randomInt(200, 999)}${randomInt(100, 999)}${randomInt(1000, 9999)}`
    case 'geopoint':
      return `${(Math.random() * 180 - 90).toFixed(4)} ${(Math.random() * 360 - 180).toFixed(4)}`
    case 'select1':
    case 'select':
      return pick(['yes', 'no'])
    default:
      return `Sample ${name}`
  }
}

/**
 * Generate realistic dummy case rows from a CaseType definition.
 * @param count Number of rows to generate (default: 6)
 */
export function generateDummyCases(caseType: CaseType, count = 6): DummyCaseRow[] {
  const rows: DummyCaseRow[] = []

  for (let i = 0; i < count; i++) {
    const properties = new Map<string, string>()

    // Generate a value for each property
    for (const prop of caseType.properties) {
      properties.set(prop.name, generateValue(prop.name, prop.data_type, prop.options))
    }

    // Derive case_name from case_name_property
    const caseName = properties.get(caseType.case_name_property) ?? `Case ${i + 1}`
    properties.set('case_name', caseName)

    rows.push({
      case_id: crypto.randomUUID(),
      properties,
    })
  }

  return rows
}
