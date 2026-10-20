// Bun's NodeAsyncHooks natives: setAsyncHooksEnabled tells JavaScriptCore
// to track async context; Beyond's async context (node:async_hooks's
// AsyncLocalStorage) needs no switch.

export function jsSetAsyncHooksEnabled(_enabled?: unknown): undefined {
  return undefined;
}
