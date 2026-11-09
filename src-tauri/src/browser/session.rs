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

pub(crate) fn record_path(profile: &Path) -> PathBuf {
    profile.join("session.json")
}

pub(crate) fn ownership_path(profile: &Path) -> PathBuf {
    profile.join("owner.json")
}

pub(crate) fn claim_ownership(profile: &Path, thread_id: &str) -> Result<OwnershipClaim, String> {
    let expected_session_id = session_id(thread_id)?;
    std::fs::create_dir_all(profile).map_err(|error| error.to_string())?;
    let path = ownership_path(profile);
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
    profile: &Path,
    expected_thread_id: &str,
) -> Option<BrowserSessionRecord> {
    let bytes = std::fs::read(record_path(profile)).ok()?;
    let record: BrowserSessionRecord = serde_json::from_slice(&bytes).ok()?;
    let expected_session_id = session_id(expected_thread_id).ok()?;
    (record.version == SESSION_VERSION
        && record.thread_id == expected_thread_id
        && record.session_id == expected_session_id)
        .then_some(record)
}

pub(crate) fn write_record(profile: &Path, record: &BrowserSessionRecord) -> Result<(), String> {
    std::fs::create_dir_all(profile).map_err(|error| error.to_string())?;
    let path = record_path(profile);
    let temporary = profile.join("session.json.tmp");
    let bytes = serde_json::to_vec(record).map_err(|error| error.to_string())?;
    std::fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_thread_ids_produce_isolated_profile_paths() {
        let root = Path::new("/browser-root");
        let one = profile_dir(root, "thread-one").unwrap();
        let two = profile_dir(root, "thread-two").unwrap();
        assert_ne!(one, two);
        assert_eq!(one, profile_dir(root, "thread-one").unwrap());
        assert_eq!(one.parent(), two.parent());
        assert!(!one.to_string_lossy().contains("thread-one"));
    }

    #[test]
    fn records_only_restore_for_the_owning_thread() {
        let root = std::env::temp_dir().join(format!("browser-session-{}", uuid::Uuid::new_v4()));
        let profile = profile_dir(&root, "thread-one").unwrap();
        let record = new_record("thread-one", Some("http://127.0.0.1/test".into())).unwrap();
        write_record(&profile, &record).unwrap();
        assert_eq!(read_record(&profile, "thread-one"), Some(record));
        assert_eq!(read_record(&profile, "thread-two"), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ownership_recovers_stale_files_but_rejects_live_competitors() {
        let root = std::env::temp_dir().join(format!("browser-owner-{}", uuid::Uuid::new_v4()));
        let profile = profile_dir(&root, "thread-one").unwrap();
        let first = claim_ownership(&profile, "thread-one").unwrap();
        assert_eq!(first.decision, OwnershipDecision::Claimed);
        assert!(claim_ownership(&profile, "thread-one").is_err());
        release_ownership(first);
        std::fs::write(
            ownership_path(&profile),
            br#"{"version":1,"threadId":"old","sessionId":"old","pid":999999}"#,
        )
        .unwrap();
        let recovered = claim_ownership(&profile, "thread-one").unwrap();
        assert_eq!(recovered.decision, OwnershipDecision::RecoveredStale);
        release_ownership(recovered);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn releasing_one_thread_does_not_release_another() {
        let root = std::env::temp_dir().join(format!("browser-close-{}", uuid::Uuid::new_v4()));
        let one_profile = profile_dir(&root, "thread-one").unwrap();
        let two_profile = profile_dir(&root, "thread-two").unwrap();
        let one = claim_ownership(&one_profile, "thread-one").unwrap();
        let two = claim_ownership(&two_profile, "thread-two").unwrap();
        release_ownership(one);
        assert!(!ownership_path(&one_profile).exists());
        assert!(ownership_path(&two_profile).exists());
        assert!(claim_ownership(&two_profile, "thread-two").is_err());
        release_ownership(two);
        std::fs::remove_dir_all(root).unwrap();
    }
}
