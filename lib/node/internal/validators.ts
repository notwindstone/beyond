import { URL } from "beyond:url";
import { jsFunction_validateObject as __native_NodeValidator_jsFunction_validateObject } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateInteger as __native_NodeValidator_jsFunction_validateInteger } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateNumber as __native_NodeValidator_jsFunction_validateNumber } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateFiniteNumber as __native_NodeValidator_jsFunction_validateFiniteNumber } from "node:internal/bindings/NodeValidator";
import { jsFunction_checkRangesOrGetDefault as __native_NodeValidator_jsFunction_checkRangesOrGetDefault } from "node:internal/bindings/NodeValidator";
import { jsFunction_validatePort as __native_NodeValidator_jsFunction_validatePort } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateAbortSignal as __native_NodeValidator_jsFunction_validateAbortSignal } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateArray as __native_NodeValidator_jsFunction_validateArray } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateInt32 as __native_NodeValidator_jsFunction_validateInt32 } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateUint32 as __native_NodeValidator_jsFunction_validateUint32 } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateEncoding as __native_NodeValidator_jsFunction_validateEncoding } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateBuffer as __native_NodeValidator_jsFunction_validateBuffer } from "node:internal/bindings/NodeValidator";
import { jsFunction_validateOneOf as __native_NodeValidator_jsFunction_validateOneOf } from "node:internal/bindings/NodeValidator";
import { $ERR_INVALID_ARG_TYPE, $ERR_INVALID_ARG_VALUE } from "node:internal/intrinsics";
import { hideFromStack } from "node:internal/shared";

const RegExpPrototypeExec = RegExp.prototype.exec;
const ArrayIsArray = Array.isArray;

const tokenRegExp = /^[\^_`a-zA-Z\-0-9!#$%&'*+.|~]+$/;
/**
 * Verifies that the given val is a valid HTTP token
 * per the rules defined in RFC 7230
 * See https://tools.ietf.org/html/rfc7230#section-3.2.6
 */
function checkIsHttpToken(val) {
  return RegExpPrototypeExec.call(tokenRegExp, val) !== null;
}

/*
  The rules for the Link header field are described here:
  https://www.rfc-editor.org/rfc/rfc8288.html#section-3

  This regex validates any string surrounded by angle brackets
  (not necessarily a valid URI reference) followed by zero or more
  link-params separated by semicolons.

  The parameter name excludes "=" so it cannot overlap with the optional
  "=value" suffix; otherwise inputs like "<>;a=b;a=b;...;a=b " trigger
  catastrophic backtracking.
*/
const linkValueRegExp = /^(?:<[^>]*>)(?:\s*;\s*[^;"\s=]+(?:=(")?[^;"\s]*\1)?)*$/;
const linkValueForbiddenCharsRegExp = /[\r\n]/;
function validateLinkHeaderFormat(value, name) {
  if (
    typeof value === "undefined" ||
    !RegExpPrototypeExec.call(linkValueRegExp, value) ||
    RegExpPrototypeExec.call(linkValueForbiddenCharsRegExp, value) !== null
  ) {
    throw $ERR_INVALID_ARG_VALUE(
      name,
      value,
      `must be an array or string of format "</styles.css>; rel=preload; as=style"`,
    );
  }
}

function validateLinkHeaderValue(hints) {
  if (typeof hints === "string") {
    validateLinkHeaderFormat(hints, "hints");
    return hints;
  } else if (ArrayIsArray(hints)) {
    const hintsLength = hints.length;
    let result = "";

    if (hintsLength === 0) {
      return result;
    }

    for (let i = 0; i < hintsLength; i++) {
      const link = hints[i];
      validateLinkHeaderFormat(link, "hints");
      result += link;

      if (i !== hintsLength - 1) {
        result += ", ";
      }
    }

    return result;
  }

  throw $ERR_INVALID_ARG_VALUE(
    "hints",
    hints,
    `must be an array or string of format "</styles.css>; rel=preload; as=style"`,
  );
}

function validateString(value, name) {
  if (typeof value !== "string") throw $ERR_INVALID_ARG_TYPE(name, "string", value);
}

function validateFunction(value, name) {
  if (typeof value !== "function") throw $ERR_INVALID_ARG_TYPE(name, "function", value);
}

function validateBoolean(value, name) {
  if (typeof value !== "boolean") throw $ERR_INVALID_ARG_TYPE(name, "boolean", value);
}

/** Validate a string-or-URL path and return it resolved to an absolute path string. */
function getValidatedPath(p: any) {
  if (p instanceof URL) return Bun.fileURLToPath(p as URL);
  if (typeof p !== "string") throw $ERR_INVALID_ARG_TYPE("path", "string or URL", p);
  if (p.startsWith("file:")) return Bun.fileURLToPath(p);
  return import.meta.require("node:path").default.resolve(p);
}

function throwIfNullBytesInFileName(filename: string) {
  if (filename.indexOf("\u0000") !== -1) {
    throw $ERR_INVALID_ARG_VALUE("path", "string without null bytes", filename);
  }
}

/**
 * node's fs getValidatedPath (lib/internal/fs/utils.js): converts URL
 * *instances* via fileURLToPath, accepts strings and Buffers as-is (no
 * path.resolve, no "file:"-prefix string sniffing), and rejects null bytes.
 */
function getValidatedFsPath(p: any, propName: string = "path") {
  if (p instanceof URL) p = Bun.fileURLToPath(p);
  if (typeof p === "string") {
    if (p.indexOf("\u0000") !== -1) {
      throw $ERR_INVALID_ARG_VALUE(propName, p, "must be a string, Uint8Array, or URL without null bytes");
    }
    return p;
  }
  if (p instanceof Uint8Array) {
    if (p.indexOf(0) !== -1) {
      throw $ERR_INVALID_ARG_VALUE(propName, p, "must be a string, Uint8Array, or URL without null bytes");
    }
    return p;
  }
  throw $ERR_INVALID_ARG_TYPE(propName, ["string", "Buffer", "URL"], p);
}

hideFromStack(validateLinkHeaderValue);
hideFromStack(validateString, validateFunction, validateBoolean);
hideFromStack(getValidatedPath, getValidatedFsPath, throwIfNullBytesInFileName);

// Must match jsFunction_validateObject in NodeValidator.cpp. The values are node's:
// https://github.com/nodejs/node/blob/v26.3.0/lib/internal/validators.js#L224-L227
const kValidateObjectNone = 0;
const kValidateObjectAllowNullable = 1 << 0;
const kValidateObjectAllowArray = 1 << 1;
const kValidateObjectAllowFunction = 1 << 2;

export default {
  kValidateObjectNone,
  kValidateObjectAllowNullable,
  kValidateObjectAllowArray,
  kValidateObjectAllowFunction,
  /** (value, name[, kValidateObject* flags]) */
  validateObject: __native_NodeValidator_jsFunction_validateObject,
  validateLinkHeaderValue: validateLinkHeaderValue,
  checkIsHttpToken: checkIsHttpToken,
  /** `(value, name, min, max)` */
  validateInteger: __native_NodeValidator_jsFunction_validateInteger,
  /** `(value, name, min, max)` */
  validateNumber: __native_NodeValidator_jsFunction_validateNumber,
  /** `(value, name)` */
  validateString,
  /** `(number, name)` */
  validateFiniteNumber: __native_NodeValidator_jsFunction_validateFiniteNumber,
  /** `(number, name, lower, upper, def)` */
  checkRangesOrGetDefault: __native_NodeValidator_jsFunction_checkRangesOrGetDefault,
  /** `(value, name)` */
  validateFunction,
  /** `(value, name)` */
  validateBoolean,
  /** `(port, name = 'Port', allowZero = true)` */
  validatePort: __native_NodeValidator_jsFunction_validatePort,
  /** `(signal, name)` */
  validateAbortSignal: __native_NodeValidator_jsFunction_validateAbortSignal,
  /** `(value, name, minLength = 0)` */
  validateArray: __native_NodeValidator_jsFunction_validateArray,
  /** `(value, name, min = -2147483648, max = 2147483647)` */
  validateInt32: __native_NodeValidator_jsFunction_validateInt32,
  /** `(value, name, positive = false)` */
  validateUint32: __native_NodeValidator_jsFunction_validateUint32,
  /** `(data, encoding)` */
  validateEncoding: __native_NodeValidator_jsFunction_validateEncoding,
  /** `(buffer, name = 'buffer')` */
  validateBuffer: __native_NodeValidator_jsFunction_validateBuffer,
  /** `(value, name, oneOf)` */
  validateOneOf: __native_NodeValidator_jsFunction_validateOneOf,
  isUint8Array: value => value instanceof Uint8Array,
  /** `(path)` — accepts a string or file URL, returns it resolved to an absolute path string */
  getValidatedPath,
  getValidatedFsPath,
  /** `(filename)` */
  throwIfNullBytesInFileName,
};

export { kValidateObjectNone, kValidateObjectAllowNullable, kValidateObjectAllowArray, kValidateObjectAllowFunction, __native_NodeValidator_jsFunction_validateObject as validateObject, validateLinkHeaderValue, checkIsHttpToken, __native_NodeValidator_jsFunction_validateInteger as validateInteger, __native_NodeValidator_jsFunction_validateNumber as validateNumber, validateString, __native_NodeValidator_jsFunction_validateFiniteNumber as validateFiniteNumber, __native_NodeValidator_jsFunction_checkRangesOrGetDefault as checkRangesOrGetDefault, validateFunction, validateBoolean, __native_NodeValidator_jsFunction_validatePort as validatePort, __native_NodeValidator_jsFunction_validateAbortSignal as validateAbortSignal, __native_NodeValidator_jsFunction_validateArray as validateArray, __native_NodeValidator_jsFunction_validateInt32 as validateInt32, __native_NodeValidator_jsFunction_validateUint32 as validateUint32, __native_NodeValidator_jsFunction_validateEncoding as validateEncoding, __native_NodeValidator_jsFunction_validateBuffer as validateBuffer, __native_NodeValidator_jsFunction_validateOneOf as validateOneOf, getValidatedPath, getValidatedFsPath, throwIfNullBytesInFileName };
