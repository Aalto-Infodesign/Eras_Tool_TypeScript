export const toStatePayload = (s) => ({
    id: s.id,
    name: s.name,
    population: s.population,
    // `subarray` views share the matrix buffer; slice so each one transfers cleanly.
    frequencies: s.frequencies.slice(),
});
