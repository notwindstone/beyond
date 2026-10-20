import { Bun__createNodeURLBinding as __native_NodeURL_Bun__createNodeURLBinding } from "node:internal/bindings/NodeURL";
const [domainToASCII, domainToUnicode, idnaToASCII] = __native_NodeURL_Bun__createNodeURLBinding;

function urlToHttpOptions(url) {
  const options = {
    __proto__: null,
    ...url,
    protocol: url.protocol,
    hostname:
      typeof url.hostname === "string" && url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ""}${url.search || ""}`,
    href: url.href,
  };
  const port = url.port;
  if (port !== "") {
    options.port = Number(port);
  }
  const username = url.username;
  let password;
  if (username || (password = url.password)) {
    options.auth = `${decodeURIComponent(username)}:${decodeURIComponent(password ?? url.password)}`;
  }
  return options;
}

export default {
  domainToASCII,
  domainToUnicode,
  idnaToASCII,
  urlToHttpOptions,
};

export { domainToASCII, domainToUnicode, idnaToASCII, urlToHttpOptions };
