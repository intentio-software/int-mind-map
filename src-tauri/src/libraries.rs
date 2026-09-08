//! Where mind maps live.
//!
//! The MCP server used to be told its folders once, as command-line arguments
//! frozen at whenever `claude mcp add` was last run. Move your maps and the
//! server keeps looking at the old place, with nothing to notice it.
//!
//! Knowledge solved this by following whichever vault the app has open; Tasks
//! by a marker file naming its store. Mind Map is closer to Tasks — it has no
//! single "open" thing, it has a folder full of maps — so it follows Tasks:
//! a small file under `~/.intentio` that the app writes and the server reads
//! fresh on every call.
//!
//! One folder is the home, and any number of others can be added beside it.
//! The home is the one new maps are saved into and the one an agent means when
//! it does not say; the rest are places to read from.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// What the app records about where maps are kept.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Libraries {
    /// Where new maps go, and what an agent means by default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub home: Option<String>,
    /// Other folders worth reading, in the order they were added.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra: Vec<String>,
    /// When the app last wrote this.
    #[serde(default)]
    pub updated_at: u64,
}

impl Libraries {
    /// Every folder, home first, with duplicates and missing ones dropped.
    ///
    /// A folder that has been deleted or unmounted is left out rather than
    /// reported: the server would only fail on it, and an agent being told
    /// about a folder it cannot read helps nobody.
    pub fn folders(&self) -> Vec<PathBuf> {
        let mut seen: Vec<PathBuf> = Vec::new();
        for candidate in self.home.iter().chain(self.extra.iter()) {
            let path = PathBuf::from(candidate);
            if path.is_dir() && !seen.iter().any(|existing| same(existing, &path)) {
                seen.push(path);
            }
        }
        seen
    }
}

/// Compare by canonical path where possible, so two spellings of one folder
/// are not offered as two libraries — which is exactly the name collision the
/// server refuses to start with.
fn same(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn state_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".intentio").join("mindmap-libraries.json"))
}

/// Read what the app last recorded.
pub fn read() -> Libraries {
    state_path()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Record where maps are kept, for the MCP server to pick up on its next call.
pub fn write(libraries: &Libraries) -> std::io::Result<()> {
    let Some(path) = state_path() else { return Ok(()) };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(libraries).unwrap_or_default();
    std::fs::write(path, format!("{json}\n"))
}

/// The default home, used when nothing has been chosen: `~/Documents/Mind Maps`.
///
/// Not created here — a folder appearing in someone's Documents because they
/// opened an app is presumptuous. It is offered as the suggestion when they
/// are asked.
pub fn suggested_home() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join("Documents").join("Mind Maps"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_are_home_first_and_deduplicated() {
        let dir = std::env::temp_dir().join(format!("int-mm-lib-{}", std::process::id()));
        let a = dir.join("home");
        let b = dir.join("other");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();

        let libraries = Libraries {
            home: Some(a.to_string_lossy().to_string()),
            // The same folder twice, and one that does not exist.
            extra: vec![
                b.to_string_lossy().to_string(),
                a.to_string_lossy().to_string(),
                dir.join("gone").to_string_lossy().to_string(),
            ],
            updated_at: 0,
        };

        let folders = libraries.folders();
        assert_eq!(folders.len(), 2, "the duplicate and the missing one are dropped");
        assert!(folders[0].ends_with("home"), "home comes first");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_recorded_is_no_folders_rather_than_an_error() {
        let empty = Libraries::default();
        assert!(empty.folders().is_empty());
    }
}
