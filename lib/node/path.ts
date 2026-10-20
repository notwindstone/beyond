// node:path, as Bun's (src/js/node/path.ts): its binding's functions
// (internal/bindings/Path.ts), exported directly rather than bound, so that
// a program's calls of them are direct calls.

import {
  posix,
  posixBasename,
  posixDirname,
  posixExtname,
  posixFormat,
  posixIsAbsolute,
  posixJoin,
  posixMatchesGlob,
  posixNormalize,
  posixParse,
  posixRelative,
  posixResolve,
  posixToNamespacedPath,
  win32,
} from "node:internal/bindings/Path";

export {
  posixBasename as basename,
  posixDirname as dirname,
  posixExtname as extname,
  posixFormat as format,
  posixIsAbsolute as isAbsolute,
  posixJoin as join,
  posixMatchesGlob as matchesGlob,
  posixNormalize as normalize,
  posixParse as parse,
  posixRelative as relative,
  posixResolve as resolve,
  posixToNamespacedPath as toNamespacedPath,
  posixToNamespacedPath as _makeLong,
  posix,
  win32,
};
export const sep = "/";
export const delimiter = ":";
export default posix;
