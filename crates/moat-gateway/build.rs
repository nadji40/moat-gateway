//! Tells the gateway which database migration is the newest, so the version
//! it refuses to start without is read from `migrations/` rather than kept
//! by hand in `storage.rs`.

use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let newest = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading {}: {e}", dir.display()))
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let (number, _) = name.split_once('_')?;
            name.ends_with(".sql")
                .then(|| number.parse::<u32>().ok())
                .flatten()
        })
        .max()
        .unwrap_or_else(|| panic!("no NNNN_name.sql files in {}", dir.display()));
    println!("cargo:rustc-env=MOAT_LATEST_MIGRATION={newest}");
}
