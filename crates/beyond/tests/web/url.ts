const show = (p: URLSearchParams) => JSON.stringify([...p]);
const p = new URLSearchParams("?a=1&b=2+3&a=%20x&c&=v&d=%zz&e=%C3%A9&&");
console.log(show(p), p.size, p.toString());
console.log(p.get("a"), JSON.stringify(p.getAll("a")), p.has("c"), p.has("a", "1"), p.has("a", "9"), p.get("zz"));
p.append("f", "x y&z=é/~!'()*");
p.set("a", "new");
p.delete("b");
p.delete("a", "nope");
console.log(p.toString());
p.sort();
console.log(p.toString());
console.log(show(new URLSearchParams({ x: "1", y: "2" })), show(new URLSearchParams([["k", "v"], ["k", "w"]])));
console.log(show(new URLSearchParams(new URLSearchParams("q=1"))));
try { new URLSearchParams([["only"]] as any); } catch (e: any) { console.log(e.name); }
const u = new URL("https://example.com/path?x=1#frag");
u.searchParams.append("y", "a b");
console.log(u.href, u.search);
u.search = "?z=9";
console.log(u.searchParams.get("z"), u.searchParams.get("x"));
u.searchParams.delete("z");
console.log(u.href);
u.href = "http://user:pa%3Ass@[::1]:8080/a/../b/./c?q#h";
console.log(u.href, u.origin, u.host, u.hostname, u.port, u.username, u.password, u.pathname, u.searchParams.get("q"));
const keys: string[] = [];
const it = new URLSearchParams("a=1&b=2&c=3");
it.forEach((v, k, self) => { keys.push(k + v); if (k === "a") self.delete("b"); });
console.log(keys.join());
console.log(URL.canParse("nope"), URL.canParse("/x", "https://a.b"), URL.parse("bad"), String(URL.parse("/p?q", "http://h")));
console.log(JSON.stringify({ u: new URL("http://a/b") }), new URL("http://a/b").toString());
console.log(new URL("file:///C:/x/../y").href, new URL("blob:https://a.b:8/x").origin, new URL("data:text/plain,hi").origin);
console.log(new URL("http://EXAMPLE.com:80/%7e?%7e#%7e").href, new URL("http://0x7f.1/").host, new URL("http://[0:0::1:0:0]/").host);
console.log(new URL("http://ü.example/ä?ö#ü").href);
try { new URL("http://a:99999"); } catch (e: any) { console.log(e.name, e.code); }
// The fast path's cases (credentials, ports, dot segments, "%", case),
// each as its parts and after a change.
const fast = [
  "https://user:pass@sub.example.com:8080/p/a/t/h?query=string#hash",
  "http://user@h/", "http://user:@h/", "http://:pass@h/", "http://:@h/", "http://@h/", "http://u:p:q@h/",
  "http://a@b@c/", "http://u;x@h/", "http://u=x@h/", "http://u%41:p%zz@h/", "http://user@/", "http://u:p@h:81",
  "http://h:/", "http://h:0/", "http://h:080/", "http://h:80/", "https://h:443", "http://h:65535/", "http://h:65536/",
  "http://h:8a/", "http://h:1:2/", "http://h", "http://h?q", "http://h#f", "http://h/?", "http://h/#", "http://h/a?b#c?d#e",
  "http://h/a/./b/../c", "http://h/a/..", "http://h/a/.", "http://h/..", "http://h/../../x", "http://h/%2e/x/%2E%2e/y",
  "http://h/.%2e/z", "http://h/%2e./z", "http://h/a/%2e", "http://h/.a/..b/a.", "http://h/a//b/", "http://h/%7E%zz?%7e#%",
  "http://h%41/", "http://H.Example.COM/A", "HTTPS://h/", "hTtP://h/", "ws://h:80/", "wss://h:443/x", "ftp://h:21/",
  "http://1.2.3.4/", "http://1.2.3.04/", "http://01.2.3.4/", "http://1.2.3.256/", "http://1.2.3/", "http://h.1/",
  "http://h.example.1./", "http://a.b./c", "http://[::1]/", "http://h/a b", "http://h/'x'", "http://h/?'x'",
];
for (const s of fast) {
  const u = URL.parse(s);
  if (u === null) {
    console.log(s, "invalid");
    continue;
  }
  console.log(s, u.href, u.protocol, u.username, u.password, u.host, u.port, u.pathname, u.search, u.hash);
  u.hash = "z";
  u.port = "99";
  console.log(" ", u.href, String(u));
}
console.log(new URL("/a/../b?c#d", "http://u:p@h:81/x").href, new URL("/%2e/q", "https://H/").href, new URL("//x/y", "http://h/").href);
