use reqwest::{Client, Url};
use std::time::Duration;

pub fn normalize_server(value: &str, allow_loopback_http: bool) -> Result<Url, String> {
    if value.len() > 2048 { return Err("The server address is too long.".into()); }
    let url = Url::parse(value.trim()).map_err(|_| "Enter a complete server address, such as https://lumiverse.example.com.")?;
    let host = url.host_str().ok_or("The server address needs a hostname.")?;
    let loopback = matches!(host, "localhost" | "127.0.0.1" | "::1" | "[::1]");
    if url.scheme() != "https" && !(allow_loopback_http && loopback && url.scheme() == "http") {
        return Err("Use an HTTPS server address.".into());
    }
    if !url.username().is_empty() || url.password().is_some() || host.contains('*')
        || url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return Err("Enter the server's origin only, without a username, password, path, query, or fragment.".into());
    }
    Url::parse(&format!("{}/", url.origin().ascii_serialization())).map_err(|error| error.to_string())
}

pub fn is_connection_page(url: &Url) -> bool {
    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
        || (url.scheme() == "https" && url.host_str() == Some("tauri.localhost"))
}

pub fn navigation_allowed(url: &Url, selected: Option<&Url>) -> bool {
    is_connection_page(url) || selected.is_some_and(|server| {
        matches!(url.scheme(), "http" | "https") && url.origin() == server.origin()
            && url.username().is_empty() && url.password().is_none()
    })
}

/// Verify the public startup endpoint and the frontend without sending credentials
/// or following redirects to a different service.
pub async fn probe_server(server: &Url) -> Result<(), String> {
    let client = Client::builder().timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none()).build().map_err(|error| error.to_string())?;
    let mut response = client.get(server.join("api/v1/runtime-config").unwrap())
        .header("Accept", "application/json").send().await
        .map_err(|error| format!("Could not connect to the server: {error}"))?
        .error_for_status().map_err(|error| format!("The server's startup endpoint is unavailable: {error}"))?;
    if !response.status().is_success() { return Err("The server redirected its startup endpoint. Enter its final HTTPS address.".into()); }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
        if bytes.len() + chunk.len() > 16384 { return Err("The server returned an unexpected startup response.".into()); }
        bytes.extend_from_slice(&chunk);
    }
    let config: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "This address did not return Lumiverse startup configuration.")?;
    if !config.get("safeThemeMode").is_some_and(serde_json::Value::is_boolean) {
        return Err("This address does not appear to be a compatible Lumiverse server.".into());
    }
    let response = client.head(server.clone()).send().await.map_err(|error| error.to_string())?;
    let html = response.headers().get("content-type").and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(';').next().is_some_and(|mime| mime.trim().eq_ignore_ascii_case("text/html")));
    if !response.status().is_success() || !html {
        return Err("The server must serve the Lumiverse frontend at this address.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn probe_fixture(responses: Vec<String>) -> Result<(), String> {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let server = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let worker = std::thread::spawn(move || {
            for response in responses {
                let (mut stream, _) = listener.accept().unwrap();
                stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    assert_eq!(stream.read(&mut byte).unwrap(), 1);
                    request.push(byte[0]);
                    assert!(request.len() < 8192);
                }
                let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
                assert!(!request.contains("authorization:") && !request.contains("cookie:"));
                let _ = stream.write_all(response.as_bytes());
            }
        });
        let result = tauri::async_runtime::block_on(probe_server(&server));
        worker.join().unwrap();
        result
    }

    fn json_response(body: &str) -> String {
        format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}", body.len())
    }

    #[test]
    fn connection_probe_accepts_lumiverse_without_credentials() {
        assert!(probe_fixture(vec![json_response("{\"safeThemeMode\":false}"),
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".into()]).is_ok());
    }
    #[test]
    fn connection_probe_rejects_other_servers() {
        assert!(probe_fixture(vec![json_response("{\"safeThemeMode\":\"false\"}")]).is_err());
        assert!(probe_fixture(vec![json_response("<html>Proxy login</html>")]).is_err());
    }
    #[test]
    fn connection_probe_requires_a_frontend() {
        assert!(probe_fixture(vec![json_response("{\"safeThemeMode\":true}"),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".into()]).is_err());
    }
    #[test]
    fn connection_probe_refuses_redirects() {
        assert!(probe_fixture(vec!["HTTP/1.1 302 Found\r\nLocation: https://example.com/\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".into()]).is_err());
    }
    #[test]
    fn connection_probe_bounds_startup_response_size() {
        assert!(probe_fixture(vec![json_response(&" ".repeat(32768))]).is_err());
    }
    #[test]
    fn normalizes_origins_without_losing_nondefault_ports() {
        assert_eq!(normalize_server(" https://EXAMPLE.com:443/ ", false).unwrap().as_str(), "https://example.com/");
        assert_eq!(normalize_server("https://example.com:8443", false).unwrap().as_str(), "https://example.com:8443/");
        assert_eq!(normalize_server("https://[::1]:8443", false).unwrap().as_str(), "https://[::1]:8443/");
    }
    #[test]
    fn refuses_credentials_paths_and_non_https_servers() {
        for value in ["http://example.com", "https://user:password@example.com", "https://example.com/app",
            "https://example.com?token=secret", "https://example.com#secret", "file:///etc/passwd",
            "javascript:alert(1)", "https://*.example.com"] {
            assert!(normalize_server(value, false).is_err(), "{value}");
        }
    }
    #[test]
    fn http_is_limited_to_debug_loopback() {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            assert!(normalize_server(&format!("http://{host}:8080"), true).is_ok());
            assert!(normalize_server(&format!("http://{host}:8080"), false).is_err());
        }
        assert!(normalize_server("http://192.168.1.2:8080", true).is_err());
        assert!(normalize_server("http://localhost.example.com", true).is_err());
    }
    #[test]
    fn navigation_stays_on_the_selected_origin_or_packaged_connection_screen() {
        let server = normalize_server("https://example.com:8443", false).unwrap();
        for value in ["https://example.com:8443/login", "https://example.com:8443/chats/one", "tauri://localhost/index.html?changeServer=1"] {
            assert!(navigation_allowed(&Url::parse(value).unwrap(), Some(&server)));
        }
        for value in ["https://example.com", "https://other.example.com:8443", "http://example.com:8443",
            "tauri://other/index.html", "https://tauri.localhost.evil.com", "file:///etc/passwd", "https://user@example.com:8443/"] {
            assert!(!navigation_allowed(&Url::parse(value).unwrap(), Some(&server)), "{value}");
        }
        assert!(!navigation_allowed(&server, None));
    }
}
