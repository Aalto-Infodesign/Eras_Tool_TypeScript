/**
 * Core domain types.
 *
 * The whole point of the columnar rewrite is that *everything downstream of
 * parsing is an integer index into a typed array*. That makes indices cheap but
 * also dangerously interchangeable — a `PatientIndex` and an `EventIndex` are
 * both `number` at runtime and mixing them is a silent, data-corrupting bug.
 * Branded types make the compiler catch that, at zero runtime cost.
 */
export const asPatient = (n) => n;
export const asEvent = (n) => n;
export const asState = (n) => n;
