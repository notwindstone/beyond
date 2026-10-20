import re, sys, os
src_dir, out_dir = sys.argv[1], sys.argv[2]
imp = re.compile(r"^import\s+(.*?)\s+from\s+['\"]([^'\"]+)['\"]\s*;?\s*$", re.M | re.S)
bare = re.compile(r"^import\s+['\"]([^'\"]+)['\"]\s*;?\s*$", re.M)
def spec(s):
    s = s.replace("../common/index.mjs", "../common/index.js").replace("../common/fixtures.mjs", "../common/fixtures.js")
    return s
def conv_clause(clause, mod):
    clause = clause.strip()
    out = []
    m = re.match(r"^\*\s+as\s+(\w+)$", clause)
    if m:
        return f"const {m.group(1)} = require('{mod}');"
    default = None
    named = None
    m = re.match(r"^(\w+)\s*,\s*(\{.*\})$", clause, re.S)
    if m:
        default, named = m.group(1), m.group(2)
    elif clause.startswith("{"):
        named = clause
    else:
        m2 = re.match(r"^(\w+)\s*,\s*\*\s+as\s+(\w+)$", clause)
        if m2:
            return f"const {m2.group(1)} = require('{mod}'); const {m2.group(2)} = require('{mod}');"
        default = clause
    if default:
        out.append(f"const {default} = (m => m && m.__esModule && 'default' in m ? m.default : m)(require('{mod}'));")
    if named:
        inner = named.strip()[1:-1]
        parts = [p.strip() for p in inner.split(",") if p.strip()]
        parts = [re.sub(r"^(\w+)\s+as\s+(\w+)$", r"\1: \2", p) for p in parts]
        out.append("const { " + ", ".join(parts) + f" }} = require('{mod}');")
    return " ".join(out)
for name in sorted(os.listdir(src_dir)):
    if not (name.startswith("test-fs-") and name.endswith(".mjs")):
        continue
    text = open(os.path.join(src_dir, name)).read()
    text = bare.sub(lambda m: f"require('{spec(m.group(1))}');", text)
    text = imp.sub(lambda m: conv_clause(m.group(1), spec(m.group(2))), text)
    text = re.sub(r"await import\(('[^']*')\)", lambda m: "require(" + spec(m.group(1)) + ")", text)
    text = text.replace("import.meta.url", "require('url').pathToFileURL(__filename).href")
    text = text.replace("import.meta.dirname", "__dirname").replace("import.meta.filename", "__filename")
    text = re.sub(r"^export\s+", "", text, flags=re.M)
    if re.search(r"^\s*(await |for await)|[=(,]\s*await ", text, re.M):
        # top-level await: the body in an async function
        lines = text.split("\n")
        req = [l for l in lines if l.startswith("const ") and "require(" in l]
        rest = [l for l in lines if not (l.startswith("const ") and "require(" in l)]
        text = "\n".join(req) + "\n(async () => {\n" + "\n".join(rest) + "\n})().then(undefined, (e) => { console.error(e); process.exit(1); });\n"
    open(os.path.join(out_dir, name[:-4] + ".js"), "w").write("'use strict';\n" + text)
