// fs.read and fs.write, sync, callback and FileHandle: their arguments
// (the binding's fast path of a Uint8Array and int32 numbers, and the
// rest), bounds and errors.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { fresh } from "./h.ts";
const W = fresh();
const p = W + "/f.txt";
const peek = () => {
  const fd = fs.openSync(p, "r");
  const b = Buffer.alloc(12);
  const n = fs.readSync(fd, b, 0, 12, 0);
  const size = fs.fstatSync(fd).size;
  fs.closeSync(fd);
  return size + ":" + b.subarray(0, n).toString("latin1").replace(/\0/g, ".");
};
const err = (e: any) => "!! " + e.code + " " + e.message;
// (A fake Uint8Array's getters throw the engine's own message, for FileHandle.)
const fake = () => Object.create(Uint8Array.prototype);

const b8 = () => Buffer.alloc(8);
const reads: [string, () => any[]][] = [
  ["basic", () => [b8(), 0, 4, 0]], ["pos null", () => [b8(), 0, 4, null]], ["pos undef", () => [b8(), 0, 4]], ["pos -1", () => [b8(), 0, 2, -1]],
  ["pos big", () => [b8(), 0, 4, 2 ** 40]], ["pos bigint", () => [b8(), 0, 4, 3n]], ["pos -2", () => [b8(), 0, 4, -2]], ["pos 1.5", () => [b8(), 0, 4, 1.5]],
  ["len 0", () => [b8(), 0, 0, 0]], ["len over", () => [b8(), 0, 9, 0]], ["off+len over", () => [b8(), 6, 4, 0]], ["off over", () => [b8(), 9, 1, 0]],
  ["len neg", () => [b8(), 0, -1, 0]], ["len 1.5", () => [b8(), 0, 1.5, 0]], ["len str", () => [b8(), 0, "4", 0]], ["off neg", () => [b8(), -1, 4, 0]],
  ["empty buf", () => [Buffer.alloc(0), 0, 1, 0]], ["u16", () => [new Uint16Array(4), 0, 4, 0]], ["dataview", () => [new DataView(new ArrayBuffer(8)), 0, 4, 0]],
  ["fake u8", () => [fake(), 0, 4, 0]], ["opts", () => [b8(), { offset: 1, length: 3, position: 2 }]], ["u8 clamped", () => [new Uint8ClampedArray(8), 0, 4, 0]],
  ["off 2^31", () => [b8(), 2 ** 31, 4, 0]],
];
fs.writeFileSync(p, "0123456789abcdef");
let fd = fs.openSync(p, "r");
const content = (b: any) => (b instanceof Uint8Array ? Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1").replace(/\0/g, ".") : "");
for (const [n, a] of reads) {
  const args = a();
  try { console.log("readSync " + n, (fs.readSync as any)(fd, ...args), content(args[0])); } catch (e) { console.log("readSync " + n, err(e)); }
}
for (const [n, a] of [...reads, ["bad fd", () => [b8(), 0, 4, 0]] as [string, () => any[]]]) {
  const args = a();
  const f = n === "bad fd" ? 9999 : fd;
  await new Promise<void>((res) => {
    try { (fs.read as any)(f, ...args, (e: any, r: any) => { console.log("read cb " + n, e ? err(e) : r + " " + content(args[0])); res(); }); }
    catch (e) { console.log("read cb " + n, "throws", err(e)); res(); }
  });
}
fs.closeSync(fd);
let fh = await fsp.open(p, "r");
for (const [n, a] of reads) {
  if (n === "fake u8") continue;
  const args = a();
  try { const r = await (fh.read as any)(...args); console.log("fh.read " + n, r.bytesRead, content(r.buffer)); } catch (e) { console.log("fh.read " + n, err(e)); }
}
await fh.close();

const B = () => Buffer.from("ABCDEFGH");
const writes: [string, () => any[]][] = [
  ["basic", () => [B(), 0, 4, 0]], ["no pos", () => [B(), 0, 4]], ["pos null", () => [B(), 0, 4, null]], ["pos -1", () => [B(), 0, 2, -1]], ["pos -5", () => [B(), 0, 2, -5]],
  ["pos 2^31", () => [B(), 0, 2, 2 ** 31]], ["pos bigint", () => [B(), 0, 2, 3n]], ["pos 1.5", () => [B(), 0, 2, 1.5]], ["pos str", () => [B(), 0, 2, "3"]],
  ["len 0", () => [B(), 0, 0, 0]], ["len over", () => [B(), 0, 9, 0]], ["off+len over", () => [B(), 6, 4, 0]], ["off over", () => [B(), 9, 1, 0]], ["off = len", () => [B(), 8, 0, 0]],
  ["len neg", () => [B(), 0, -1, 0]], ["len 1.5", () => [B(), 0, 1.5, 0]], ["len bigint", () => [B(), 0, 2n, 0]], ["off neg", () => [B(), -1, 4, 0]], ["off 1.5", () => [B(), 1.5, 2, 0]],
  ["empty buf", () => [Buffer.alloc(0), 0, 0, 0]], ["empty buf len", () => [Buffer.alloc(0), 0, 1, 0]], ["u16", () => [new Uint16Array([65, 66, 67]), 0, 4, 0]],
  ["dataview", () => [new DataView(new ArrayBuffer(4)), 0, 4, 0]], ["fake u8", () => [fake(), 0, 4, 0]],
  ["only buf", () => [B()]], ["off only", () => [B(), 2]], ["str", () => ["hello", 0]], ["opts", () => [B(), { offset: 1, length: 2, position: 0 }]], ["u8c", () => [new Uint8ClampedArray([70, 71]), 0, 2, 0]],
];
const reset = () => { fs.writeFileSync(p, "0123456789"); return fs.openSync(p, "r+"); };
for (const [n, a] of writes) {
  fd = reset();
  try { console.log("writeSync " + n, (fs.writeSync as any)(fd, ...a()), peek()); } catch (e) { console.log("writeSync " + n, err(e)); }
  fs.closeSync(fd);
}
for (const [n, a] of writes) {
  fd = reset();
  await new Promise<void>((res) => {
    try { (fs.write as any)(fd, ...a(), (e: any, r: any) => { console.log("write cb " + n, e ? err(e) : r + " " + peek()); res(); }); }
    catch (e) { console.log("write cb " + n, "throws", err(e)); res(); }
  });
  fs.closeSync(fd);
}
for (const [n, a] of writes) {
  if (n === "fake u8") continue;
  fs.writeFileSync(p, "0123456789");
  fh = await fsp.open(p, "r+");
  try { const r = await (fh.write as any)(...a()); console.log("fh.write " + n, r.bytesWritten, peek()); } catch (e) { console.log("fh.write " + n, err(e)); }
  await fh.close();
}
