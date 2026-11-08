//! Uses only the owner's globally configured `mainwp` MCP entry. No credential fallback.
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

use super::{finding, read_bounded, website_url};
use crate::shared::process_core::tokio_command;
use crate::types::ProjectFinding;

struct Mainwp {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    id: u64,
}

impl Mainwp {
    fn start(home: &Path) -> Result<Self, &'static str> {
        // Deliberately use the canonical global entry, never workspace-supplied commands.
        let text = read_bounded(&home.join(".codex/config.toml"))
            .ok_or("Global MainWP MCP configuration is unavailable")?;
        let config = text
            .parse::<toml_edit::Document>()
            .map_err(|_| "Global MCP configuration could not be read")?;
        let entry = config
            .get("mcp_servers")
            .and_then(|v| v.get("mainwp"))
            .ok_or("The global mainwp MCP entry is missing or disabled")?;
        if entry.get("enabled").and_then(|v| v.as_bool()) == Some(false) {
            return Err("The global mainwp MCP entry is missing or disabled");
        }
        let command = entry
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or("MainWP requires its configured stdio transport")?;
        let mut process = tokio_command(command);
        if let Some(args) = entry.get("args").and_then(|v| v.as_array()) {
            for arg in args {
                process.arg(arg.as_str().ok_or("Invalid MainWP launch arguments")?);
            }
        }
        if let Some(cwd) = entry.get("cwd").and_then(|v| v.as_str()) {
            process.current_dir(cwd);
        }
        if let Some(env) = entry.get("env").and_then(|v| v.as_table_like()) {
            for (key, value) in env.iter() {
                process.env(
                    key,
                    value
                        .as_str()
                        .ok_or("Invalid MainWP environment configuration")?,
                );
            }
        }
        // Stderr and all downstream errors stay private: they can contain service credentials.
        let mut child = process
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| "The configured MainWP MCP process could not start")?;
        let input = child.stdin.take().ok_or("MainWP input is unavailable")?;
        let output = BufReader::new(child.stdout.take().ok_or("MainWP output is unavailable")?);
        Ok(Self {
            _child: child,
            input,
            output,
            id: 0,
        })
    }

    async fn send(&mut self, value: Value) -> Result<(), &'static str> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "Invalid MainWP request")?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "MainWP connection closed")?;
        self.input
            .flush()
            .await
            .map_err(|_| "MainWP connection closed")
    }

    async fn line(&mut self) -> Result<Value, &'static str> {
        let mut bytes = Vec::new();
        loop {
            let buffer = self
                .output
                .fill_buf()
                .await
                .map_err(|_| "MainWP connection closed")?;
            if buffer.is_empty() {
                return Err("MainWP connection closed");
            }
            let count = buffer
                .iter()
                .position(|b| *b == b'\n')
                .map(|i| i + 1)
                .unwrap_or(buffer.len());
            if bytes.len() + count > 2 * 1024 * 1024 {
                return Err("MainWP response exceeded the size limit");
            }
            bytes.extend_from_slice(&buffer[..count]);
            let complete = buffer[count - 1] == b'\n';
            self.output.consume(count);
            if complete {
                return serde_json::from_slice(&bytes).map_err(|_| "Invalid MainWP response");
            }
        }
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, &'static str> {
        self.id += 1;
        let id = self.id;
        self.send(json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params}))
            .await?;
        loop {
            let response = self.line().await?;
            if response["id"] != id {
                continue;
            }
            if response.get("error").is_some() {
                return Err("MainWP rejected the request; check its connection and permissions");
            }
            return response
                .get("result")
                .cloned()
                .ok_or("Invalid MainWP response");
        }
    }

    async fn tool(&mut self, name: &str, arguments: Value) -> Result<Value, &'static str> {
        let result = self
            .request("tools/call", json!({"name":name,"arguments":arguments}))
            .await?;
        let payload = parse_payload(&result, "content")?;
        if result["isError"] == true
            || payload
                .get("error")
                .is_some_and(|v| !v.is_null() && *v != false)
        {
            return Err("MainWP could not verify this site; check the exact website, authentication, and permissions");
        }
        Ok(payload)
    }
}

fn parse_payload(result: &Value, key: &str) -> Result<Value, &'static str> {
    let text = result[key]
        .as_array()
        .and_then(|blocks| blocks.iter().find_map(|b| b["text"].as_str()))
        .ok_or("MainWP returned no JSON payload")?;
    serde_json::from_str(text).map_err(|_| "MainWP returned invalid JSON")
}

fn valid_status(status: &Value) -> bool {
    status["connected"] == true
        && status["dashboardHost"] == "wpcontrol.mrndev.io"
        && status["abilitiesCount"].as_u64().is_some_and(|v| v > 0)
}

fn site_id(site: &Value, target: &reqwest::Url) -> Result<u64, &'static str> {
    let url = site["url"]
        .as_str()
        .or_else(|| site["site_url"].as_str())
        .and_then(website_url)
        .ok_or("MainWP did not return the exact website")?;
    if url.host_str() != target.host_str()
        || url.port_or_known_default() != target.port_or_known_default()
        || url.path().trim_end_matches('/') != target.path().trim_end_matches('/')
    {
        return Err("MainWP returned a different website; discovery stopped");
    }
    site["id"]
        .as_u64()
        .or_else(|| site["site_id"].as_u64())
        .filter(|id| *id > 0)
        .ok_or("MainWP returned no valid site ID")
}

async fn inspect(home: &Path, website: &str) -> Result<ProjectFinding, &'static str> {
    let target = website_url(website).ok_or("Add the live website to check MainWP")?;
    let host = target.host_str().unwrap_or_default();
    if host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok()
    {
        return Err("Add the public WordPress domain to check MainWP");
    }
    let mut client = Mainwp::start(home)?;
    client.request("initialize", json!({"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"codexmonitor-project-details","version":"1.0"}})).await?;
    client
        .send(json!({"jsonrpc":"2.0","method":"notifications/initialized"}))
        .await?;
    let status = parse_payload(
        &client
            .request("resources/read", json!({"uri":"mainwp://status"}))
            .await?,
        "contents",
    )?;
    if !valid_status(&status) {
        return Err("MainWP must be connected to wpcontrol.mrndev.io with a nonzero abilities count; discovery stopped");
    }
    let mut tools = Vec::new();
    let mut cursor: Option<Value> = None;
    for _ in 0..10 {
        let page = client
            .request(
                "tools/list",
                cursor
                    .as_ref()
                    .map(|c| json!({"cursor":c}))
                    .unwrap_or_else(|| json!({})),
            )
            .await?;
        tools.extend(
            page["tools"]
                .as_array()
                .ok_or("MainWP tool discovery failed")?
                .iter()
                .cloned(),
        );
        cursor = page.get("nextCursor").filter(|v| !v.is_null()).cloned();
        if cursor.is_none() {
            break;
        }
    }
    if cursor.is_some() {
        return Err("MainWP tool discovery exceeded its page limit");
    }
    if !tools.iter().any(|t| t["name"] == "get_site_v1") {
        return Err("MainWP site lookup is unavailable in this integration");
    }
    let sync = tools
        .iter()
        .find(|t| t["name"] == "sync_sites_v1")
        .ok_or("MainWP targeted sync is unavailable in this integration")?;
    let before = client
        .tool(
            "get_site_v1",
            json!({"site_id_or_domain":target.as_str(),"include_stats":false}),
        )
        .await?;
    let id = site_id(&before, &target)?;
    let started = chrono::Utc::now().timestamp();
    let args = if sync["inputSchema"]["properties"].get("site_ids").is_some() {
        json!({"site_ids":[id]})
    } else if sync["inputSchema"]["properties"]
        .get("site_ids_or_domains")
        .is_some()
    {
        json!({"site_ids_or_domains":[id]})
    } else {
        return Err("MainWP has no supported exact-site sync parameter");
    };
    client.tool("sync_sites_v1", args).await?;
    let after = client
        .tool(
            "get_site_v1",
            json!({"site_id_or_domain":target.as_str(),"include_stats":false}),
        )
        .await?;
    if site_id(&after, &target)? != id {
        return Err("MainWP website identity changed during discovery");
    }
    let synced = after["last_sync"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp());
    if !synced.is_some_and(|s| s >= started && s <= chrono::Utc::now().timestamp() + 60) {
        return Err("MainWP found the website but a fresh targeted sync could not be verified");
    }
    if after["status"] != "connected" {
        return Ok(finding("Disconnected", "The exact website is registered in MainWP but reports a disconnected child-site status after sync"));
    }
    Ok(finding(
        "Connected",
        "Exact website verified on wpcontrol.mrndev.io after a fresh targeted sync",
    ))
}

pub(super) async fn discover(home: &Path, website: &str) -> ProjectFinding {
    match tokio::time::timeout(Duration::from_secs(75), inspect(home, website)).await {
        Ok(Ok(result)) => result,
        Ok(Err(message)) => finding("Not verified", message),
        Err(_) => finding(
            "Not verified",
            "MainWP discovery timed out; no alternate credentials or access route was attempted",
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_wrong_dashboard_and_wrong_site() {
        assert!(!valid_status(
            &json!({"connected":true,"dashboardHost":"other.example","abilitiesCount":189})
        ));
        assert!(!valid_status(
            &json!({"connected":true,"dashboardHost":"wpcontrol.mrndev.io","abilitiesCount":0})
        ));
        assert!(valid_status(
            &json!({"connected":true,"dashboardHost":"wpcontrol.mrndev.io","abilitiesCount":1})
        ));
        let url = website_url("https://example.com").unwrap();
        assert!(site_id(&json!({"id":5,"url":"https://wrong.example"}), &url).is_err());
        assert!(site_id(&json!({"id":0,"url":"https://example.com"}), &url).is_err());
    }

    #[test]
    fn stdio_discovery_scopes_sync_and_requires_fresh_readback() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
        let root = std::env::temp_dir().join(format!("monitor-mainwp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join(".codex")).unwrap();
        let script = root.join("fake.py");
        std::fs::write(&script, r#"
import sys,json,datetime
synced=False
for line in sys.stdin:
 q=json.loads(line)
 if 'id' not in q: continue
 m=q['method']; p=q.get('params',{}); result={}
 if m=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{},'serverInfo':{'name':'fixture','version':'1'}}
 elif m=='resources/read':
  assert p=={'uri':'mainwp://status'}
  result={'contents':[{'text':json.dumps({'connected':True,'dashboardHost':'wpcontrol.mrndev.io','abilitiesCount':2})}]}
 elif m=='tools/list': result={'tools':[{'name':'get_site_v1'},{'name':'sync_sites_v1','inputSchema':{'properties':{'site_ids':{}}}}]}
 elif m=='tools/call':
  name=p['name']; a=p['arguments']
  if name=='sync_sites_v1':
   assert a=={'site_ids':[7]}, 'Sync must never target all sites'
   synced=True; payload={'success':True}
  else:
   assert name=='get_site_v1' and a['site_id_or_domain']=='https://example.com/'
   at=datetime.datetime.now(datetime.timezone.utc).isoformat() if synced else '2000-01-01T00:00:00Z'
   payload={'id':7,'url':'https://example.com/','status':'connected','last_sync':at}
  result={'content':[{'type':'text','text':json.dumps(payload)}]}
 else: raise Exception('Unexpected method')
 print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':result}),flush=True)
"#).unwrap();
        let config = format!(
            "[mcp_servers.mainwp]\ncommand = \"python3\"\nargs = [{}]\n",
            serde_json::to_string(&script.to_string_lossy()).unwrap()
        );
        std::fs::write(root.join(".codex/config.toml"), config).unwrap();
        let result = discover(&root, "https://example.com/").await;
        let _ = std::fs::remove_dir_all(root);
        assert_eq!(result.value, "Connected", "{}", result.detail);
        });
    }
}
