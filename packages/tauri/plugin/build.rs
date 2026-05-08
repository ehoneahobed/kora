const COMMANDS: &[&str] = &["open", "close", "execute", "query", "migrate"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
