use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Seek, Write};
use std::path::{Path, PathBuf};

const SESSION_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserSessionRecord {
    pub(crate) version: u8,
    pub(crate) thread_id: String,
    pub(crate) session_id: String,
    pub(crate) url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct BrowserOwnerRecord {
    version: u8,
    thread_id: String,
    session_id: String,
    pid: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OwnershipDecision {
    Claimed,
    RecoveredStale,
}

#[derive(Debug)]
pub(crate) struct OwnershipClaim {
    pub(crate) decision: OwnershipDecision,
    file: File,
    path: PathBuf,
}

impl Drop for OwnershipClaim {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        unlock_file(&self.file);
    }
}

#[cfg(unix)]
fn try_lock_file(file: &File) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;

    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) {
    use std::os::fd::AsRawFd;

    let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
}

#[cfg(not(unix))]
fn try_lock_file(_file: &File) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "browser profile locking requires Unix",
    ))
}

#[cfg(not(unix))]
fn unlock_file(_file: &File) {}

pub(crate) fn validate_thread_id(thread_id: &str) -> Result<&str, String> {
    let thread_id = thread_id.trim();
    if thread_id.is_empty() || thread_id.len() > 256 || thread_id.chars().any(char::is_control) {
        return Err("A valid Codex thread ID is required for the internal browser".into());
    }
    Ok(thread_id)
}

pub(crate) fn session_id(thread_id: &str) -> Result<String, String> {
    let thread_id = validate_thread_id(thread_id)?;
    let digest = Sha256::digest(thread_id.as_bytes());
    Ok(format!("thread-{}", hex_prefix(&digest, 24)))
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(count);
    for byte in bytes {
        if output.len() >= count {
            break;
        }
        output.push(HEX[(byte >> 4) as usize] as char);
        if output.len() < count {
            output.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
    output
}

pub(crate) fn profile_dir(root: &Path, thread_id: &str) -> Result<PathBuf, String> {
    Ok(root.join("profiles").join(session_id(thread_id)?))
}

/// App-owned state deliberately lives outside CEF's cache path. CEF owns every
/// byte below `profiles/`; creating a file there before the request context is
/// initialized makes a new CEF profile fail to initialize on macOS.
pub(crate) fn metadata_dir(root: &Path, thread_id: &str) -> Result<PathBuf, String> {
    Ok(root.join("sessions").join(session_id(thread_id)?))
}

pub(crate) fn record_path(metadata: &Path) -> PathBuf {
    metadata.join("session.json")
}

pub(crate) fn ownership_path(metadata: &Path) -> PathBuf {
    metadata.join("owner.json")
}

pub(crate) fn claim_ownership(metadata: &Path, thread_id: &str) -> Result<OwnershipClaim, String> {
    let expected_session_id = session_id(thread_id)?;
    std::fs::create_dir_all(metadata).map_err(|error| error.to_string())?;
    let path = ownership_path(metadata);
    let mut file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    if let Err(error) = try_lock_file(&file) {
        let existing = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<BrowserOwnerRecord>(&bytes).ok());
        return Err(match existing {
            Some(owner) => format!(
                "Internal browser profile is already owned by process {} for thread {}",
                owner.pid, owner.thread_id
            ),
            None => format!("Internal browser profile ownership lock is busy: {error}"),
        });
    }
    let existing = std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<BrowserOwnerRecord>(&bytes).ok());
    let decision = match existing {
        Some(_) => OwnershipDecision::RecoveredStale,
        None => OwnershipDecision::Claimed,
    };
    let owner = BrowserOwnerRecord {
        version: SESSION_VERSION,
        thread_id: thread_id.to_string(),
        session_id: expected_session_id,
        pid: std::process::id(),
    };
    file.set_len(0).map_err(|error| error.to_string())?;
    file.rewind().map_err(|error| error.to_string())?;
    file.write_all(&serde_json::to_vec(&owner).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    file.sync_data().map_err(|error| error.to_string())?;
    Ok(OwnershipClaim {
        decision,
        file,
        path,
    })
}

pub(crate) fn release_ownership(claim: OwnershipClaim) {
    drop(claim);
}

pub(crate) fn new_record(
    thread_id: &str,
    url: Option<String>,
) -> Result<BrowserSessionRecord, String> {
    let thread_id = validate_thread_id(thread_id)?.to_string();
    Ok(BrowserSessionRecord {
        version: SESSION_VERSION,
        session_id: session_id(&thread_id)?,
        thread_id,
        url,
    })
}

pub(crate) fn read_record(
    metadata: &Path,
    expected_thread_id: &str,
) -> Option<BrowserSessionRecord> {
    let bytes = std::fs::read(record_path(metadata)).ok()?;
    let record: BrowserSessionRecord = serde_json::from_slice(&bytes).ok()?;
    let expected_session_id = session_id(expected_thread_id).ok()?;
    (record.version == SESSION_VERSION
        && record.thread_id == expected_thread_id
        && record.session_id == expected_session_id)
        .then_some(record)
}

pub(crate) fn write_record(metadata: &Path, record: &BrowserSessionRecord) -> Result<(), String> {
    std::fs::create_dir_all(metadata).map_err(|error| error.to_string())?;
    let path = record_path(metadata);
    let temporary = metadata.join("session.json.tmp");
    let bytes = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

/// Move state written by builds that stored app metadata in CEF's profile
/// directory. Only the known metadata files are removed. Any CEF-created
/// profile data remains untouched, while its last URL is retained in the new
/// metadata location.
pub(crate) fn migrate_legacy_metadata(root: &Path, thread_id: &str) -> Result<(), String> {
    let profile = profile_dir(root, thread_id)?;
    if !profile.is_dir() {
        return Ok(());
    }
    let metadata = metadata_dir(root, thread_id)?;
    let legacy_record = read_record(&profile, thread_id);
    if let Some(record) = legacy_record {
        if read_record(&metadata, thread_id).is_none() {
            write_record(&metadata, &record)?;
        }
    }
    let legacy_record_path = record_path(&profile);
    if legacy_record_path.is_file() {
        std::fs::remove_file(legacy_record_path).map_err(|error| error.to_string())?;
    }
    let owner = ownership_path(&profile);
    if owner.exists() {
        let file = File::options()
            .read(true)
            .write(true)
            .open(&owner)
            .map_err(|error| error.to_string())?;
        try_lock_file(&file).map_err(|_| {
            "Internal browser profile is already owned by another process; close that app before reopening this thread".to_string()
        })?;
        std::fs::remove_file(&owner).map_err(|error| error.to_string())?;
        unlock_file(&file);
    }
    let temporary = profile.join("session.json.tmp");
    if temporary.is_file() {
        std::fs::remove_file(temporary).map_err(|error| error.to_string())?;
    }
    if profile
        .read_dir()
        .map_err(|error| error.to_string())?
        .next()
        .is_none()
    {
        std::fs::remove_dir(profile).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_thread_ids_produce_isolated_profile_and_metadata_paths() {
        let root = Path::new("/browser-root");
        let one = profile_dir(root, "thread-one").unwrap();
        let two = profile_dir(root, "thread-two").unwrap();
        let one_metadata = metadata_dir(root, "thread-one").unwrap();
        let two_metadata = metadata_dir(root, "thread-two").unwrap();
        assert_ne!(one, two);
        assert_eq!(one, profile_dir(root, "thread-one").unwrap());
        assert_eq!(one.parent(), two.parent());
        assert_ne!(one_metadata, two_metadata);
        assert_eq!(one_metadata, metadata_dir(root, "thread-one").unwrap());
        assert_ne!(one, one_metadata);
        assert!(!one.to_string_lossy().contains("thread-one"));
    }

    #[test]
    fn new_thread_metadata_does_not_create_its_cef_profile() {
        let root = std::env::temp_dir().join(format!("browser-session-{}", uuid::Uuid::new_v4()));
        let profile = profile_dir(&root, "thread-one").unwrap();
        let metadata = metadata_dir(&root, "thread-one").unwrap();
        let record = new_record("thread-one", Some("http://127.0.0.1/test".into())).unwrap();
        write_record(&metadata, &record).unwrap();
        assert!(!profile.exists());
        assert_eq!(read_record(&metadata, "thread-one"), Some(record));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_reopens_existing_persistent_profile_from_separate_metadata() {
        let root = std::env::temp_dir().join(format!("browser-reopen-{}", uuid::Uuid::new_v4()));
        let profile = profile_dir(&root, "thread-one").unwrap();
        let metadata = metadata_dir(&root, "thread-one").unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("Cookies"), b"cef profile data").unwrap();
        let record = new_record("thread-one", Some("https://example.com/".into())).unwrap();
        write_record(&metadata, &record).unwrap();
        assert_eq!(read_record(&metadata, "thread-one"), Some(record));
        assert_eq!(
            std::fs::read(profile.join("Cookies")).unwrap(),
            b"cef profile data"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ownership_recovers_stale_metadata_but_rejects_live_competitors() {
        let root = std::env::temp_dir().join(format!("browser-owner-{}", uuid::Uuid::new_v4()));
        let metadata = metadata_dir(&root, "thread-one").unwrap();
        let first = claim_ownership(&metadata, "thread-one").unwrap();
        assert_eq!(first.decision, OwnershipDecision::Claimed);
        assert!(claim_ownership(&metadata, "thread-one").is_err());
        release_ownership(first);
        std::fs::write(
            ownership_path(&metadata),
            br#"{"version":1,"threadId":"old","sessionId":"old","pid":999999}"#,
        )
        .unwrap();
        let recovered = claim_ownership(&metadata, "thread-one").unwrap();
        assert_eq!(recovered.decision, OwnershipDecision::RecoveredStale);
        release_ownership(recovered);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn releasing_one_thread_does_not_release_another() {
        let root = std::env::temp_dir().join(format!("browser-close-{}", uuid::Uuid::new_v4()));
        let one_metadata = metadata_dir(&root, "thread-one").unwrap();
        let two_metadata = metadata_dir(&root, "thread-two").unwrap();
        let one = claim_ownership(&one_metadata, "thread-one").unwrap();
        let two = claim_ownership(&two_metadata, "thread-two").unwrap();
        release_ownership(one);
        assert!(!ownership_path(&one_metadata).exists());
        assert!(ownership_path(&two_metadata).exists());
        assert!(claim_ownership(&two_metadata, "thread-two").is_err());
        release_ownership(two);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_metadata_is_migrated_before_cef_creates_the_profile() {
        let root = std::env::temp_dir().join(format!("browser-migrate-{}", uuid::Uuid::new_v4()));
        let profile = profile_dir(&root, "thread-one").unwrap();
        let legacy = new_record("thread-one", Some("https://example.com/".into())).unwrap();
        write_record(&profile, &legacy).unwrap();
        std::fs::write(ownership_path(&profile), b"stale owner").unwrap();
        migrate_legacy_metadata(&root, "thread-one").unwrap();
        let metadata = metadata_dir(&root, "thread-one").unwrap();
        assert_eq!(read_record(&metadata, "thread-one"), Some(legacy));
        assert!(!profile.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn paths_with_spaces_keep_metadata_and_cef_profiles_separate() {
        let root = std::env::temp_dir().join(format!("browser profile {}", uuid::Uuid::new_v4()));
        let profile = profile_dir(&root, "thread-one").unwrap();
        let metadata = metadata_dir(&root, "thread-one").unwrap();
        write_record(
            &metadata,
            &new_record("thread-one", Some("https://example.com/".into())).unwrap(),
        )
        .unwrap();
        assert!(metadata.to_string_lossy().contains("browser profile"));
        assert!(!profile.exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
