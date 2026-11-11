use std::time::Duration;

use super::project_discovery::website_url;

const MAX_DOCUMENT_BYTES: u64 = 512 * 1024;

pub(crate) async fn resolve_project_favicon_core(website: String) -> Option<String> {
    let website = website_url(&website)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("CodexMonitor favicon resolver")
        .build()
        .ok()?;
    let response = client.get(website).send().await.ok()?.error_for_status().ok()?;
    if response.content_length().is_some_and(|length| length > MAX_DOCUMENT_BYTES) {
        return None;
    }
    let page_url = response.url().clone();
    let html = response.text().await.ok()?;
    declared_favicon_url(&html, &page_url).map(|url| url.to_string())
}

fn declared_favicon_url(html: &str, page_url: &reqwest::Url) -> Option<reqwest::Url> {
    let lower_html = html.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(offset) = lower_html[cursor..].find("<link") {
        let start = cursor + offset;
        let end = lower_html[start..].find('>')? + start;
        let tag = &html[start..=end];
        let rel = attribute_value(tag, "rel").unwrap_or_default();
        if rel.split_ascii_whitespace().any(|value| value.eq_ignore_ascii_case("icon")) {
            if let Some(href) = attribute_value(tag, "href") {
                let url = page_url.join(&href).ok()?;
                if matches!(url.scheme(), "http" | "https")
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.host_str().is_some()
                {
                    return Some(url);
                }
            }
        }
        cursor = end + 1;
    }
    None
}

fn attribute_value(tag: &str, name: &str) -> Option<String> {
    let lower_tag = tag.to_ascii_lowercase();
    let mut cursor = 0;
    while let Some(offset) = lower_tag[cursor..].find(name) {
        let start = cursor + offset;
        let before = lower_tag[..start].chars().next_back();
        let after = lower_tag[start + name.len()..].chars().next();
        if before.map_or(true, |value| value.is_ascii_whitespace() || value == '<')
            && after.map_or(true, |value| value.is_ascii_whitespace() || value == '=')
        {
            let remainder = &tag[start + name.len()..];
            let value = remainder.trim_start();
            let value = value.strip_prefix('=')?.trim_start();
            let quote = value.chars().next()?;
            if matches!(quote, '\'' | '"') {
                return value[1..].find(quote).map(|end| value[1..1 + end].to_string());
            }
            return value
                .split_ascii_whitespace()
                .next()
                .map(|value| value.trim_end_matches('>').to_string());
        }
        cursor = start + name.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_a_declared_icon_and_resolves_relative_urls() {
        let page = reqwest::Url::parse("https://ctwilson.com/").unwrap();
        let icon = declared_favicon_url(
            r#"<link rel="shortcut icon" href="/wp-content/uploads/favicon.png">"#,
            &page,
        )
        .unwrap();
        assert_eq!(icon.as_str(), "https://ctwilson.com/wp-content/uploads/favicon.png");
    }

    #[test]
    fn ignores_non_web_icon_urls() {
        let page = reqwest::Url::parse("https://example.com/").unwrap();
        assert!(declared_favicon_url(r#"<link rel="icon" href="data:image/png;base64,AA">"#, &page).is_none());
    }
}
