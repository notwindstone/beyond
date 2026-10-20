// Natives of Bun's UtilInspect: V8's getOwnNonIndexProperties(object,
// filter), which util.inspect lists an object's own keys with (its array
// indices are shown as elements).

// (Node's PropertyFilter bits.)
const ONLY_ENUMERABLE = 1 << 1;
const SKIP_STRINGS = 1 << 3;
const SKIP_SYMBOLS = 1 << 4;

/** Whether `key` is an array index ("0" to "4294967294"). */
function isIndex(key: string): boolean {
  const n = key.length;
  if (n === 0 || n > 10) return false;
  const c = key.charCodeAt(0);
  if (c < 48 || c > 57 || (c === 48 && n > 1)) return false;
  for (let i = 1; i < n; i++) {
    const d = key.charCodeAt(i);
    if (d < 48 || d > 57) return false;
  }
  return n < 10 || Number(key) < 4294967295;
}

export function jsFunctionGetOwnNonIndexProperties(object: object, filter: number): PropertyKey[] {
  const out: PropertyKey[] = [];
  const onlyEnumerable = (filter & ONLY_ENUMERABLE) !== 0;
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key === "string") {
      if ((filter & SKIP_STRINGS) !== 0 || isIndex(key)) continue;
    } else if ((filter & SKIP_SYMBOLS) !== 0) {
      continue;
    }
    if (onlyEnumerable && !Object.prototype.propertyIsEnumerable.call(object, key)) continue;
    out.push(key);
  }
  return out;
}
