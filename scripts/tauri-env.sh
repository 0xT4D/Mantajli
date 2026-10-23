# Source before building the Tauri shell on the development machine:
#   source scripts/tauri-env.sh && (cd apps/desktop/src-tauri && cargo build)
# Rust (GNU) lives on D:, binutils from MSYS2 provide dlltool/windres, and a
# pass-through "gcc" shim stands in for the resource preprocessor.
export RUSTUP_HOME='D:\DevTools\rustup'
export CARGO_HOME='D:\DevTools\cargo'
export PATH="/d/DevTools/cargo/bin:/d/DevTools/winres-shim/bin:/d/DevTools/mingw-binutils/mingw64/bin:$PATH"
