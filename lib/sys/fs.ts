// What Beyond's own modules need of files (Bun.write, Beyond.build), on
// its natives rather than node:fs (which a program loads only if it uses
// it).

import { mkdir, stat } from "beyond:native";
import { dirname } from "./path.ts";

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;

/** Makes directory `path` and its missing parents. */
export function mkdirp(path: string): void {
  const missing: string[] = [];
  let d = path;
  while (stat(d, true, false) === undefined) {
    missing.push(d);
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  const st = stat(d, true, false);
  if (st !== undefined && (st.mode & S_IFMT) !== S_IFDIR) mkdir(path, undefined);
  for (let i = missing.length - 1; i >= 0; i--) {
    try {
      mkdir(missing[i], undefined);
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
}
