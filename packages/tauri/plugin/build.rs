const COMMANDS: &[&str] = &["open", "close", "execute", "query", "migrate",
    "credential_get",
    "credential_set",
    "credential_delete",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
