export function resultTransferables(result) {
    return [
        // `patients` is the buffer the matrix was transferred in on; the worker is
        // finished with that typology by the time this runs, so it moves back out.
        result.patients.buffer,
        result.assignment.buffer,
        result.memberships.buffer,
        result.centers.buffer,
        result.sizes.buffer,
        result.medoidRow.buffer,
        result.medoidPatient.buffer,
    ];
}
