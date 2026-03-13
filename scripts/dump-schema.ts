import { z } from 'zod'
import { appContentSchema } from '../lib/schemas/appContentSchema'

const jsonSchema = z.toJSONSchema(appContentSchema)
const str = JSON.stringify(jsonSchema, null, 2)
console.log(`Schema size: ${str.length} chars, ${JSON.stringify(jsonSchema).length} chars minified`)
console.log(`Top-level keys:`, Object.keys(jsonSchema))
console.log(str)
