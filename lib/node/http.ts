import * as ___http_incoming from "node:_http_incoming";
import * as __internal_http from "node:internal/http";
import __util from "node:util";
import { process } from "beyond:process";
import { URL } from "beyond:url";
import { $ERR_PROXY_INVALID_CONFIG } from "node:internal/intrinsics";
import { validateInteger, validateObject } from "node:internal/validators";
import httpAgent from "node:_http_agent";
const { Agent } = httpAgent;
import { ClientRequest } from "node:_http_client";
import { validateHeaderName, validateHeaderValue, parsers } from "node:_http_common";
const { IncomingMessage } = ___http_incoming;
import { OutgoingMessage } from "node:_http_outgoing";
import { Server, ServerResponse } from "node:_http_server";

const { METHODS, STATUS_CODES, setMaxHTTPHeaderSize, getMaxHTTPHeaderSize } = __internal_http;

if (process.env.NODE_DEBUG) __util.debuglog("http");

const { WebSocket, CloseEvent, MessageEvent } = globalThis;

function createServer(options, callback) {
  return new Server(options, callback);
}

/**
 * Makes an HTTP request.
 * @param {string | URL} url
 * @param {HTTPRequestOptions} [options]
 * @param {Function} [cb]
 * @returns {ClientRequest}
 */
function request(url, options, cb) {
  return new ClientRequest(url, options, cb);
}

/**
 * Makes a `GET` HTTP request.
 * @param {string | URL} url
 * @param {HTTPRequestOptions} [options]
 * @param {Function} [cb]
 * @returns {ClientRequest}
 */
function get(url, options, cb) {
  const req = request(url, options, cb);
  req.end();
  return req;
}

const http_exports = {
  Agent,
  Server,
  METHODS,
  STATUS_CODES,
  createServer,
  ServerResponse,
  IncomingMessage,
  request,
  get,
  get maxHeaderSize() {
    return getMaxHTTPHeaderSize();
  },
  set maxHeaderSize(value) {
    setMaxHTTPHeaderSize(value);
  },
  validateHeaderName,
  validateHeaderValue,
  setMaxIdleHTTPParsers(max) {
    validateInteger(max, "max", 1);
    parsers.max = max;
  },
  setGlobalProxyFromEnv,
  // Assigning http.globalAgent must affect the agent used by http.request
  // (which reads it from the node:_http_agent module), like Node.js.
  get globalAgent() {
    return httpAgent.globalAgent;
  },
  set globalAgent(value) {
    httpAgent.globalAgent = value;
  },
  ClientRequest,
  OutgoingMessage,
  WebSocket,
  CloseEvent,
  MessageEvent,
};

function noopRestore() {}

// Port of Node.js's http.setGlobalProxyFromEnv() (lib/http.js):
// https://github.com/nodejs/node/blob/v26.3.0/lib/http.js
// Points the global http and
// https agents at the proxy servers configured through the given environment
// variables, returning a function that restores the previous agents.
// (The fetch() global dispatcher half is not applicable here.)
function setGlobalProxyFromEnv(env = process.env) {
  validateObject(env, "proxyEnv");
  const { parseProxyUrl, redactInvalidProxyUrl } = import.meta.require("node:internal/http");
  const httpProxy = parseProxyUrl(env, "http:");
  const httpsProxy = parseProxyUrl(env, "https:");

  if (httpProxy === null && httpsProxy === null) {
    return noopRestore;
  }

  if (httpProxy !== null && URL.canParse(httpProxy) === false) {
    throw $ERR_PROXY_INVALID_CONFIG(redactInvalidProxyUrl(httpProxy));
  }
  if (httpsProxy !== null && URL.canParse(httpsProxy) === false) {
    throw $ERR_PROXY_INVALID_CONFIG(redactInvalidProxyUrl(httpsProxy));
  }

  let originalHttpsAgent, originalHttpAgent;
  if (httpProxy !== null) {
    originalHttpAgent = httpAgent.globalAgent;
    httpAgent.globalAgent = new Agent({
      keepAlive: true,
      scheduling: "lifo",
      timeout: 5000,
      proxyEnv: env,
    });
  }
  if (httpsProxy !== null) {
    const https = import.meta.require("node:https").default;
    originalHttpsAgent = https.globalAgent;
    https.globalAgent = new https.Agent({
      keepAlive: true,
      scheduling: "lifo",
      timeout: 5000,
      proxyEnv: env,
    });
  }

  return function restore() {
    if (originalHttpAgent !== undefined) {
      httpAgent.globalAgent = originalHttpAgent;
    }
    if (originalHttpsAgent !== undefined) {
      import.meta.require("node:https").default.globalAgent = originalHttpsAgent;
    }
  };
}

export default http_exports;

export { Agent, Server, METHODS, STATUS_CODES, createServer, ServerResponse, IncomingMessage, request, get, validateHeaderName, validateHeaderValue, setGlobalProxyFromEnv, ClientRequest, OutgoingMessage, WebSocket, CloseEvent, MessageEvent };
const __export_globalAgent = http_exports.globalAgent;
const __export_maxHeaderSize = http_exports.maxHeaderSize;
const __export_setMaxIdleHTTPParsers = http_exports.setMaxIdleHTTPParsers;
export { __export_globalAgent as globalAgent, __export_maxHeaderSize as maxHeaderSize, __export_setMaxIdleHTTPParsers as setMaxIdleHTTPParsers };
