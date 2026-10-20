// Natives of Bun's ModuleGraph (Bun.ModuleGraph's tracking of which graph an
// async context frame is inside of). Beyond has no module graphs of that
// kind: no frame is inside one.

export function jsFunctionIsFrameOfStoppedModuleGraph(_frame: unknown): boolean {
  return false;
}

export function jsFunctionModuleGraphFrameOfFrame(_frame: unknown): undefined {
  return undefined;
}

export function jsFunctionModuleGraphOfFrame(_frame: unknown): undefined {
  return undefined;
}
