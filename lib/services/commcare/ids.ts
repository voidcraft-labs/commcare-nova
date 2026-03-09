import { randomBytes } from 'crypto'

/** Generate a 40-char hex ID for HQ unique_id fields. */
export function genHexId(): string {
  return randomBytes(20).toString('hex')
}

/** Generate a 16-char hex ID for xmlns URIs. */
export function genShortId(): string {
  return randomBytes(8).toString('hex')
}
