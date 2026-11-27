//! Shared HTTP client construction.
//!
//! On Android, reqwest's default TLS backend is `rustls-platform-verifier`,
//! which aborts the process at runtime with
//!   "Expect rustls-platform-verifier to be initialized"
//! unless its `JNI_OnLoad` ran to store the JavaVM. Tauri does not call that
//! hook for companion crates, so every client must use a pre-configured rustls
//! client with WebPKI roots instead. Keeping this in one place prevents new
//! call sites from reintroducing the startup crash.

/// Build a client from an already configured builder, applying the Android
/// TLS workaround in place.
pub fn finish(builder: reqwest::ClientBuilder) -> Result<reqwest::Client, reqwest::Error> {
    #[cfg(target_os = "android")]
    {
        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let tls_config = rustls::ClientConfig::builder()
            .with_root_certificates(root_store)
            .with_no_client_auth();
        builder.use_preconfigured_tls(tls_config).build()
    }
    #[cfg(not(target_os = "android"))]
    {
        builder.build()
    }
}
