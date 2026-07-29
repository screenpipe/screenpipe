use std::{fs, path::Path};

fn collect_files(path: &Path, output: &mut Vec<std::path::PathBuf>) {
    if path.is_file() {
        output.push(path.to_path_buf());
        return;
    }

    for entry in fs::read_dir(path).expect("privacy-audit path should be readable") {
        let entry = entry.expect("privacy-audit entry should be readable");
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, output);
        } else if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("json" | "md")
        ) {
            output.push(path);
        }
    }
}

fn email_like_tokens(text: &str) -> impl Iterator<Item = &str> {
    text.split(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | '"' | '\'' | ',' | ';'
            )
    })
    .map(|token| token.trim_matches(|character: char| ".:!?`".contains(character)))
    .filter(|token| {
        let Some((local, domain)) = token.rsplit_once('@') else {
            return false;
        };
        !local.is_empty() && domain.contains('.')
    })
}

#[test]
fn committed_eval_data_has_no_local_paths_or_credentials() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    collect_files(&manifest_dir.join("evals"), &mut files);
    collect_files(&manifest_dir.join("tests/fixtures"), &mut files);
    files.push(manifest_dir.join("../../docs/SEMANTIC_APP_PARSER_SPEC.md"));

    let forbidden_markers = [
        "/Users/",
        "/home/",
        "C:\\Users\\",
        "/var/folders/",
        "TemporaryItems/",
        "BEGIN PRIVATE KEY",
        "BEGIN RSA PRIVATE KEY",
        "ghp_",
        "xoxb-",
        "AKIA",
    ];

    for path in files {
        let text = fs::read_to_string(&path).expect("privacy-audit file should be UTF-8");
        for marker in forbidden_markers {
            assert!(
                !text.contains(marker),
                "committed eval data contains forbidden marker {marker:?} in {}",
                path.display()
            );
        }

        for email in email_like_tokens(&text) {
            assert!(
                email.ends_with("@example.com")
                    || email.ends_with("@example.org")
                    || email.ends_with("@example.net"),
                "committed eval data contains a non-example email in {}",
                path.display()
            );
        }
    }
}
