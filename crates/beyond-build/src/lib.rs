//! `Beyond.build`'s bundler, and the transpiler of the modules a program
//! imports at run time: a library that a program loads (`dlopen`) the first
//! time it needs it, so that programs that do not keep their size.
//!
//! The bundler is Luminous's (a module graph merged into one module, its
//! top-level names kept apart, as Bun's scope hoisting does), with Bun's
//! resolution for a target, then TypeScript and JSX made JavaScript.
//!
//! The interface is C with JSON in and out: strings the caller frees with
//! `beyond_build_free`. A bundle is made on a thread of its own: each time
//! it resolves or loads a module it asks the program (`beyond_build_next`
//! returns the request), whose plugins answer (the next call passes the
//! answer), so plugins may be async: the program awaits them between calls.

use std::ffi::{CStr, CString, c_char, c_void};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread::JoinHandle;

use luminous_front::bundle::{self, Bundle, Embedding, Host, Kind, ResolveOptions, Resolved};
use oxc::allocator::Allocator;
use oxc::codegen::{Codegen, CodegenOptions, CommentOptions};
use oxc::parser::Parser;
use oxc::semantic::SemanticBuilder;
use oxc::span::SourceType;
use oxc::transformer::{TransformOptions, Transformer};
use oxc::transformer_plugins::{ReplaceGlobalDefines, ReplaceGlobalDefinesConfig};
use serde_json::{Value, json};

/// A JSON value as a string the caller frees.
fn out(v: Value) -> *mut c_char {
    CString::new(v.to_string()).unwrap_or_default().into_raw()
}

/// A JSON argument (null if absent or invalid).
///
/// # Safety
/// `p` is null or a NUL-terminated string.
unsafe fn input(p: *const c_char) -> Value {
    if p.is_null() {
        return Value::Null;
    }
    serde_json::from_slice(unsafe { CStr::from_ptr(p) }.to_bytes()).unwrap_or(Value::Null)
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn strings(v: &Value, key: &str) -> Vec<String> {
    v.get(key).and_then(Value::as_array).map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect()).unwrap_or_default()
}

/// Free a string this library returned.
///
/// # Safety
/// `p` is null or a string this library returned, not yet freed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_build_free(p: *mut c_char) {
    if !p.is_null() {
        drop(unsafe { CString::from_raw(p) });
    }
}

// ---- Transpiling ----

/// What `compile` does besides making JavaScript.
#[derive(Default)]
struct Options {
    /// `define`: (expression, its replacement's source).
    define: Vec<(String, String)>,
    /// Print without whitespace (`minify.whitespace`).
    minify_whitespace: bool,
}

impl Options {
    fn of(cfg: &Value) -> Options {
        let define = cfg
            .get("define")
            .and_then(Value::as_object)
            .map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect())
            .unwrap_or_default();
        let minify_whitespace = cfg.pointer("/minify/whitespace").and_then(Value::as_bool).unwrap_or(false);
        Options { define, minify_whitespace }
    }
}

/// The source type of a loader's modules.
fn source_type(loader: &str) -> SourceType {
    match loader {
        "tsx" => SourceType::tsx(),
        "jsx" => SourceType::jsx(),
        "js" => SourceType::mjs().with_jsx(false),
        _ => SourceType::ts(),
    }
    .with_module(true)
}

/// The loader of a path by its extension, among those that are code.
fn code_loader(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("tsx") => "tsx",
        Some("jsx") => "jsx",
        Some("js" | "mjs" | "cjs") => "js",
        _ => "ts",
    }
}

/// `source` (module `path` of `loader`) as JavaScript: types erased, JSX
/// made calls, `define`s replaced; with the comments `comments` keeps.
fn compile(source: &str, path: &Path, loader: &str, opts: &Options, comments: CommentOptions) -> Result<String, String> {
    let allocator = Allocator::default();
    let parsed = Parser::new(&allocator, source, source_type(loader)).parse();
    if !parsed.diagnostics.is_empty() {
        return Err(luminous_front::erase::render(parsed.diagnostics, source, path));
    }
    let mut program = parsed.program;
    let sem = SemanticBuilder::new().with_excess_capacity(2.0).with_check_syntax_error(true).build(&program);
    if !sem.diagnostics.is_empty() {
        return Err(luminous_front::erase::render(sem.diagnostics, source, path));
    }
    let scoping = sem.semantic.into_scoping();
    let options = TransformOptions::default();
    let ret = Transformer::new(&allocator, path, &options).build_with_scoping(scoping, &mut program);
    if !ret.diagnostics.is_empty() {
        return Err(luminous_front::erase::render(ret.diagnostics, source, path));
    }
    if !opts.define.is_empty() {
        let config = ReplaceGlobalDefinesConfig::new(&opts.define)
            .map_err(|d| d.into_iter().map(|e| e.to_string()).collect::<Vec<_>>().join("\n"))?;
        let _ = ReplaceGlobalDefines::new(&allocator, config).build(ret.scoping, &mut program);
    }
    let options = CodegenOptions {
        minify: opts.minify_whitespace,
        comments: if opts.minify_whitespace { CommentOptions::disabled() } else { comments },
        ..CodegenOptions::default()
    };
    Ok(Codegen::new().with_options(options).build(&program).code)
}

/// Transpile a module: `{ path, source, loader }` (loader `ts`, `tsx`,
/// `jsx` or `js`; by the path's extension if absent) to `{ code }`, or
/// `{ error }`.
///
/// # Safety
/// `request` is a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_build_transpile(request: *const c_char) -> *mut c_char {
    let req = unsafe { input(request) };
    let path = PathBuf::from(str_of(&req, "path"));
    let loader = match str_of(&req, "loader") {
        "" => code_loader(&path),
        l => l,
    };
    match compile(str_of(&req, "source"), &path, loader, &Options::of(&req), CommentOptions::default()) {
        Ok(code) => out(json!({ "code": code })),
        Err(e) => out(json!({ "error": e })),
    }
}

// ---- Resolution ----

/// Resolve `{ dir, spec, conditions, extensions, mainFields }` as the
/// bundler's default resolution does: `{ path }`, or `{ error }`.
///
/// # Safety
/// `request` is a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_build_resolve(request: *const c_char) -> *mut c_char {
    let req = unsafe { input(request) };
    let spec = str_of(&req, "spec");
    let opts = ResolveOptions {
        conditions: strings(&req, "conditions"),
        extensions: strings(&req, "extensions"),
        main_fields: strings(&req, "mainFields"),
    };
    match bundle::resolve_module(Path::new(str_of(&req, "dir")), spec, &opts) {
        Some(p) => out(json!({ "path": p.canonicalize().unwrap_or(p) })),
        None => out(json!({ "error": format!("Could not resolve: \"{spec}\"") })),
    }
}

// ---- Bundling ----

/// A bundle being made: the thread making it, and the two directions of
/// its conversation with the program.
struct Build {
    to_bundler: Option<Sender<String>>,
    from_bundler: Receiver<Value>,
    thread: Option<JoinHandle<()>>,
}

/// The `Host` whose answers are the program's: each question a request
/// `beyond_build_next` returns, each answer the next call's argument.
struct ProgramHost {
    tx: Sender<Value>,
    rx: Receiver<String>,
}

impl ProgramHost {
    fn ask(&mut self, request: Value) -> Result<Value, String> {
        self.tx.send(request).map_err(|_| "the build was abandoned".to_string())?;
        let answer = self.rx.recv().map_err(|_| "the build was abandoned".to_string())?;
        let v: Value = serde_json::from_str(&answer).map_err(|e| format!("invalid answer: {e}"))?;
        match v.get("error").and_then(Value::as_str) {
            Some(e) => Err(e.to_string()),
            None => Ok(v),
        }
    }
}

fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Script => "script",
        Kind::Json => "json",
        Kind::Text => "text",
        Kind::Bytes => "bytes",
    }
}

impl Host for ProgramHost {
    fn resolve(&mut self, from: &Path, spec: &str, dynamic: bool, attr: Option<&str>) -> Result<Resolved, String> {
        let a = self.ask(json!({ "op": "resolve", "from": from, "spec": spec, "dynamic": dynamic, "attr": attr }))?;
        if let Some(e) = a.get("external").and_then(Value::as_str) {
            return Ok(Resolved::External(e.to_string()));
        }
        Ok(Resolved::File(PathBuf::from(str_of(&a, "path"))))
    }

    fn load(&mut self, path: &Path, kind: Kind) -> Result<String, String> {
        let a = self.ask(json!({ "op": "load", "path": path, "kind": kind_name(kind) }))?;
        // (The file, as its extension says.)
        if a.get("default").and_then(Value::as_bool) == Some(true) {
            let bytes = std::fs::read(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
            return match kind {
                Kind::Script => {
                    let text = String::from_utf8(bytes).map_err(|_| format!("{}: not UTF-8 text", path.display()))?;
                    self.code(text, path, code_loader(path))
                }
                kind => bundle::synthesize_content(path, kind, bytes),
            };
        }
        let contents = str_of(&a, "contents").to_string();
        match str_of(&a, "loader") {
            "json" => bundle::synthesize_content(path, Kind::Json, contents.into_bytes()),
            "text" => bundle::synthesize_content(path, Kind::Text, contents.into_bytes()),
            "" => self.code(contents, path, code_loader(path)),
            loader => self.code(contents, path, loader),
        }
    }
}

impl ProgramHost {
    /// A module's code as the bundler takes it: TypeScript or JavaScript
    /// as is (types are erased once the modules are merged); JSX made
    /// JavaScript first.
    fn code(&self, text: String, path: &Path, loader: &str) -> Result<String, String> {
        match loader {
            "tsx" | "jsx" => compile(&text, path, loader, &Options::default(), CommentOptions::default()),
            "ts" | "js" | "mjs" | "cjs" | "mts" | "cts" => Ok(text),
            l => Err(format!("{}: loader \"{l}\" is not supported", path.display())),
        }
    }
}

/// What marks a module's path in the bundle before it is printed (a legal
/// comment, which printing keeps where it is).
const MODULE_MARK: &str = "//! @beyond-module ";

/// The bundle as JavaScript, as Bun's: each module's code after a comment
/// with its path (relative to `root`), types erased, `define`s replaced,
/// without the modules' comments but legal comments and annotations.
fn finish(b: &Bundle, root: &Path, opts: &Options) -> Result<String, String> {
    let mut source = String::with_capacity(b.source.len() + 64 * b.modules.len());
    let mut last = 0usize;
    for m in &b.modules {
        let start = m.start as usize;
        source.push_str(&b.source[last..start]);
        if !source.is_empty() && !source.ends_with('\n') {
            source.push('\n');
        }
        let shown = m.path.strip_prefix(root).unwrap_or(&m.path);
        source.push_str(&format!("{MODULE_MARK}{}\n", shown.display()));
        last = start;
    }
    source.push_str(&b.source[last..]);
    let stripped = luminous_front::marker::strip(&source).source;
    let path = b.modules.first().map_or_else(|| PathBuf::from("bundle.ts"), |m| m.path.clone());
    let comments = CommentOptions { normal: false, jsdoc: false, ..CommentOptions::default() };
    let code = compile(&stripped, &path, "ts", opts, comments)?;
    // (A module left with no code has no comment: the next one's is
    // where its code would be.)
    let mut out = String::with_capacity(code.len());
    let mut mark: Option<&str> = None;
    for line in code.split_inclusive('\n') {
        if let Some(rest) = line.trim_start().strip_prefix(MODULE_MARK) {
            mark = Some(rest);
            continue;
        }
        if let Some(m) = mark.take() {
            if !out.is_empty() && !out.ends_with("\n\n") {
                out.push('\n');
            }
            out.push_str("// ");
            out.push_str(m);
        }
        out.push_str(line);
    }
    Ok(out)
}

/// Start bundling `{ entry, root, define, minify }`; `beyond_build_next`
/// then returns its requests. The handle is freed by `beyond_build_close`.
///
/// # Safety
/// `config` is a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_build_bundle(config: *const c_char) -> *mut c_void {
    let cfg = unsafe { input(config) };
    let (req_tx, req_rx) = channel::<Value>();
    let (ans_tx, ans_rx) = channel::<String>();
    let thread = std::thread::Builder::new().name("beyond-build".into()).stack_size(256 << 20).spawn(move || {
        let opts = Options::of(&cfg);
        let mut host = ProgramHost { tx: req_tx.clone(), rx: ans_rx };
        let entry = PathBuf::from(str_of(&cfg, "entry"));
        let root = PathBuf::from(str_of(&cfg, "root"));
        let emb = Embedding { library: true, ..Embedding::default() };
        let result = bundle::bundle_host(&entry, &emb, &mut host)
            .and_then(|b| finish(&b, &root, &opts).map(|code| (code, b.warnings)));
        let msg = match result {
            Ok((code, warnings)) => json!({ "op": "done", "code": code, "warnings": warnings }),
            Err(e) => json!({ "op": "error", "message": e }),
        };
        let _ = req_tx.send(msg);
    });
    let (to_bundler, thread) = match thread {
        Ok(t) => (Some(ans_tx), Some(t)),
        Err(_) => (None, None),
    };
    Box::into_raw(Box::new(Build { to_bundler, from_bundler: req_rx, thread })) as *mut c_void
}

/// The bundle's next request (`{ op: "resolve", from, spec, dynamic, attr }`,
/// `{ op: "load", path, kind }`), or its end (`{ op: "done", code,
/// warnings }`, `{ op: "error", message }`); `answer` answers the last
/// request (null at first).
///
/// # Safety
/// `h` is a handle `beyond_build_bundle` returned, not closed; `answer` is
/// null or a NUL-terminated string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_build_next(h: *mut c_void, answer: *const c_char) -> *mut c_char {
    let b = unsafe { &mut *(h as *mut Build) };
    if !answer.is_null()
        && let Some(tx) = &b.to_bundler
    {
        let _ = tx.send(unsafe { CStr::from_ptr(answer) }.to_string_lossy().into_owned());
    }
    match b.from_bundler.recv() {
        Ok(v) => out(v),
        Err(_) => out(json!({ "op": "error", "message": "the bundler stopped" })),
    }
}

/// End a bundle (abandoning it if it is not done).
///
/// # Safety
/// `h` is a handle `beyond_build_bundle` returned, not closed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn beyond_build_close(h: *mut c_void) {
    let mut b = unsafe { Box::from_raw(h as *mut Build) };
    drop(b.to_bundler.take());
    // (Its next question fails: it ends.)
    while b.from_bundler.recv().is_ok() {}
    if let Some(t) = b.thread.take() {
        let _ = t.join();
    }
}
