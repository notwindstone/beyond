// console.log of every kind of value (the expected output is Bun's).
class Point { x = 1; y = 2; }
class Empty {}
const circ: any = { name: "c" }; circ.self = circ;
const values: [string, unknown][] = [
  ["str", "hello"], ["num", 42], ["neg0", -0], ["float", 1.5], ["nan", NaN], ["big", 10n], ["bool", true], ["null", null], ["undef", undefined],
  ["sym", Symbol("s")], ["arr", [1, "two", null, undefined, [3, [4, [5, [6]]]]]], ["empty arr", []], ["sparse", [1, , 3]],
  ["obj", { a: 1, b: "x", c: { d: [1, 2] } }], ["empty obj", {}], ["nested", { a: { b: { c: { d: { e: 1 } } } } }],
  ["class", new Point()], ["empty class", new Empty()], ["map", new Map<any, any>([["a", 1], [2, { b: 3 }]])], ["set", new Set([1, "x"])],
  ["fn", function named() {}], ["arrow", () => 1], ["anon", function () {}], ["classref", Point], ["date", new Date(0)], ["regex", /ab+c/gi],
  ["long arr", Array.from({ length: 30 }, (_, i) => i)], ["long strs", ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccc", "dddddddddddddddddddddd"]],
  ["obj keys", { "a-b": 1, 3: 2, [Symbol("k")]: 3 }], ["str in arr", ["it's", 'say "hi"']], ["headers", new Headers({ "Content-Type": "text/plain" })],
  ["url", new URL("https://a.b/c?d=1")], ["usp", new URLSearchParams("a=1&b=2")], ["boxed", new Number(3)], ["nullproto", Object.create(null)],
  ["getter", { get g() { return 1; } }], ["weakmap", new WeakMap()], ["mixed arr", [{ a: 1 }, { b: 2 }]],
];
for (const [k, v] of values) { console.log(`--- ${k}`); console.log(v); }
console.log("--- multi"); console.log("a", 1, { x: 1 }, [2]);
console.log("--- fmt"); console.log("%s is %d years and %i, %f, %o %O %j %%", "Bob", 42.5, 42.5, 1.5, { a: 1 }, { b: 2 }, { c: 3 }, "extra");
console.log("--- response"); console.log(new Response("hi"));
console.log("--- request"); console.log(new Request("https://x.y/z"));
console.log(new Headers({ accept: "x", "X-Y": "z" }));
console.log([new Headers({ a: "1" })]);
console.log({ h: new Headers() });
console.log(new Response("hi", { status: 201, headers: { a: "b" } }));
console.log(new Request("https://x.y/z", { method: "POST", headers: { a: "b" }, body: "abc" }));
console.log(new URLSearchParams(""));
console.log({ u: new URL("https://a.b/") });
console.log(new AbortController());
console.log(new TextEncoder(), new TextDecoder());
console.log(setTimeout(() => {}, 1));
console.log(async function af() {}, function* gf() {}, class extends Array {}, Math.max);
console.log([1.5, -0, 2 ** 31, 1e21, 0.000001, 1e-7]);
console.log(new Map([[{ a: 1 }, [1, 2]]]));
console.log({ s: new Set([[1]]), m: new Map() });
console.log([function () {}, Symbol(), Symbol.iterator]);
console.log("%s|%s|%s|%s", 1.5, { a: 1 }, [1], null, "rest");
console.log("%d|%i|%f", "42.7", -3.9, "x");
console.log("a %c b", "color: red", "c");
console.log(new Error("e1").message, [new Error("inner")].length);
for (let n = 70; n <= 110; n += 4) {
  console.log(n, ["a".repeat(n - 30), "b".repeat(10), "c".repeat(10)]);
}
for (let n = 1; n <= 40; n += 3) console.log(Array.from({ length: n }, (_, i) => i * 1000));
console.log([[1, 2], [3, 4]]);
console.log({ a: [1, 2, 3], b: "x".repeat(90), c: [1] });
console.log(["x".repeat(85)]);
