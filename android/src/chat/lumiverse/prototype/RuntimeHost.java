package chat.lumiverse.prototype;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.res.AssetManager;
import android.net.Uri;
import org.json.JSONObject;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/** Shared launcher for the Java diagnostic host and the Tauri mobile plugin. */
public final class RuntimeHost {
    public interface Listener { void ready(String url); void failed(String message); }
    private final Context context;
    private final String host;
    private final Listener listener;
    private volatile Process runtime;
    private volatile boolean destroyed;
    private volatile String diagnosticsUrl;
    private final StringBuilder output = new StringBuilder();
    public RuntimeHost(Context context, String host, Listener listener) {
        this.context = context.getApplicationContext(); this.host = host; this.listener = listener;
    }
    public void start() { new Thread(this::startRuntime, "lumiverse-runtime").start(); }
    public synchronized void stop() { destroyed = true; if (runtime != null) runtime.destroy(); }
    public String diagnosticsUrl() { return diagnosticsUrl; }
    private File getFilesDir() { return context.getFilesDir(); }
    private File getCacheDir() { return context.getCacheDir(); }
    private AssetManager getAssets() { return context.getAssets(); }
    private ApplicationInfo getApplicationInfo() { return context.getApplicationInfo(); }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder();
        for (byte value : bytes) result.append(String.format("%02x", value & 255));
        return result.toString();
    }

    private File unpack(JSONObject manifest) throws Exception {
        String hash = manifest.getString("payloadSha256");
        if (!hash.matches("[a-f0-9]{64}")) throw new IOException("Invalid payload identifier");
        File runtimes = new File(getFilesDir(), "runtimes");
        File destination = new File(runtimes, hash);
        File complete = new File(destination, ".complete");
        if (complete.isFile()) return destination;
        runtimes.mkdirs();
        // Each process gets its own staging directory. Existing data is never replaced.
        File staging = Files.createTempDirectory(runtimes.toPath(), ".extract-").toFile();
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream raw = getAssets().open("payload.zip");
             java.security.DigestInputStream checked = new java.security.DigestInputStream(raw, digest);
             ZipInputStream zip = new ZipInputStream(checked)) {
            ZipEntry entry;
            byte[] buffer = new byte[65536];
            String prefix = staging.getCanonicalPath() + File.separator;
            while ((entry = zip.getNextEntry()) != null) {
                File file = new File(staging, entry.getName());
                if (!file.getCanonicalPath().startsWith(prefix)) throw new IOException("Unsafe archive path");
                if (entry.isDirectory()) { file.mkdirs(); continue; }
                file.getParentFile().mkdirs();
                try (OutputStream out = new FileOutputStream(file)) {
                    int count;
                    while ((count = zip.read(buffer)) != -1) out.write(buffer, 0, count);
                }
            }
            // ZipInputStream stops at the central directory; hash the remaining bytes too.
            while (checked.read(buffer) != -1) { }
        }
        if (!hex(digest.digest()).equals(hash)) throw new IOException("Packaged payload checksum failed");
        new File(staging, ".complete").createNewFile();
        if (destination.exists()) throw new IOException("Incomplete runtime directory; reinstall the prototype");
        Files.move(staging.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE);
        return destination;
    }

    private void startRuntime() {
        try {
            File debugAddress = new File(getCacheDir(), "lumiverse-runtime-url");
            Files.deleteIfExists(debugAddress.toPath());
            JSONObject manifest;
            try (InputStream input = getAssets().open("prototype.json")) {
                ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096]; int count;
                while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
                manifest = new JSONObject(bytes.toString("UTF-8"));
            }
            File root = unpack(manifest);
            File data = new File(getFilesDir(), "lumiverse/data"); data.mkdirs();
            File temp = new File(getCacheDir(), "tmp"); temp.mkdirs();
            File executable = new File(getApplicationInfo().nativeLibraryDir, "libbun.so");
            if (!executable.canExecute()) throw new IOException("Android did not install executable libbun.so");
            // libvips discovers codec plugins under VIPSHOME/lib. These are symlinks to
            // installed APK libraries; native code remains in Android's executable directory.
            File vipsHome = new File(getCacheDir(), "vips");
            File modules = new File(vipsHome, "lib/vips-modules-8.18"); modules.mkdirs();
            for (String codec : new String[] { "heif", "jxl" }) {
                File target = new File(getApplicationInfo().nativeLibraryDir, "libvips-" + codec + ".so");
                File link = new File(modules, "vips-" + codec + ".so");
                Files.deleteIfExists(link.toPath());
                if (target.isFile()) Files.createSymbolicLink(link.toPath(), target.toPath());
            }
            // Git and its HTTPS helper are installed executable APK libraries.
            // Only their conventional command-name symlinks live in writable storage.
            File gitBin = new File(getCacheDir(), "tools-bin"); gitBin.mkdirs();
            for (String name : new String[] { "git", "git-remote-http", "git-remote-https", "bun", "node" }) {
                File target = new File(getApplicationInfo().nativeLibraryDir,
                    name.equals("git") ? "libgit.so" : (name.equals("bun") || name.equals("node")) ? "libbun.so" : "libgitremotehttp.so");
                File link = new File(gitBin, name);
                Files.deleteIfExists(link.toPath());
                if (target.isFile()) Files.createSymbolicLink(link.toPath(), target.toPath());
            }
            File gitTemplates = new File(getCacheDir(), "git-templates"); gitTemplates.mkdirs();
            byte[] secret = new byte[32]; new SecureRandom().nextBytes(secret);
            ProcessBuilder builder = new ProcessBuilder(executable.getAbsolutePath(), "--no-env-file", "--smol",
                new File(root, "android/runtime.ts").getAbsolutePath());
            builder.directory(root).redirectErrorStream(true);
            Map<String, String> env = builder.environment();
            env.put("DATA_DIR", data.getAbsolutePath());
            env.put("LUMIVERSE_ANDROID_HOST", host);
            env.put("LUMIVERSE_FFMPEG_PATH", new File(getApplicationInfo().nativeLibraryDir, "libffmpeg.so").getAbsolutePath());
            env.put("LUMIVERSE_FFPROBE_PATH", new File(getApplicationInfo().nativeLibraryDir, "libffprobe.so").getAbsolutePath());
            env.put("LUMIVERSE_ANDROID_TOKEN", hex(secret));
            env.put("LUMIVERSE_BUNDLE_ID", manifest.getString("payloadSha256"));
            env.put("LUMIVERSE_BUN_METHOD", "direct");
            env.put("LUMIVERSE_BUN_PATH", executable.getAbsolutePath());
            env.put("LUMIVERSE_BUN_EXECUTABLE", executable.getAbsolutePath());
            env.put("LUMIVERSE_ANDROID_INSTALL_COMPAT", new File(getApplicationInfo().nativeLibraryDir, "libbuninstallcompat.so").getAbsolutePath());
            env.put("LUMIVERSE_NATIVE_DIR", getApplicationInfo().nativeLibraryDir);
            env.put("LD_LIBRARY_PATH", getApplicationInfo().nativeLibraryDir);
            env.put("VIPSHOME", vipsHome.getAbsolutePath());
            env.put("FONTCONFIG_FILE", new File(root, "android/fonts.conf").getAbsolutePath());
            env.put("XDG_CACHE_HOME", getCacheDir().getAbsolutePath());
            env.put("BUN_RUNTIME_TRANSPILER_CACHE_PATH", new File(getCacheDir(), "transpiler").getAbsolutePath());
            env.put("TMPDIR", temp.getAbsolutePath());
            env.put("GIT_EXEC_PATH", gitBin.getAbsolutePath());
            env.put("GIT_TEMPLATE_DIR", gitTemplates.getAbsolutePath());
            env.put("GIT_CONFIG_NOSYSTEM", "1");
            env.put("GIT_CONFIG_GLOBAL", new File(data, "gitconfig").getAbsolutePath());
            env.put("GIT_SSL_CAINFO", new File(root, "android/git-ca-bundle.pem").getAbsolutePath());
            env.put("GIT_TERMINAL_PROMPT", "0");
            env.put("GIT_PAGER", "cat");
            env.put("NODE_ENV", "production");
            env.put("PATH", gitBin.getAbsolutePath() + ":" + getApplicationInfo().nativeLibraryDir + ":/system/bin");
            synchronized (this) {
                if (destroyed) return;
                runtime = builder.start();
            }
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(runtime.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.startsWith("LUMIVERSE_ANDROID_READY ")) {
                        String url = line.substring("LUMIVERSE_ANDROID_READY ".length());
                        Uri uri = Uri.parse(url);
                        if (!"http".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost()))
                            throw new IOException("Invalid local runtime address");
                        if (!destroyed) {
                            diagnosticsUrl = url;
                            // Debug automation can inspect diagnostics without changing the visible page.
                            if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0)
                                Files.write(debugAddress.toPath(), url.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                            listener.ready(url);
                        }
                    } else {
                        synchronized (output) {
                            output.append(line).append('\n');
                            if (output.length() > 12000) output.delete(0, output.length() - 12000);
                        }
                    }
                }
            }
            int exit = runtime.waitFor();
            if (!destroyed) listener.failed("Runtime exited (" + exit + ")\n" + output);
        } catch (Exception error) {
            if (!destroyed) listener.failed("Prototype could not start: " + error + "\n" + output);
        }
    }

}
