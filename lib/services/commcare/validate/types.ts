/** Validation error produced by deep blueprint validation. */
export interface ValidationError {
  code: 'XPATH_SYNTAX' | 'UNKNOWN_FUNCTION' | 'WRONG_ARITY' | 'INVALID_REF' | 'INVALID_CASE_REF' | 'CYCLE'
  message: string
  module?: string
  form?: string
  question?: string
  field?: string
}
