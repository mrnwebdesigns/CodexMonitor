use super::*;
use crate::types::{WorkspaceKind, WorkspaceSettings};
use tokio::runtime::Runtime;

struct Fixture {
    scratch: Scratch,
    root: PathBuf,
    config: PathBuf,
    entry: WorkspaceEntry,
}
impl Fixture {
    fn new() -> Self {
        let scratch = Scratch::new().unwrap();
        let root = scratch.0.join("project");
        fs::create_dir(&root).unwrap();
        let hooks = scratch.0.join("empty-hooks");
        fs::create_dir(&hooks).unwrap();
        let config = scratch.0.join("gitconfig");
        fs::write(&config, format!("[user]\nname = Setup Test\nemail = setup@example.invalid\n[commit]\ngpgsign = false\n[core]\nhooksPath = {}\n", hooks.to_string_lossy().replace('\\', "/"))).unwrap();
        let entry = WorkspaceEntry {
            id: "setup-test".into(),
            name: "Fixture".into(),
            path: root.to_string_lossy().into(),
            kind: WorkspaceKind::Main,
            parent_id: None,
            worktree: None,
            settings: WorkspaceSettings::default(),
        };
        Self {
            scratch,
            root,
            config,
            entry,
        }
    }
    fn write(&self, path: &str, value: &str) {
        let p = self.root.join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, value).unwrap();
    }
    async fn review(&self, root: &str, excluded: &[String]) -> GitInitReview {
        inspect(&self.entry, root, "main", excluded, Some(&self.config))
            .await
            .unwrap()
            .0
    }
    async fn initialize(
        &self,
        review: &GitInitReview,
        excluded: Vec<String>,
    ) -> Result<Value, String> {
        let workspaces = Mutex::new(HashMap::from([(self.entry.id.clone(), self.entry.clone())]));
        initialize_with_config(
            &workspaces,
            self.entry.id.clone(),
            "main".into(),
            Some(GitInitSelection {
                root: review.relative_root.clone(),
                excluded_paths: excluded,
                fingerprint: review.fingerprint.clone(),
            }),
            Some(&self.config),
        )
        .await
    }
}

#[test]
fn preview_is_read_only_and_preserves_existing_ignores() {
    Runtime::new().unwrap().block_on(async {
        let f = Fixture::new();
        f.write(".gitignore", "custom-output/\n");
        f.write("custom-output/file.txt", "generated");
        f.write("package.json", "{}\n");
        f.write("src/index.js", "export const answer = 42;\n");
        f.write(".env", "DUMMY_ONLY=not-a-real-secret\n");
        f.write("node_modules/demo/index.js", "dependency");
        let review = f.review(".", &[]).await;
        assert!(review.blockers.is_empty(), "{:?}", review.blockers);
        assert!(!f.root.join(".git").exists());
        assert_eq!(
            fs::read_to_string(f.root.join(".gitignore")).unwrap(),
            "custom-output/\n"
        );
        assert!(review.ignore_content.starts_with("custom-output/\n"));
        assert!(review
            .included
            .iter()
            .any(|file| file.path == "src/index.js"));
        assert!(!review
            .included
            .iter()
            .any(|file| file.path.starts_with("node_modules")
                || file.path == ".env"
                || file.path.starts_with("custom-output")));
        assert!(review.excluded.iter().any(|file| file.path == ".env"));
    });
}

#[test]
fn credentials_require_explicit_exclusion_and_values_are_not_returned() {
    Runtime::new().unwrap().block_on(async {
        let f = Fixture::new();
        f.write(
            "src/config.js",
            "const api_key = \"fixture-sensitive-literal\";\n",
        );
        f.write("src/index.js", "export const value = 1;\n");
        let review = f.review(".", &[]).await;
        assert!(!review.blockers.is_empty());
        assert!(review
            .excluded
            .iter()
            .any(|file| file.path == "src/config.js"
                && file
                    .reason
                    .as_deref()
                    .unwrap()
                    .starts_with("Possible embedded")));
        assert!(!serde_json::to_string(&review)
            .unwrap()
            .contains("fixture-sensitive-literal"));
        let excluded = vec!["src/config.js".into()];
        let ready = f.review(".", &excluded).await;
        assert!(ready.blockers.is_empty(), "{:?}", ready.blockers);
        assert!(!ready
            .included
            .iter()
            .any(|file| file.path == "src/config.js"));
        assert!(ready.ignore_content.contains("/src/config.js"));
    });
}

#[test]
fn wordpress_requires_narrow_source_and_keeps_compiled_theme_assets() {
    Runtime::new().unwrap().block_on(async {
        let f = Fixture::new();
        f.write("wp-config.php", "<?php // dummy fixture\n");
        f.write(
            "wp-content/themes/custom/style.css",
            "/* Theme Name: Custom */\n",
        );
        f.write("wp-content/themes/custom/package.json", "{}\n");
        f.write(
            "wp-content/themes/custom/dist/theme.css",
            "body { color: inherit; }\n",
        );
        let broad = f.review(".", &[]).await;
        assert!(!broad.blockers.is_empty());
        assert!(!f.root.join(".git").exists());
        assert!(broad
            .suggested_roots
            .contains(&"wp-content/themes/custom".into()));
        let source = f.review("wp-content/themes/custom", &[]).await;
        assert!(source.blockers.is_empty(), "{:?}", source.blockers);
        assert_eq!(source.profile, "WordPress source");
        assert!(source
            .included
            .iter()
            .any(|file| file.path == "dist/theme.css"));
    });
}

#[test]
fn existing_parent_repo_and_nested_repo_are_not_reinitialized() {
    Runtime::new().unwrap().block_on(async {
        let f = Fixture::new();
        Repository::init(&f.root).unwrap();
        fs::create_dir(f.root.join("source")).unwrap();
        let review = f.review("source", &[]).await;
        assert!(review.existing_repo.is_some());
        assert!(!f.root.join("source/.git").exists());
        let other = Fixture::new();
        fs::create_dir(other.root.join("nested")).unwrap();
        Repository::init(other.root.join("nested")).unwrap();
        other.write("nested/source.txt", "nested code");
        let nested = other.review(".", &[]).await;
        assert!(!nested.blockers.is_empty());
        assert!(!other.root.join(".git").exists());
    });
}

#[test]
fn stale_review_cannot_write_git_or_gitignore() {
    Runtime::new().unwrap().block_on(async {
        let f = Fixture::new();
        f.write("source.txt", "reviewed\n");
        let review = f.review(".", &[]).await;
        f.write("source.txt", "changed after review\n");
        let error = f.initialize(&review, vec![]).await.unwrap_err();
        assert!(error.contains("changed since"));
        assert!(!f.root.join(".git").exists());
        assert!(!f.root.join(".gitignore").exists());
    });
}

#[test]
fn initializes_only_the_reviewed_files_and_does_not_create_a_remote() {
    Runtime::new().unwrap().block_on(async {
        let f = Fixture::new();
        f.write(".gitignore", "existing-output/\n");
        f.write("source.txt", "reviewed source\n");
        f.write("omit.txt", "owner excluded\n");
        f.write(".env", "DUMMY_ONLY=fixture\n");
        let excluded = vec!["omit.txt".into()];
        let review = f.review(".", &excluded).await;
        let result = f.initialize(&review, excluded).await.unwrap();
        assert_eq!(result["status"], "initialized");
        let repo = Repository::open(&f.root).unwrap();
        assert_eq!(repo.head().unwrap().shorthand(), Some("main"));
        assert!(repo.remotes().unwrap().is_empty());
        let tree = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        assert!(tree.get_path(Path::new("source.txt")).is_ok());
        assert!(tree.get_path(Path::new(".gitignore")).is_ok());
        assert!(tree.get_path(Path::new(".env")).is_err());
        assert!(tree.get_path(Path::new("omit.txt")).is_err());
        assert!(fs::read_to_string(f.root.join(".gitignore"))
            .unwrap()
            .starts_with("existing-output/\n"));
    });
}

#[test]
fn paths_cannot_escape_the_workspace_or_use_git_metadata() {
    let f = Fixture::new();
    assert!(choose_root(&f.entry, "..").is_err());
    assert!(relative_path(".git/config").is_err());
    #[cfg(unix)]
    {
        let outside = f.scratch.0.join("outside");
        fs::create_dir(&outside).unwrap();
        std::os::unix::fs::symlink(outside, f.root.join("outside-link")).unwrap();
        assert!(choose_root(&f.entry, "outside-link").is_err());
    }
}

#[test]
fn normal_ui_labels_and_environment_references_are_not_credentials() {
    assert!(!likely_secret(
        b"const passwordLabel = \"Choose a password\";\nconst api_key = process.env.API_KEY;\n"
    ));
    assert!(likely_secret(
        b"const api_key = \"fixture-sensitive-literal\";"
    ));
}

#[test]
fn git_line_ending_filters_are_respected() {
    Runtime::new().unwrap().block_on(async {
        let f = Fixture::new();
        let mut config = fs::OpenOptions::new().append(true).open(&f.config).unwrap();
        use std::io::Write;
        writeln!(config, "\n[core]\nautocrlf = input").unwrap();
        f.write("source.txt", "first\r\nsecond\r\n");
        let review = f.review(".", &[]).await;
        f.initialize(&review, vec![]).await.unwrap();
        let repo = Repository::open(&f.root).unwrap();
        let tree = repo
            .head()
            .unwrap()
            .peel_to_commit()
            .unwrap()
            .tree()
            .unwrap();
        let blob = repo
            .find_blob(tree.get_path(Path::new("source.txt")).unwrap().id())
            .unwrap();
        assert_eq!(blob.content(), b"first\nsecond\n");
    });
}

#[cfg(unix)]
#[test]
fn hook_changes_to_a_reviewed_file_stop_publishing_success() {
    use std::os::unix::fs::PermissionsExt;
    Runtime::new().unwrap().block_on(async {
        let f = Fixture::new();
        f.write("source.txt", "reviewed\n");
        let hook = f.scratch.0.join("empty-hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\nprintf 'changed by fixture hook\\n' > source.txt\ngit add -- source.txt\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let review = f.review(".", &[]).await;
        let error = f.initialize(&review, vec![]).await.unwrap_err();
        assert!(error.contains("Git hook changed"));
        let repo = Repository::open(&f.root).unwrap();
        assert!(repo.remotes().unwrap().is_empty());
    });
}
