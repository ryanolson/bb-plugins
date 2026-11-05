// A lookup that sees only an object's own keys. Settings and profiles are
// parsed from JSON into plain objects, so a name like `constructor` would
// otherwise find an inherited value and pass a check it should fail.
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}
