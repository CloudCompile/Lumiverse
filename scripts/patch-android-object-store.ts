import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nativeSha256 } from "./android-native";

export function patchAndroidObjectStore(upstream: string, destination: string, helper: string) {
  const path = join(destination, "src/local.rs");
  let source = readFileSync(join(upstream, "src/local.rs"), "utf8");
  // Exact pinned source; never patch a different object_store release silently.
  if ((source.match(/std::fs::hard_link\(&/g) || []).length !== 3) throw new Error("Unexpected object_store hard-link implementation");
  source = source.replaceAll("std::fs::hard_link(&", "platform_atomic_link(&");
  const old = `            // fall-back to copy & delete
            RenameTargetMode::Create => {
                self.copy_opts(
                    from,
                    to,
                    CopyOptions {
                        mode: CopyMode::Create,
                        extensions,
                    },
                )
                .await?;
                self.delete(from).await?;
                Ok(())
            }`;
  const replacement = `            RenameTargetMode::Create => {
                #[cfg(target_os = "android")]
                {
                    let _ = extensions;
                    let from = self.path_to_filesystem(from)?;
                    let to = self.path_to_filesystem(to)?;
                    maybe_spawn_blocking(move || {
                        loop {
                            match android_rename_noreplace(&from, &to) {
                                Ok(_) => return Ok(()),
                                Err(source) => match source.kind() {
                                    ErrorKind::AlreadyExists => return Err(Error::AlreadyExists {
                                        path: to.to_string_lossy().into_owned(), source,
                                    }.into()),
                                    ErrorKind::NotFound => match from.exists() {
                                        true => create_parent_dirs(&to, source)?,
                                        false => return Err(Error::NotFound { path: from, source }.into()),
                                    },
                                    _ => return Err(Error::UnableToCopyFile { from, to, source }.into()),
                                },
                            }
                        }
                    }).await
                }
                #[cfg(not(target_os = "android"))]
                {
                    self.copy_opts(from, to, CopyOptions { mode: CopyMode::Create, extensions }).await?;
                    self.delete(from).await?;
                    Ok(())
                }
            }`;
  if (!source.includes(old)) throw new Error("Unexpected object_store rename implementation");
  source = source.replace(old, replacement) + "\n" + readFileSync(helper, "utf8");
  if (!existsSync(path) || readFileSync(path, "utf8") !== source) {
    cpSync(upstream, destination, { recursive: true });
    writeFileSync(path, source);
  }
  return nativeSha256(Buffer.from(source));
}
