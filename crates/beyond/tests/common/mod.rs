//! What the tests share: building a program with Beyond.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Once;

/// A directory of the test's own.
pub fn tempdir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("beyond-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Builds `app` into `exe` with `beyond build`, after the native core (a
/// static library, which `cargo test` does not build) next to `beyond`.
pub fn build(app: &Path, exe: &Path) {
    static RT: Once = Once::new();
    RT.call_once(|| {
        let mut cargo = Command::new(env!("CARGO"));
        cargo.args(["build", "-p", "beyond-rt"]);
        if !cfg!(debug_assertions) {
            cargo.arg("--release");
        }
        assert!(cargo.status().unwrap().success(), "building beyond-rt failed");
    });
    let st = Command::new(env!("CARGO_BIN_EXE_beyond")).arg("build").arg(app).arg("-o").arg(exe).status().unwrap();
    assert!(st.success(), "beyond build {} failed", app.display());
}

/// A file of the tests' (in crates/beyond/tests).
pub fn test_file(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join(path)
}
