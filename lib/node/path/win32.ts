// node:path/win32: node:path's Windows functions (as Bun's).

import {
  win32,
  win32Basename,
  win32Dirname,
  win32Extname,
  win32Format,
  win32IsAbsolute,
  win32Join,
  win32MatchesGlob,
  win32Normalize,
  win32Parse,
  win32Relative,
  win32Resolve,
  win32ToNamespacedPath,
  posix,
} from "node:internal/bindings/Path";

export {
  win32Basename as basename,
  win32Dirname as dirname,
  win32Extname as extname,
  win32Format as format,
  win32IsAbsolute as isAbsolute,
  win32Join as join,
  win32MatchesGlob as matchesGlob,
  win32Normalize as normalize,
  win32Parse as parse,
  win32Relative as relative,
  win32Resolve as resolve,
  win32ToNamespacedPath as toNamespacedPath,
  win32ToNamespacedPath as _makeLong,
  posix,
  win32,
};
export const sep = "\\";
export const delimiter = ";";
export default win32;
