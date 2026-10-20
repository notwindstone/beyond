//! Imports Bun's Node.js modules (src/js/node and src/js/internal of Bun's
//! repository) into Beyond's lib/node as ES modules.
//!
//! Bun's modules are not ES modules: they `require()` each other (string
//! literals only), export with `export default`, and use the engine's
//! intrinsics (`$isCallable`, `fn.$call`, `$ERR_INVALID_ARG_TYPE(...)`)
//! and natives (`$cpp("Path.cpp", "createNodePathBinding")`,
//! `$newRustFunction("node_os.rs", "...", 1)`), which Bun's build replaces.
//! This does the same for Beyond, editing the source in place (its text,
//! comments and types kept):
//!
//! - a `require("m")` is an import of `m`'s default export: a top-level
//!   `const x = require("m")` becomes `import x from "m"`, a top-level
//!   `const { a, b: c } = require("m")` becomes `import { a, b as c } from
//!   "m"` when `m`'s default export is an object of those bindings (which it
//!   then also exports by name), and any other `require("m")` a default
//!   import's binding;
//! - `x.$call(...)` and the like (`$apply`, a Map's `$get`, a promise's
//!   `$then`, ...) lose their `$`; `$debug(...)` and `$assert(...)` go; the
//!   other `$` names are imported from `node:internal/intrinsics`;
//! - a native is imported from `node:internal/bindings/<file>` (a stub that
//!   throws when used is written for each one not there yet).
//!
//! Usage: `bun-import <bun repository> <lib/node>`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};

use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::ast_visit::{Visit, walk};
use oxc::parser::Parser;
use oxc::semantic::{Semantic, SemanticBuilder};
use oxc::span::{GetSpan, SourceType};

/// Node's built-in modules (those a bare specifier names).
const NODE_BUILTINS: &[&str] = &[
    "_http_agent", "_http_client", "_http_common", "_http_incoming", "_http_outgoing", "_http_server",
    "_stream_duplex", "_stream_passthrough", "_stream_readable", "_stream_transform", "_stream_wrap",
    "_stream_writable", "_tls_common", "_tls_wrap", "assert", "assert/strict", "async_hooks", "buffer",
    "child_process", "cluster", "console", "constants", "crypto", "dgram", "diagnostics_channel", "dns",
    "dns/promises", "domain", "events", "fs", "fs/promises", "http", "http2", "https", "inspector",
    "inspector/promises", "module", "net", "os", "path", "path/posix", "path/win32", "perf_hooks", "process",
    "punycode", "querystring", "readline", "readline/promises", "repl", "stream", "stream/consumers",
    "stream/promises", "stream/web", "string_decoder", "sys", "timers", "timers/promises", "tls",
    "trace_events", "tty", "url", "util", "util/types", "v8", "vm", "wasi", "worker_threads", "zlib",
];

/// Beyond's globals that are bindings of its modules (crates/beyond's
/// GLOBALS): Bun's modules import those they use, rather than reading
/// globals the prelude defines after they run.
const GLOBAL_MODULES: &[(&str, &str)] = &[
    ("console", "beyond:console"),
    ("setTimeout", "beyond:timers"),
    ("setInterval", "beyond:timers"),
    ("clearTimeout", "beyond:timers"),
    ("clearInterval", "beyond:timers"),
    ("setImmediate", "beyond:timers"),
    ("clearImmediate", "beyond:timers"),
    ("TextEncoder", "beyond:encoding"),
    ("TextDecoder", "beyond:encoding"),
    ("TextEncoderStream", "beyond:encoding"),
    ("TextDecoderStream", "beyond:encoding"),
    ("Event", "beyond:events"),
    ("CustomEvent", "beyond:events"),
    ("EventTarget", "beyond:events"),
    ("AbortController", "beyond:events"),
    ("AbortSignal", "beyond:events"),
    ("crypto", "beyond:crypto"),
    ("structuredClone", "beyond:clone"),
    ("URL", "beyond:url"),
    ("URLSearchParams", "beyond:url"),
    ("Blob", "beyond:blob"),
    ("File", "beyond:blob"),
    ("FormData", "beyond:formdata"),
    ("Headers", "beyond:fetch"),
    ("Request", "beyond:fetch"),
    ("Response", "beyond:fetch"),
    ("fetch", "beyond:client"),
    ("process", "beyond:process"),
    ("Buffer", "beyond:node/buffer"),
    ("ReadableStream", "beyond:streams"),
    ("WritableStream", "beyond:streams"),
    ("TransformStream", "beyond:streams"),
];

/// Members whose `$` (a private name in Bun's engine) goes: the public
/// methods of the same name.
const PUBLIC_MEMBERS: &[&str] = &[
    "call", "apply", "get", "set", "has", "add", "delete", "clear", "forEach", "keys", "then", "charCodeAt",
    "resolve", "reject", "defineProperty",
];

/// Calls of natives: `$cpp(file, symbol)` and the like.
const NATIVE_CALLS: &[&str] =
    &["$cpp", "$rust", "$zig", "$newCppFunction", "$newRustFunction", "$newZigFunction", "$bindgenFn"];

/// Bun's modules Beyond writes itself (its output files are kept): glue that
/// Beyond does differently (node:path exports its binding's functions
/// directly rather than bound ones).
const HAND_WRITTEN: &[&str] = &["node/path.ts", "node/path.posix.ts", "node/path.win32.ts"];

/// A module of Bun's: its path under src/js, and its text.
struct Module {
    rel: String,
    text: String,
}

/// The module specifier Beyond knows a Bun module by: `node/fs.promises.ts`
/// is `node:fs/promises`, `internal/streams/utils.ts`
/// `node:internal/streams/utils`.
fn specifier_of(rel: &str) -> String {
    let stem = rel.rsplit_once('.').map_or(rel, |(s, _)| s);
    match stem.strip_prefix("node/") {
        Some(name) => format!("node:{}", name.replace('.', "/")),
        None => format!("node:{stem}"),
    }
}

/// Where a Bun module goes, under lib/node.
fn output_of(rel: &str) -> PathBuf {
    let (stem, ext) = rel.rsplit_once('.').unwrap();
    let name = match stem.strip_prefix("node/") {
        Some(name) => name.replace('.', "/"),
        None => stem.to_string(),
    };
    PathBuf::from(format!("{name}.{ext}"))
}

/// The specifier for Beyond of a `require()` in Bun's modules.
fn map_specifier(spec: &str) -> String {
    if let Some(rest) = spec.strip_prefix("internal/") {
        return format!("node:internal/{rest}");
    }
    if spec.starts_with("node:") {
        return spec.to_string();
    }
    if NODE_BUILTINS.contains(&spec) {
        return format!("node:{spec}");
    }
    match spec {
        "bun:jsc" => "node:internal/bun/jsc".into(),
        "bun:internal-for-testing" => "node:internal/bun/internal-for-testing".into(),
        s if s.ends_with("bun/sqlite.ts") => "node:internal/bun/sqlite".into(),
        s => s.to_string(),
    }
}

/// A name for a binding made of `s`.
fn ident_of(s: &str) -> String {
    let mut out: String = s.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' }).collect();
    if out.starts_with(|c: char| c.is_ascii_digit()) {
        out.insert(0, '_');
    }
    out
}

fn parse<'a>(alloc: &'a Allocator, m: &'a Module) -> Result<(&'a Program<'a>, Semantic<'a>), String> {
    let ty = if m.rel.ends_with(".ts") { SourceType::ts() } else { SourceType::mjs() };
    let ret = Parser::new(alloc, &m.text, ty.with_module(true)).parse();
    if !ret.diagnostics.is_empty() {
        return Err(format!("{}: {}", m.rel, ret.diagnostics[0]));
    }
    let program = alloc.alloc(ret.program);
    let sem = SemanticBuilder::new().build(program).semantic;
    Ok((program, sem))
}

/// Strips TypeScript's `as` and `satisfies` and parentheses.
fn bare<'b, 'a>(e: &'b Expression<'a>) -> &'b Expression<'a> {
    match e {
        Expression::TSAsExpression(t) => bare(&t.expression),
        Expression::TSSatisfiesExpression(t) => bare(&t.expression),
        Expression::TSNonNullExpression(t) => bare(&t.expression),
        Expression::ParenthesizedExpression(p) => bare(&p.expression),
        e => e,
    }
}

/// What a module's `export default { a, b: c }` (or `export default x`, `x`
/// a `const` of such an object) exports by name: (name, local binding).
fn named_exports(program: &Program, sem: &Semantic) -> Vec<(String, String)> {
    let scoping = sem.scoping();
    let root = scoping.root_scope_id();
    let mut default = None;
    for s in &program.body {
        if let Statement::ExportDefaultDeclaration(d) = s
            && let Some(e) = d.declaration.as_expression()
        {
            default = Some(bare(e));
        }
    }
    let Some(mut e) = default else { return Vec::new() };
    let mut out = Vec::new();
    // (`D.p = x` of a default export `D`: `p` is `x`.)
    if let Expression::Identifier(d) = e {
        for s in &program.body {
            if let Statement::ExpressionStatement(x) = s
                && let Expression::AssignmentExpression(a) = &x.expression
                && a.operator == AssignmentOperator::Assign
                && let AssignmentTarget::StaticMemberExpression(m) = &a.left
                && let Expression::Identifier(obj) = &m.object
                && obj.name == d.name
                && let Expression::Identifier(v) = bare(&a.right)
                && scoping.get_binding(root, v.name).is_some()
                && is_identifier(&m.property.name)
            {
                out.push((m.property.name.to_string(), v.name.to_string()));
            }
            // (`Object.defineProperties(D, { p: { value: x } })`.)
            if let Statement::ExpressionStatement(x) = s
                && let Expression::CallExpression(c) = &x.expression
                && let Expression::StaticMemberExpression(callee) = &c.callee
                && let Expression::Identifier(obj) = &callee.object
                && obj.name == "Object"
                && callee.property.name == "defineProperties"
                && c.arguments.len() == 2
                && let Some(Expression::Identifier(target)) = c.arguments[0].as_expression()
                && target.name == d.name
                && let Some(Expression::ObjectExpression(props)) = c.arguments[1].as_expression()
            {
                for p in &props.properties {
                    let ObjectPropertyKind::ObjectProperty(p) = p else { continue };
                    let (Some(key), Expression::ObjectExpression(desc)) = (p.key.static_name(), bare(&p.value)) else {
                        continue;
                    };
                    for dp in &desc.properties {
                        if let ObjectPropertyKind::ObjectProperty(dp) = dp
                            && dp.key.static_name().as_deref() == Some("value")
                            && let Expression::Identifier(v) = bare(&dp.value)
                            && scoping.get_binding(root, v.name).is_some()
                            && is_identifier(&key)
                        {
                            out.push((key.to_string(), v.name.to_string()));
                        }
                    }
                }
            }
        }
    }
    // (A `const` of the object.)
    if let Expression::Identifier(id) = e {
        for s in &program.body {
            if let Statement::VariableDeclaration(v) = s {
                for d in &v.declarations {
                    if let BindingPattern::BindingIdentifier(b) = &d.id
                        && b.name == id.name
                        && let Some(init) = &d.init
                    {
                        e = bare(init);
                    }
                }
            }
        }
    }
    let Expression::ObjectExpression(o) = e else { return out };
    for p in &o.properties {
        let ObjectPropertyKind::ObjectProperty(p) = p else { continue };
        if p.computed || p.kind != PropertyKind::Init || p.method {
            continue;
        }
        let Some(key) = p.key.static_name() else { continue };
        if key == "default" || !is_identifier(&key) {
            continue;
        }
        match bare(&p.value) {
            Expression::Identifier(v) if scoping.get_binding(root, v.name).is_some() => {
                out.push((key.to_string(), v.name.to_string()));
            }
            // (A native: the converted module's import of it.)
            Expression::CallExpression(c) => {
                if let Expression::Identifier(callee) = &c.callee
                    && NATIVE_CALLS.contains(&callee.name.as_str())
                    && let Some((_, _, local)) = native_of(c)
                {
                    out.push((key.to_string(), local));
                }
            }
            _ => {}
        }
    }
    out
}

/// A native's binding module, symbol and the local name of its import, if
/// `c` (a call of `$cpp`, `$newRustFunction`, ...) has literal arguments.
fn native_of(c: &CallExpression) -> Option<(String, String, String)> {
    let args: Vec<&str> = c
        .arguments
        .iter()
        .filter_map(|a| match a {
            Argument::StringLiteral(s) => Some(s.value.as_str()),
            _ => None,
        })
        .collect();
    if args.len() < 2 {
        return None;
    }
    let file = args[0].rsplit('/').next().unwrap();
    let module = ident_of(file.rsplit_once('.').map_or(file, |(s, _)| s));
    let symbol = ident_of(args[1]);
    let local = format!("__native_{module}_{symbol}");
    Some((module, symbol, local))
}

/// What a module exports by name (`export function f`, `export const x`,
/// `export { a as b }`): (name, local).
fn declared_exports(program: &Program) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for s in &program.body {
        match s {
            Statement::ExportDeclaration(e) => match &e.declaration {
                Declaration::FunctionDeclaration(f) => {
                    if let Some(id) = &f.id {
                        out.push((id.name.to_string(), id.name.to_string()));
                    }
                }
                Declaration::ClassDeclaration(c) => {
                    if let Some(id) = &c.id {
                        out.push((id.name.to_string(), id.name.to_string()));
                    }
                }
                Declaration::VariableDeclaration(v) => {
                    for d in &v.declarations {
                        if let BindingPattern::BindingIdentifier(b) = &d.id {
                            out.push((b.name.to_string(), b.name.to_string()));
                        }
                    }
                }
                _ => {}
            },
            Statement::ExportNamedDeclaration(e) => {
                for sp in &e.specifiers {
                    out.push((sp.exported.name().to_string(), sp.local.name().to_string()));
                }
            }
            _ => {}
        }
    }
    out
}

fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

/// The edits that make one module an ES module.
struct Conv<'s, 'a> {
    text: &'s str,
    sem: &'s Semantic<'a>,
    named: &'s HashMap<String, Vec<(String, String)>>,
    /// The modules with no default export: `require` of one is its
    /// namespace (as Bun's built-in modules have it).
    no_default: &'s HashSet<String>,
    edits: Vec<(u32, u32, String)>,
    /// `$` names to import from node:internal/intrinsics.
    intrinsics: BTreeSet<String>,
    /// Natives: (binding module, symbol, local name).
    natives: Vec<(String, String, String)>,
    /// Default imports: specifier → local name.
    defaults: BTreeMap<String, String>,
    /// Named imports: specifier → (name, local).
    imports: BTreeMap<String, Vec<(String, String)>>,
    /// Top-level statements replaced whole.
    skip: HashSet<u32>,
    /// What bindings natives need: (binding module, symbol, kind).
    needed: &'s mut BTreeSet<(String, String, String)>,
    /// How many functions the visitor is in: a `require()` in one is lazy.
    depth: u32,
}

impl<'a> Conv<'_, 'a> {
    fn unresolved(&self, id: &IdentifierReference) -> bool {
        let scoping = self.sem.scoping();
        id.reference_id.get().and_then(|r| scoping.get_reference(r).symbol_id()).is_none()
    }

    fn default_import(&mut self, spec: &str) -> String {
        if let Some(l) = self.defaults.get(spec) {
            return l.clone();
        }
        let local = format!("__{}", ident_of(spec.trim_start_matches("node:")));
        self.defaults.insert(spec.to_string(), local.clone());
        local
    }

    /// `require("m")`'s specifier, if `e` is one.
    fn require_of(&self, e: &Expression) -> Option<String> {
        let Expression::CallExpression(c) = bare(e) else { return None };
        self.require_call(c)
    }

    fn require_call(&self, c: &CallExpression) -> Option<String> {
        let Expression::Identifier(id) = &c.callee else { return None };
        if id.name != "require" || !self.unresolved(id) || c.arguments.len() != 1 {
            return None;
        }
        match &c.arguments[0] {
            Argument::StringLiteral(s) => Some(map_specifier(&s.value)),
            _ => None,
        }
    }

    /// A top-level `const x = require("m")` or `const { a, b: c } =
    /// require("m")`: imports.
    fn top_level(&mut self, s: &Statement) {
        // (`import x from` a module with no default export: its namespace.)
        if let Statement::ImportDeclaration(i) = s
            && let Some(specs) = &i.specifiers
            && let [ImportDeclarationSpecifier::ImportDefaultSpecifier(d)] = specs.as_slice()
            && self.no_default.contains(&map_specifier(&i.source.value))
        {
            self.edits.push((d.span.start, d.span.start, "* as ".into()));
            return;
        }
        let Statement::VariableDeclaration(v) = s else { return };
        if v.kind != VariableDeclarationKind::Const || v.declarations.len() != 1 {
            return;
        }
        let d = &v.declarations[0];
        let Some(spec) = d.init.as_ref().and_then(|e| self.require_of(e)) else { return };
        match &d.id {
            BindingPattern::BindingIdentifier(b) => {
                let star = if self.no_default.contains(&spec) { "* as " } else { "" };
                self.edits.push((v.span.start, v.span.end, format!("import {star}{} from {:?};", b.name, spec)));
                self.skip.insert(v.span.start);
            }
            BindingPattern::ObjectPattern(o) if o.rest.is_none() => {
                let named = self.named.get(&spec);
                let mut names = Vec::new();
                for p in &o.properties {
                    let (Some(key), BindingPattern::BindingIdentifier(local), false) =
                        (p.key.static_name(), &p.value, p.computed)
                    else {
                        return;
                    };
                    if !named.is_some_and(|n| n.iter().any(|(k, _)| *k == key)) {
                        return;
                    }
                    names.push((key.to_string(), local.name.to_string()));
                }
                let list: Vec<String> =
                    names.iter().map(|(k, l)| if k == l { k.clone() } else { format!("{k} as {l}") }).collect();
                self.edits.push((v.span.start, v.span.end, format!("import {{ {} }} from {:?};", list.join(", "), spec)));
                self.skip.insert(v.span.start);
            }
            _ => {}
        }
    }

    fn native(&mut self, callee: &str, c: &CallExpression) -> bool {
        let Some((module, symbol, local)) = native_of(c) else { return false };
        let kind = if callee.starts_with("$new") || callee == "$bindgenFn" { "function" } else { "value" };
        if !self.natives.iter().any(|(_, _, l)| *l == local) {
            self.natives.push((module.clone(), symbol.clone(), local.clone()));
        }
        self.needed.insert((module, symbol, kind.to_string()));
        self.edits.push((c.span.start, c.span.end, local));
        true
    }
}

impl<'a> Visit<'a> for Conv<'_, 'a> {
    fn visit_statement(&mut self, s: &Statement<'a>) {
        if self.skip.contains(&s.span().start) {
            return;
        }
        walk::walk_statement(self, s);
    }

    fn visit_expression_statement(&mut self, s: &ExpressionStatement<'a>) {
        if let Expression::CallExpression(c) = &s.expression
            && let Expression::Identifier(id) = &c.callee
            && (id.name == "$debug" || id.name == "$assert")
            && self.unresolved(id)
        {
            self.edits.push((s.span.start, s.span.end, String::new()));
            return;
        }
        walk::walk_expression_statement(self, s);
    }

    fn visit_call_expression(&mut self, c: &CallExpression<'a>) {
        if let Expression::Identifier(id) = &c.callee
            && self.unresolved(id)
        {
            let name = id.name.as_str();
            if let Some(spec) = self.require_call(c) {
                // (In a function, as Bun's: evaluated when it first runs.)
                let to = if self.depth > 0 && self.no_default.contains(&spec) {
                    format!("import.meta.require({spec:?})")
                } else if self.depth > 0 {
                    format!("import.meta.require({spec:?}).default")
                } else {
                    self.default_import(&spec)
                };
                self.edits.push((c.span.start, c.span.end, to));
                return;
            }
            if name == "$debug" || name == "$assert" {
                self.edits.push((c.span.start, c.span.end, "undefined".into()));
                return;
            }
            if NATIVE_CALLS.contains(&name) && self.native(name, c) {
                return;
            }
        }
        walk::walk_call_expression(self, c);
    }

    fn visit_function(&mut self, f: &Function<'a>, flags: oxc::semantic::ScopeFlags) {
        self.depth += 1;
        walk::walk_function(self, f, flags);
        self.depth -= 1;
    }

    fn visit_arrow_function_expression(&mut self, f: &ArrowFunctionExpression<'a>) {
        self.depth += 1;
        walk::walk_arrow_function_expression(self, f);
        self.depth -= 1;
    }

    fn visit_identifier_reference(&mut self, id: &IdentifierReference<'a>) {
        // (`if ($debug)`, `IS_BUN_DEVELOPMENT`: Bun's debug builds only. The
        // calls of $debug go whole.)
        if (id.name == "$debug" || id.name == "IS_BUN_DEVELOPMENT") && self.unresolved(id) {
            self.edits.push((id.span.start, id.span.end, "false".into()));
        } else if id.name.starts_with('$') && self.unresolved(id) {
            self.intrinsics.insert(id.name.to_string());
        } else if let Some((name, spec)) = GLOBAL_MODULES.iter().find(|(n, _)| *n == id.name.as_str())
            && self.unresolved(id)
            && !self.sem.scoping().get_reference(id.reference_id()).is_write()
            // (Not a type: `x: Buffer` where the module declares Buffer.)
            && self.sem.scoping().get_reference(id.reference_id()).is_value()
        {
            let names = self.imports.entry(spec.to_string()).or_default();
            if !names.iter().any(|(n, _)| n == name) {
                names.push((name.to_string(), name.to_string()));
            }
        }
    }

    fn visit_static_member_expression(&mut self, m: &StaticMemberExpression<'a>) {
        if let Some(name) = m.property.name.strip_prefix('$')
            && PUBLIC_MEMBERS.contains(&name)
        {
            self.edits.push((m.property.span.start, m.property.span.end, name.to_string()));
        }
        walk::walk_static_member_expression(self, m);
    }
}

/// Whether module text `t` has a default export.
fn has_default_export(t: &str) -> bool {
    t.lines().any(|l| l.starts_with("export default") || (l.starts_with("export {") && l.contains(" as default")))
}

/// The ES module of Bun module `m`.
fn convert(
    m: &Module,
    named: &HashMap<String, Vec<(String, String)>>,
    no_default: &HashSet<String>,
    public: Option<&Vec<String>>,
    needed: &mut BTreeSet<(String, String, String)>,
) -> Result<String, String> {
    let alloc = Allocator::default();
    let (program, sem) = parse(&alloc, m)?;
    let mut conv = Conv {
        text: &m.text,
        sem: &sem,
        named,
        no_default,
        edits: Vec::new(),
        intrinsics: BTreeSet::new(),
        natives: Vec::new(),
        defaults: BTreeMap::new(),
        imports: BTreeMap::new(),
        skip: HashSet::new(),
        needed,
        depth: 0,
    };
    for s in &program.body {
        conv.top_level(s);
    }
    conv.visit_program(program);
    let _ = conv.text;

    // The imports, before the first statement (after the leading comments).
    let mut head = String::new();
    for (spec, local) in &conv.defaults {
        let star = if no_default.contains(spec) { "* as " } else { "" };
        head.push_str(&format!("import {star}{local} from {spec:?};\n"));
    }
    for (spec, names) in &conv.imports {
        let list: Vec<String> = names.iter().map(|(k, l)| if k == l { k.clone() } else { format!("{k} as {l}") }).collect();
        head.push_str(&format!("import {{ {} }} from {spec:?};\n", list.join(", ")));
    }
    for (module, symbol, local) in &conv.natives {
        head.push_str(&format!("import {{ {symbol} as {local} }} from \"node:internal/bindings/{module}\";\n"));
    }
    let intrinsics: Vec<&String> = conv.intrinsics.iter().filter(|n| *n != "$debug" && *n != "$assert").collect();
    if !intrinsics.is_empty() {
        let list: Vec<&str> = intrinsics.iter().map(|s| s.as_str()).collect();
        head.push_str(&format!("import {{ {} }} from \"node:internal/intrinsics\";\n", list.join(", ")));
    }
    let at = program.body.first().map_or(m.text.len() as u32, |s| s.span().start);
    if !head.is_empty() {
        conv.edits.push((at, at, head));
    }

    // What `export default {...}` exports by name too.
    let mut tail = String::new();
    let mut exported: HashSet<String> = declared_exports(program).into_iter().map(|(k, _)| k).collect();
    if let Some(list) = named.get(&specifier_of(&m.rel)) {
        let declared: HashSet<String> = program
            .body
            .iter()
            .filter_map(|s| match s {
                Statement::ExportNamedDeclaration(e) => Some(e),
                _ => None,
            })
            .flat_map(|e| e.specifiers.iter().map(|s| s.exported.name().to_string()))
            .chain(declared_exports(program).into_iter().map(|(k, _)| k))
            .collect();
        let list: Vec<String> = list
            .iter()
            .filter(|(k, _)| !declared.contains(k))
            .map(|(k, l)| if k == l { k.clone() } else { format!("{l} as {k}") })
            .collect();
        if !list.is_empty() {
            tail = format!("\nexport {{ {} }};\n", list.join(", "));
        }
        exported.extend(named[&specifier_of(&m.rel)].iter().map(|(k, _)| k.clone()));
    }

    // A built-in module's other names (Bun's: what its default export has),
    // read from its default export once the module has run.
    if let Some(public) = public {
        let missing: Vec<&String> = public.iter().filter(|n| !exported.contains(*n) && is_identifier(n)).collect();
        if !missing.is_empty() {
            let handle = default_handle(program, &mut conv.edits);
            if let Some(handle) = handle {
                for n in &missing {
                    tail.push_str(&format!("const __export_{n} = {handle}.{n};\n"));
                }
                let list: Vec<String> = missing.iter().map(|n| format!("__export_{n} as {n}")).collect();
                tail.push_str(&format!("export {{ {} }};\n", list.join(", ")));
            }
        }
    }

    let mut edits = conv.edits;
    edits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    let mut out = m.text.clone();
    let mut last = u32::MAX;
    for (start, end, text) in edits {
        // (Edits inside one already made are of what it replaced.)
        if end > last {
            continue;
        }
        out.replace_range(start as usize..end as usize, &text);
        last = start;
    }
    out.push_str(&tail);
    Ok(out)
}

/// A name for the module's default export: the identifier it exports, or
/// `__default`, a `const` its `export default <expression>` becomes.
fn default_handle(program: &Program, edits: &mut Vec<(u32, u32, String)>) -> Option<String> {
    for s in &program.body {
        let Statement::ExportDefaultDeclaration(d) = s else { continue };
        return match &d.declaration {
            ExportDefaultDeclarationKind::FunctionDeclaration(f) => f.id.as_ref().map(|id| id.name.to_string()),
            ExportDefaultDeclarationKind::ClassDeclaration(c) => c.id.as_ref().map(|id| id.name.to_string()),
            k => {
                let e = k.as_expression()?;
                if let Expression::Identifier(id) = bare(e) {
                    return Some(id.name.to_string());
                }
                edits.push((d.span.start, e.span().start, "const __default = ".into()));
                edits.push((d.span.end, d.span.end, "\nexport default __default;".into()));
                Some("__default".into())
            }
        };
    }
    None
}

/// A stub of a binding module: each symbol a native Beyond does not have
/// yet, which throws when used.
fn stub(module: &str, symbols: &[(String, String)]) -> String {
    let mut s = format!(
        "// Natives of Bun's {module} that Beyond does not have yet: each throws\n// when used.\n\nimport {{ $nativeStub }} from \"node:internal/intrinsics\";\n\n"
    );
    for (sym, _kind) in symbols {
        s.push_str(&format!("export const {sym}: any = $nativeStub({module:?}, {sym:?});\n"));
    }
    s
}

fn collect(dir: &Path, base: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect(&p, base, out);
        } else if p.extension().is_some_and(|x| x == "ts" || x == "js") && !p.to_string_lossy().ends_with(".d.ts") {
            out.push(p.strip_prefix(base).unwrap().to_path_buf());
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: bun-import <bun repository> <lib/node> [module...]");
        std::process::exit(2);
    }
    let js = Path::new(&args[1]).join("src/js");
    let out = PathBuf::from(&args[2]);
    let only: Vec<&String> = args[3..].iter().collect();
    let mut files = Vec::new();
    collect(&js.join("node"), &js, &mut files);
    collect(&js.join("internal"), &js, &mut files);
    files.sort();
    let modules: Vec<Module> = files
        .iter()
        .map(|f| Module {
            rel: f.to_string_lossy().into_owned(),
            text: std::fs::read_to_string(js.join(f)).unwrap(),
        })
        .collect();

    // The named exports of each module, and which have no default export.
    let mut named = HashMap::new();
    let mut no_default = HashSet::new();
    for m in &modules {
        if !has_default_export(&m.text) {
            no_default.insert(specifier_of(&m.rel));
        }
        let alloc = Allocator::default();
        match parse(&alloc, m) {
            Ok((program, sem)) => {
                named.insert(specifier_of(&m.rel), named_exports(program, &sem));
            }
            Err(e) => eprintln!("{e}"),
        }
    }

    // (And of the modules written for Beyond: what they export by name.)
    for spec in NODE_BUILTINS.iter().map(|b| format!("node:{b}")) {
        if named.contains_key(&spec) {
            continue;
        }
        let path = out.join(format!("{}.ts", spec.trim_start_matches("node:")));
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        if !has_default_export(&text) {
            no_default.insert(spec.clone());
        }
        let m = Module { rel: path.to_string_lossy().into_owned(), text };
        let alloc = Allocator::default();
        if let Ok((program, _)) = parse(&alloc, &m) {
            named.insert(spec, declared_exports(program));
        }
    }

    // The names Bun's built-in modules export (exports.json: their ES
    // module namespaces in Bun 1.4.3).
    let public: serde_json::Value =
        serde_json::from_str(include_str!("../exports.json")).expect("exports.json");
    let public: HashMap<String, Vec<String>> = public
        .as_object()
        .unwrap()
        .iter()
        .filter_map(|(k, v)| {
            Some((format!("node:{k}"), v.as_array()?.iter().filter_map(|n| n.as_str().map(String::from)).collect()))
        })
        .collect();

    let mut needed = BTreeSet::new();
    let mut failed = 0;
    for m in &modules {
        let spec = specifier_of(&m.rel);
        if (!only.is_empty() && !only.iter().any(|o| **o == spec)) || HAND_WRITTEN.contains(&m.rel.as_str()) {
            continue;
        }
        match convert(m, &named, &no_default, public.get(&spec), &mut needed) {
            Ok(text) => {
                let path = out.join(output_of(&m.rel));
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(&path, text).unwrap();
            }
            Err(e) => {
                eprintln!("{e}");
                failed += 1;
            }
        }
    }

    // Stubs of the natives not there yet.
    let mut by_module: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
    for (module, symbol, kind) in &needed {
        by_module.entry(module.clone()).or_default().push((symbol.clone(), kind.clone()));
    }
    for (module, symbols) in &by_module {
        let path = out.join(format!("internal/bindings/{module}.ts"));
        if path.exists() {
            let have = std::fs::read_to_string(&path).unwrap();
            let missing: Vec<&(String, String)> =
                symbols.iter().filter(|(s, _)| !have.contains(&format!("export const {s}")) && !have.contains(&format!("export function {s}"))).collect();
            if !missing.is_empty() {
                eprintln!("{}: missing {:?}", path.display(), missing.iter().map(|m| &m.0).collect::<Vec<_>>());
            }
            continue;
        }
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, stub(module, symbols)).unwrap();
    }
    eprintln!("{} modules, {} failed, {} binding modules", modules.len(), failed, by_module.len());
}
