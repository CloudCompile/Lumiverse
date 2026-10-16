// Android apps cannot create hard links in private app storage. Publish fully
// written staging files with renameat2(RENAME_NOREPLACE), preserving atomicity
// and AlreadyExists conflicts. Never fall back to an overwriting rename.
#[cfg(target_os = "android")]
fn android_rename_noreplace(from: &std::path::Path, to: &std::path::Path) -> io::Result<()> {
    use std::ffi::{CString, c_int, c_long};
    use std::os::unix::ffi::OsStrExt;
    unsafe extern "C" {
        fn syscall(number: c_long, ...) -> c_long;
    }
    #[cfg(target_arch = "aarch64")]
    const SYS_RENAMEAT2: c_long = 276;
    #[cfg(target_arch = "arm")]
    const SYS_RENAMEAT2: c_long = 382;
    #[cfg(target_arch = "x86_64")]
    const SYS_RENAMEAT2: c_long = 316;
    #[cfg(target_arch = "x86")]
    const SYS_RENAMEAT2: c_long = 353;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    // The syscall works on API 29; the named Bionic wrapper was added in API 30.
    let result = unsafe { syscall(SYS_RENAMEAT2, -100 as c_int, from.as_ptr(), -100 as c_int, to.as_ptr(), 1 as c_int) };
    if result == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}

fn platform_atomic_link(from: &std::path::Path, to: &std::path::Path) -> io::Result<()> {
    #[cfg(not(target_os = "android"))]
    { std::fs::hard_link(from, to) }
    #[cfg(target_os = "android")]
    {
        // Copy operations must retain their source. Create an exclusive staging
        // file, close it after the complete copy, then atomically publish it.
        let mut source = File::open(from)?;
        let mut id = 0;
        let (mut file, staged) = loop {
            let staged = staged_upload_path(to, &format!("android-copy-{id}"));
            match OpenOptions::new().write(true).create_new(true).open(&staged) {
                Ok(file) => break (file, staged),
                Err(error) if error.kind() == ErrorKind::AlreadyExists => id += 1,
                Err(error) => return Err(error),
            }
        };
        let result = (|| {
            io::copy(&mut source, &mut file)?;
            file.sync_all()?;
            drop(file);
            android_rename_noreplace(&staged, to)
        })();
        if result.is_err() { let _ = std::fs::remove_file(&staged); }
        result
    }
}
