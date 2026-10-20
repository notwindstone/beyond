// Deep-strict-equality helpers shared by node:assert and node:util.
"use strict";

// Native comparator: node semantics including [[Prototype]] identity.
// Third arg truthy = skipPrototype (Assert class option, node's
// kStrictWithoutPrototypes mode). node v26.3.0 exposes fn.length === 3.
import { jsFunctionIsDeepStrictEqual as __native_NodeUtilTypesModule_jsFunctionIsDeepStrictEqual } from "node:internal/bindings/NodeUtilTypesModule";
const isDeepStrictEqual = __native_NodeUtilTypesModule_jsFunctionIsDeepStrictEqual;

export default { isDeepStrictEqual };

export { isDeepStrictEqual };
