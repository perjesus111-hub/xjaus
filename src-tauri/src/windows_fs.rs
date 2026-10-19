//! Windows per-user storage: private protected DACL, no reparse points, atomic replace.
use std::{
    fs,
    os::windows::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
};
use windows_sys::Win32::{
    Foundation::LocalFree,
    Security::{
        Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW,
        DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
    },
    Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT, MOVEFILE_REPLACE_EXISTING,
        MOVEFILE_WRITE_THROUGH, MoveFileExW,
    },
};
fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}
pub fn root(kind: &str) -> Result<PathBuf, String> {
    let base = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA unavailable")?;
    let base = PathBuf::from(base);
    if !base.is_absolute() {
        return Err("LOCALAPPDATA must be absolute".into());
    }
    Ok(base.join("XJAUS").join(kind))
}
fn current_user_sid() -> Result<String, String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, GetLastError},
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, TOKEN_QUERY, TOKEN_USER,
            TokenUser,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err("Cannot inspect Windows identity".into());
        }
        let mut size = 0;
        GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut data = vec![
            0usize;
            (size as usize + std::mem::size_of::<usize>() - 1)
                / std::mem::size_of::<usize>()
        ];
        if GetTokenInformation(token, TokenUser, data.as_mut_ptr().cast(), size, &mut size) == 0 {
            CloseHandle(token);
            return Err(format!("Cannot read Windows identity: {}", GetLastError()));
        }
        let user = &*(data.as_ptr().cast::<TOKEN_USER>());
        let mut sid = std::ptr::null_mut();
        let ok = ConvertSidToStringSidW(user.User.Sid, &mut sid);
        CloseHandle(token);
        if ok == 0 {
            return Err("Cannot format Windows identity".into());
        }
        let mut n = 0;
        while *sid.add(n) != 0 {
            n += 1
        }
        let result = String::from_utf16_lossy(std::slice::from_raw_parts(sid, n));
        LocalFree(sid.cast());
        Ok(result)
    }
}
pub fn protect(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(|_| "Storage unavailable")?;
    if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Reparse storage rejected".into());
    }
    // Explicit current-user SID works on Windows and Wine; inheritance is disabled.
    let sid = current_user_sid()?;
    let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut descriptor = std::ptr::null_mut();
    unsafe {
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            1,
            &mut descriptor,
            std::ptr::null_mut(),
        ) == 0
        {
            return Err("Private DACL unavailable".into());
        }
        let mut dacl = std::ptr::null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        if windows_sys::Win32::Security::GetSecurityDescriptorDacl(
            descriptor,
            &mut present,
            &mut dacl,
            &mut defaulted,
        ) == 0
            || present == 0
        {
            LocalFree(descriptor);
            return Err("Private DACL invalid".into());
        }
        let result = windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW(
            wide(path).as_ptr(),
            windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            dacl,
            std::ptr::null(),
        );
        LocalFree(descriptor);
        if result != 0 {
            return Err(format!("Cannot protect Windows storage: {result}"));
        }
    }
    Ok(())
}
pub fn directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|_| "Cannot create storage")?;
    if !fs::symlink_metadata(path)
        .map_err(|_| "Cannot inspect storage")?
        .is_dir()
    {
        return Err("Not a storage directory".into());
    }
    protect(path)
}
pub fn read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let f = fs::OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(|_| "Cannot read storage")?;
    let m = f.metadata().map_err(|_| "Cannot inspect storage")?;
    if !m.is_file() || m.len() > limit || m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err("Unsafe storage file".into());
    }
    let mut b = Vec::new();
    f.take(limit + 1)
        .read_to_end(&mut b)
        .map_err(|_| "Cannot read storage")?;
    if b.len() as u64 > limit {
        return Err("Storage too large".into());
    }
    Ok(b)
}
pub fn replace(from: &Path, to: &Path) -> Result<(), String> {
    unsafe {
        if MoveFileExW(
            wide(from).as_ptr(),
            wide(to).as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        ) == 0
        {
            return Err("Cannot commit Windows storage".into());
        }
    }
    Ok(())
}
pub fn write(path: &Path, data: &[u8]) -> Result<(), String> {
    use std::io::Write;
    directory(path.parent().ok_or("No storage parent")?)?;
    let mut nonce = [0; 16];
    getrandom::getrandom(&mut nonce).map_err(|_| "Storage nonce unavailable")?;
    let tmp = path.with_extension(format!("{}.tmp", hex::encode(nonce)));
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)
            .map_err(|_| "Cannot create storage file")?;
        protect(&tmp)?;
        f.write_all(data).map_err(|_| "Cannot write storage")?;
        f.sync_all().map_err(|_| "Cannot sync storage")?;
        drop(f);
        replace(&tmp, path)
    })();
    let _ = fs::remove_file(&tmp);
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_atomic_replace_and_bounded_read() {
        let p = root("packaging-tests")
            .unwrap()
            .join(format!("{}.json", std::process::id()));
        write(&p, b"first").unwrap();
        write(&p, b"second").unwrap();
        assert_eq!(read(&p, 100).unwrap(), b"second");
        assert!(read(&p, 2).is_err());
        fs::remove_file(p).unwrap();
    }
}
