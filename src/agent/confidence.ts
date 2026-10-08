import type { TaskDeciderConfidenceProfile } from '@/types';

/** Only closed, numerical metadata is admitted; arbitrary identifiers/text cannot enter traces. */
export const copyConfidenceProfile = (value: unknown): TaskDeciderConfidenceProfile | undefined => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.values(descriptors).some(descriptor => !('value' in descriptor))
    ) {
      return undefined;
    }
    const record = Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value as unknown])
    );
    if (
      Object.keys(record).some(key => !['kind', 'calibrated', 'floors'].includes(key)) ||
      (record.kind !== 'vendor_reported' &&
        record.kind !== 'normalized_entropy' &&
        record.kind !== 'unknown') ||
      typeof record.calibrated !== 'boolean'
    ) {
      return undefined;
    }
    let raw: Record<string, unknown> | undefined;
    const offeredFloors = record.floors;
    if (offeredFloors !== undefined) {
      if (
        typeof offeredFloors !== 'object' ||
        offeredFloors === null ||
        Array.isArray(offeredFloors)
      ) {
        return undefined;
      }
      const floorPrototype: unknown = Object.getPrototypeOf(offeredFloors);
      const floorDescriptors = Object.getOwnPropertyDescriptors(offeredFloors);
      if (
        (floorPrototype !== Object.prototype && floorPrototype !== null) ||
        Object.values(floorDescriptors).some(descriptor => !('value' in descriptor))
      ) {
        return undefined;
      }
      raw = Object.fromEntries(
        Object.entries(floorDescriptors).map(([key, descriptor]) => [
          key,
          descriptor.value as unknown,
        ])
      );
      if (
        Object.entries(raw).some(
          ([key, floor]) =>
            !['action', 'argument', 'commitment', 'completion'].includes(key) ||
            typeof floor !== 'number' ||
            !Number.isFinite(floor) ||
            floor < 0 ||
            floor > 1
        )
      ) {
        return undefined;
      }
    }
    return Object.freeze({
      kind: record.kind,
      calibrated: record.calibrated,
      ...(raw === undefined
        ? {}
        : { floors: Object.freeze({ ...raw }) as TaskDeciderConfidenceProfile['floors'] }),
    });
  } catch {
    return undefined;
  }
};
