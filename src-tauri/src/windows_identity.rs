//! Use the installer's identity even when Explorer launches the executable
//! directly through a PDF association instead of a Start menu shortcut.

pub fn set_app_id(identifier: &str) -> Result<(), String> {
    let id: Vec<u16> = identifier.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        windows_sys::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID(id.as_ptr())
    };
    if result < 0 {
        return Err(format!("Could not set Windows taskbar identity: {result:#x}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_reports_the_same_identity_as_the_installer() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let expected = config["identifier"].as_str().unwrap();
        super::set_app_id(expected).unwrap();
        unsafe {
            let mut value = std::ptr::null_mut();
            assert_eq!(windows_sys::Win32::UI::Shell::GetCurrentProcessExplicitAppUserModelID(&mut value), 0);
            let mut length = 0;
            while *value.add(length) != 0 { length += 1; }
            let actual = String::from_utf16(std::slice::from_raw_parts(value, length)).unwrap();
            windows_sys::Win32::System::Com::CoTaskMemFree(value.cast());
            assert_eq!(actual, expected);
        }
    }
}
