import { IdColumn } from "./IdColumn.ts";
export function toPayload(store) {
    return {
        patientCount: store.patientCount,
        eventCount: store.eventCount,
        idBytes: store.ids.bytes,
        idOffsets: store.ids.offsets,
        diseaseDuration: store.diseaseDuration,
        offsets: store.offsets,
        stateIds: store.stateIds,
        ages: store.ages,
        years: store.years,
        durations: store.durations,
        eventPatient: store.eventPatient,
        stateNames: store.stateNames,
        extents: store.extents,
    };
}
export function fromPayload(payload) {
    return {
        patientCount: payload.patientCount,
        eventCount: payload.eventCount,
        ids: new IdColumn(payload.idBytes, payload.idOffsets),
        diseaseDuration: payload.diseaseDuration,
        offsets: payload.offsets,
        stateIds: payload.stateIds,
        ages: payload.ages,
        years: payload.years,
        durations: payload.durations,
        eventPatient: payload.eventPatient,
        stateNames: payload.stateNames,
        extents: payload.extents,
    };
}
export function payloadTransferables(payload) {
    return [
        payload.idBytes.buffer,
        payload.idOffsets.buffer,
        payload.diseaseDuration.buffer,
        payload.offsets.buffer,
        payload.stateIds.buffer,
        payload.ages.buffer,
        payload.years.buffer,
        payload.durations.buffer,
        payload.eventPatient.buffer,
    ];
}
