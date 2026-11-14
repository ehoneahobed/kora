//! Credentials (sign-in tokens) in the operating system's credential store: Keychain on macOS,
//! Credential Manager on Windows, the Secret Service on Linux. Entries are kept under the app's
//! bundle identifier, so two apps on one machine never read each other's sessions.
//!
//! Keychain calls can block (the Secret Service is a D-Bus round trip), so each runs on a
//! blocking thread, never the thread that drives the WebView.

use tauri::{AppHandle, Runtime};

use crate::error::Error;

/// Prefix of the error a platform without a usable credential store reports. The JavaScript
/// store reads it to fall back to WebView storage instead of failing sign-in.
const UNAVAILABLE: &str = "CREDENTIAL_STORE_UNAVAILABLE";

fn entry(service: &str, key: &str) -> Result<keyring::Entry, Error> {
    keyring::Entry::new(service, key).map_err(classify)
}

fn classify(error: keyring::Error) -> Error {
    match error {
        keyring::Error::NoDefaultStore
        | keyring::Error::NoStorageAccess(_)
        | keyring::Error::PlatformFailure(_) => {
            Error::Plugin(format!("{UNAVAILABLE}: {error}"))
        }
        other => Error::Plugin(format!("CREDENTIAL_ERROR: {other}")),
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, Error> + Send + 'static,
) -> Result<T, Error> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| Error::Plugin(format!("CREDENTIAL_ERROR: {e}")))?
}

/// Read a credential; `None` when none is stored under `key`.
#[tauri::command]
pub async fn credential_get<R: Runtime>(
    app: AppHandle<R>,
    key: String,
) -> Result<Option<String>, Error> {
    let service = app.config().identifier.clone();
    blocking(move || match entry(&service, &key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(classify(error)),
    })
    .await
}

/// Store a credential under `key`, replacing any earlier one.
#[tauri::command]
pub async fn credential_set<R: Runtime>(
    app: AppHandle<R>,
    key: String,
    value: String,
) -> Result<(), Error> {
    let service = app.config().identifier.clone();
    blocking(move || entry(&service, &key)?.set_password(&value).map_err(classify)).await
}

/// Remove the credential under `key`; removing one that is not there succeeds.
#[tauri::command]
pub async fn credential_delete<R: Runtime>(app: AppHandle<R>, key: String) -> Result<(), Error> {
    let service = app.config().identifier.clone();
    blocking(move || match entry(&service, &key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(classify(error)),
    })
    .await
}
