//! Puts the pinned default theme where `rust-embed` will find it, and in a
//! release build compresses the frontends' hashed assets ahead of time.
//!
//! The hub embeds a built theme, which `scripts/theme.sh` fetches. Running it
//! here lets a plain `cargo build` proceed without a setup step, taking its
//! input from `web-theme.pin` rather than a hand-maintained directory.

use std::fmt::Write as _;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::{env, fs};

fn main() {
    // Cargo reruns this only when one of these changes. The stamp is listed as
    // well, so deleting `target/theme` triggers a refetch rather than a later
    // failure inside rust-embed.
    println!("cargo:rerun-if-changed=web-theme.pin");
    println!("cargo:rerun-if-changed=target/theme/.pin");
    println!("cargo:rerun-if-changed=scripts/theme.sh");

    match Command::new("sh").arg("scripts/theme.sh").status() {
        Ok(status) if status.success() => {}
        Ok(status) => panic!("scripts/theme.sh failed ({status}); see the message above"),
        Err(e) => panic!("could not run scripts/theme.sh: {e}"),
    }

    // A debug build leaves both tables empty: rust-embed then reads every file
    // from disk, so a rebuilt panel is served without recompiling the hub. The
    // `packed_assets` cfg carries the same decision to `frontend.rs`, which
    // then leaves `assets/` out of rust-embed.
    let release = env::var_os("CARGO_CFG_DEBUG_ASSERTIONS").is_none();
    println!("cargo:rustc-check-cfg=cfg(packed_assets)");
    if release {
        println!("cargo:rustc-cfg=packed_assets");
    }
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let mut code = String::new();
    for (table, dist) in [("ADMIN", "web-admin/dist"), ("THEME", "target/theme/dist")] {
        let mut files = Vec::new();
        if release {
            println!("cargo:rerun-if-changed={dist}");
            list(Path::new(dist), "assets", &mut files);
        }
        // Sorted as strings, the order `frontend::packed` searches in; paths
        // compare by component, which puts `x/a.js` before `x-1.js`.
        files.sort();
        // The previous build's files carry other hashes and would accumulate.
        let _ = fs::remove_dir_all(out.join(table));
        writeln!(code, "pub static {table}: &[(&str, Body)] = &[").expect("String");
        for name in files {
            let source = Path::new(dist).join(&name).canonicalize().expect("listed file");
            let body = pack(&source, &out.join(table).join(&name));
            writeln!(code, "    ({name:?}, {body}),").expect("String");
        }
        writeln!(code, "];").expect("String");
    }
    fs::write(out.join("packed.rs"), code).expect("write packed.rs");
}

/// Every file below `dir`/`relative`, named as a request names it: the path
/// from `dir` with `/` between components. A frontend that has not been built
/// has no directory and contributes nothing.
fn list(dir: &Path, relative: &str, files: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir.join(relative)) else { return };
    for entry in entries {
        let entry = entry.expect("read_dir entry");
        let name = entry.file_name().into_string().expect("asset names are UTF-8");
        let path = format!("{relative}/{name}");
        if entry.file_type().expect("file type").is_dir() {
            list(dir, &path, files);
        } else {
            files.push(path);
        }
    }
}

/// The table entry for one asset: its brotli and gzip forms written beside
/// `dest`, or the file as it is when gzip does not shrink it (small icons,
/// images already compressed). Each form is decompressed again and compared,
/// so an encoder fault fails the build rather than a visitor's page.
fn pack(source: &Path, dest: &Path) -> String {
    let data = fs::read(source).expect("read asset");
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    gz.write_all(&data).expect("gzip into memory");
    let gz = gz.finish().expect("gzip into memory");
    if gz.len() >= data.len() {
        return format!("Body::Plain(include_bytes!({source:?}))");
    }
    // Quality 11 with a 4 MiB window, the encoder's maximum without the
    // large-window extension browsers do not accept.
    let mut br = brotli::CompressorWriter::new(Vec::new(), 4096, 11, 22);
    br.write_all(&data).expect("brotli into memory");
    let br = br.into_inner();

    let mut back = Vec::new();
    flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut back).expect("gunzip");
    assert!(back == data, "gzip of {} does not decompress to the original", source.display());
    back.clear();
    brotli::Decompressor::new(&br[..], 4096).read_to_end(&mut back).expect("unbrotli");
    assert!(back == data, "brotli of {} does not decompress to the original", source.display());

    let (br_path, gz_path) =
        (PathBuf::from(format!("{}.br", dest.display())), PathBuf::from(format!("{}.gz", dest.display())));
    fs::create_dir_all(dest.parent().expect("dest has a parent")).expect("create out dir");
    fs::write(&br_path, br).expect("write .br");
    fs::write(&gz_path, gz).expect("write .gz");
    format!("Body::Packed {{ br: include_bytes!({br_path:?}), gzip: include_bytes!({gz_path:?}) }}")
}
