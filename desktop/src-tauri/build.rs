use std::path::PathBuf;
use std::process::Command;

fn git_output(args: &[&str]) -> Option<String> {
    Command::new("git")
        .args(args)
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// Stamp the commit this shell was compiled from.
///
/// The tray is a compiled binary living outside the checkout, so the runner's
/// git update flow cannot replace it the way it replaces server and frontend
/// code. Without a build stamp there is nothing to compare a moved checkout
/// against, and a shell that is several releases behind looks exactly like one
/// that is current.
fn stamp_build_revision() {
    let sha = git_output(&["rev-parse", "HEAD"]);

    // Builds from a source archive have no git metadata. Stamp an empty
    // revision rather than failing the build — the tray reads that as "cannot
    // tell" and stays silent instead of guessing.
    println!(
        "cargo:rustc-env=LUMIVERSE_DESKTOP_SHA={}",
        sha.clone().unwrap_or_default()
    );

    // Once a build script emits any rerun-if-changed, Cargo reruns it *only*
    // when those paths change. So the paths must be ones a fast-forward pull
    // actually touches. `.git/HEAD` is not one of them — on a branch it holds
    // `ref: refs/heads/<name>` and is untouched by a pull — and neither is the
    // `refs/` directory, whose mtime does not change when a file nested below
    // it is rewritten. Getting this wrong stamps the *previous* revision into
    // a binary compiled from new sources, which then reports itself stale.
    //
    // `index` is rewritten by every checkout and reset, including the runner's
    // `reset --hard` to upstream. Together with HEAD (branch switches) and
    // packed-refs (post-gc ref storage) it covers how a checkout moves.
    // Resolve the git dir rather than assuming `../../.git`, so a worktree —
    // where `.git` is a file pointing elsewhere — still gets real paths.
    if sha.is_some() {
        if let Some(git_dir) = git_output(&["rev-parse", "--git-dir"]) {
            let git_dir = PathBuf::from(git_dir);
            for entry in ["HEAD", "index", "packed-refs"] {
                println!("cargo:rerun-if-changed={}", git_dir.join(entry).display());
            }
        }
    }
}

fn main() {
    stamp_build_revision();
    tauri_build::build()
}
