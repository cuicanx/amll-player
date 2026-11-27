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
        // WebPKI roots cover the public web; the system store additionally
        // contains enterprise/user-installed CAs (the reason a pure WebPKI
        // setup fails on corporate networks). Merging both avoids JNI_OnLoad
        // while still honouring user-trusted certificates.
        let mut root_store = rustls::RootCertStore::empty();
        root_store.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        match rustls_native_certs::load_native_certs() {
            Ok(certs) => {
                let (added, ignored) = root_store.add_parsable_certificates(certs);
                tracing::info!(
                    "Android TLS roots: WebPKI + {added} system CA(s) ({ignored} unparsable)"
                );
            }
            Err(err) => {
                // System store unavailable: public-web hosts still work via
                // WebPKI roots. Never fail startup over this.
                tracing::warn!("failed to load Android system CA store: {err}");
            }
        }
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
