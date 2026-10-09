// This is a desktop app; do not open a console window in either build profile.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    komodo_pdf_lib::run()
}
