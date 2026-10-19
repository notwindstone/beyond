import { b } from "./b.ts";
import data from "./d.json";
import text from "./t.txt";
import virt from "virtual:hello";
import { join } from "node:path";
import { used } from "pure-lib";
import "effects-lib";

export const a: number = b + 1;

export function unusedFunction(): string {
  return "never in the bundle";
}

export default function main() {
  return [a, data.x, text.trim(), virt, join("x", "y"), used(), VERSION];
}
