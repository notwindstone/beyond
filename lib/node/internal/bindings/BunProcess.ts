// Bun's BunProcess natives: reportUncaughtException (Bun__reportUnhandledError),
// an error to process's 'uncaughtException' listeners, else reported as
// uncaught (the program then exits with 1).

import { reportError } from "beyond:native";

export function jsFunctionReportUncaughtException(err: unknown): undefined {
  reportError(err);
  return undefined;
}
