use std::collections::HashSet;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter, Manager};

fn is_project_root(path: &Path) -> bool {
    path.join("config.json").is_file() && path.join("package.json").is_file()
}

fn app_root_file(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("project-root.txt"))
        .map_err(|e| format!("无法定位应用配置目录: {}", e))
}

// 根目录解析顺序：AIPUNCH_ROOT → 应用内保存的路径 → cwd / exe 祖先目录自动探测 → 主目录浅扫。
// 打包后从 Finder 启动时 cwd 是 /，前三步都会落空，最后一步按仓库名兜底。
fn find_project_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var("AIPUNCH_ROOT") {
        let path = PathBuf::from(root);
        if is_project_root(&path) {
            return Ok(path.canonicalize().unwrap_or(path));
        }
    }

    if let Ok(root_file) = app_root_file(app) {
        if let Ok(saved) = fs::read_to_string(&root_file) {
            let path = PathBuf::from(saved.trim());
            if is_project_root(&path) {
                return Ok(path.canonicalize().unwrap_or(path));
            }
        }
    }

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for candidate in [cwd.clone(), cwd.join(".."), cwd.join("../..")] {
        if is_project_root(&candidate) {
            return Ok(candidate.canonicalize().unwrap_or(candidate));
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        let mut curr = exe_path.parent();
        while let Some(dir) = curr {
            if is_project_root(dir) {
                return Ok(dir.to_path_buf());
            }
            curr = dir.parent();
        }
    }

    if let Some(home) = home_dir() {
        if let Some(found) = scan_for_root(&home, 2) {
            let canonical = found.canonicalize().unwrap_or(found);
            // 找到就记下来，下次启动不再扫
            let _ = persist_project_root(app, &canonical);
            return Ok(canonical);
        }
    }

    Err("未找到项目根目录（含 config.json 的仓库路径）：请在「隐私设置」中填写，或设置 AIPUNCH_ROOT".into())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

// 只认 package.json 里 name=aipunch 的仓库：主目录下同名 config.json 的项目很多，不能见 config 就收
fn is_aipunch_repo(path: &Path) -> bool {
    if !is_project_root(path) {
        return false;
    }
    fs::read_to_string(path.join("package.json"))
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|json| json.get("name")?.as_str().map(|name| name == "aipunch"))
        .unwrap_or(false)
}

// 在主目录下按层宽度优先地找 aipunch 仓库；同层先全查完再下潜，浅的优先。
// ponytail: 只看 2 层、最多 2000 个目录，够覆盖 ~/Sites/aipunch 这类常见布局，更深的靠手动指定。
fn scan_for_root(start: &Path, depth: u32) -> Option<PathBuf> {
    let mut budget = 2000usize;
    scan_dir(start, depth, &mut budget)
}

fn scan_dir(dir: &Path, depth: u32, budget: &mut usize) -> Option<PathBuf> {
    if depth == 0 || *budget == 0 {
        return None;
    }
    *budget -= 1;
    let mut subdirs = Vec::new();
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // 隐藏目录、node_modules、Library 里不可能有仓库，却是目录数的大头
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "node_modules" || name == "Library" {
            continue;
        }
        if is_aipunch_repo(&path) {
            return Some(path);
        }
        subdirs.push(path);
    }
    for path in subdirs {
        if let Some(found) = scan_dir(&path, depth - 1, budget) {
            return Some(found);
        }
    }
    None
}

// ---- 内置引擎：安装包 Resources 下带 node + 签到脚本；存在时不再依赖仓库 ----
fn bundled_engine_root(app: &AppHandle) -> Option<PathBuf> {
    let resource_dir = app.path().resource_dir().ok()?;
    let node_name = if cfg!(windows) { "node.exe" } else { "node" };
    for base in [resource_dir.join("resources"), resource_dir] {
        if base.join("engine").join("cli.mjs").is_file() && base.join(node_name).is_file() {
            return Some(base);
        }
    }
    None
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法定位应用数据目录: {}", e))?
        .join("engine-data");
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    Ok(dir)
}

// 首次使用：写入默认 config.json；若检测到旧的仓库模式数据，迁移 .env 与结果文件
fn seed_engine_data(app: &AppHandle, engine: &Path, dir: &Path) {
    let config = dir.join("config.json");
    let default_config = engine.join("engine").join("config.default.json");
    if !config.exists() {
        let _ = fs::copy(&default_config, &config);
    } else if let (Ok(existing), Ok(default)) = (
        fs::read_to_string(&config),
        fs::read_to_string(&default_config),
    ) {
        // 旧数据目录补上新增的顶层字段（如 repo），用户自定义账号配置保持不变
        if let (Ok(mut value), Ok(default_value)) = (
            serde_json::from_str::<serde_json::Value>(&existing),
            serde_json::from_str::<serde_json::Value>(&default),
        ) {
            if value.get("repo").is_none() {
                if let Some(repo) = default_value.get("repo") {
                    value["repo"] = repo.clone();
                    if let Ok(text) = serde_json::to_string_pretty(&value) {
                        let _ = atomic_write(&config, &text);
                    }
                }
            }
        }
    }
    if let Ok(legacy) = find_project_root(app) {
        for name in [".env", ".aipunch-last-run.json", ".aipunch-runs.json"] {
            let src = legacy.join(name);
            let dst = dir.join(name);
            if !dst.exists() && src.is_file() {
                let _ = fs::copy(&src, &dst);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let _ = fs::set_permissions(&dst, fs::Permissions::from_mode(0o600));
                }
            }
        }
    }
}

fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(engine) = bundled_engine_root(app) {
        let dir = app_data_dir(app)?;
        seed_engine_data(app, &engine, &dir);
        Ok(dir)
    } else {
        find_project_root(app)
    }
}

fn script_file(script: &str) -> Option<&'static str> {
    Some(match script {
        "checkin" => "cli.mjs",
        "ci-checkin" => "ci-checkin.mjs",
        // 云端结果拉取（只读不触发）：启动/手动刷新同步「今日已签」状态（ADR 0004）
        "ci-sync" => "ci-sync.mjs",
        // Cloudflare Workers 代部署与立即执行（ADR 0004 P2）
        "cf-deploy" => "cf-deploy.mjs",
        // 云端平台可达性检查（GitHub / Cloudflare API 域）
        "netcheck" => "netcheck.mjs",
        "trae-extract" => "trae-extract.mjs",
        "trae-login" => "trae-login.mjs",
        "qoder-login" => "qoder-login.mjs",
        "codearts-login" => "codearts-login.mjs",
        "autoclaw-login" => "autoclaw-login.mjs",
        "autoclaw-intl-login" => "autoclaw-intl-login.mjs",
        "login" => "login.mjs",
        _ => return None,
    })
}

#[tauri::command]
fn get_runtime_info(app: AppHandle) -> Result<serde_json::Value, String> {
    let bundled = bundled_engine_root(&app).is_some();
    let dir = work_dir(&app)?;
    Ok(serde_json::json!({
        "bundled": bundled,
        "workDir": dir.display().to_string(),
    }))
}

fn persist_project_root(app: &AppHandle, path: &Path) -> Result<(), String> {
    let root_file = app_root_file(app)?;
    if let Some(parent) = root_file.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {}", e))?;
    }
    fs::write(&root_file, path.display().to_string())
        .map_err(|e| format!("保存项目根目录失败: {}", e))
}

#[tauri::command]
fn get_project_root(app: AppHandle) -> Result<String, String> {
    work_dir(&app).map(|path| path.display().to_string())
}

#[tauri::command]
fn set_project_root(app: AppHandle, path: String) -> Result<String, String> {
    if bundled_engine_root(&app).is_some() {
        return Err("内置引擎模式无需设置引擎目录，凭证与记录保存在应用数据目录".into());
    }
    let path = PathBuf::from(path.trim());
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("路径不存在: {}", e))?;
    if !is_project_root(&canonical) {
        return Err("该目录不是 AIPunch 仓库根（缺少 config.json 或 package.json）".into());
    }
    persist_project_root(&app, &canonical)?;
    Ok(canonical.display().to_string())
}

#[tauri::command]
fn get_config(app: AppHandle) -> Result<String, String> {
    let root = work_dir(&app)?;
    let config_path = root.join("config.json");
    if !config_path.exists() {
        return Err("config.json not found".to_string());
    }
    fs::read_to_string(&config_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_run_history(app: AppHandle) -> Result<serde_json::Value, String> {
    // ci-checkin 每次运行追加一条，最多 50 条；不存在时返回空数组
    let root = work_dir(&app)?;
    let path = root.join(".aipunch-runs.json");
    if !path.exists() {
        return Ok(serde_json::json!([]));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<serde_json::Value>(&content).map_err(|e| format!("Invalid JSON: {}", e))
}

#[tauri::command]
fn get_last_run(app: AppHandle) -> Result<Option<serde_json::Value>, String> {
    // ci-checkin 下载 CI 产物后写入，卡片余额据此展示；不存在时返回 null
    let root = work_dir(&app)?;
    let path = root.join(".aipunch-last-run.json");
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str::<serde_json::Value>(&content)
        .map(Some)
        .map_err(|e| format!("Invalid JSON: {}", e))
}

#[tauri::command]
fn save_config(app: AppHandle, content: String) -> Result<(), String> {
    // Validate that content is valid JSON
    let _v: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| format!("Invalid JSON: {}", e))?;
    let root = work_dir(&app)?;
    let config_path = root.join("config.json");
    atomic_write(&config_path, &content)
}

fn parse_env_keys(content: &str) -> HashSet<String> {
    content
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                return None;
            }
            let (key, value) = trimmed.split_once('=')?;
            let (key, value) = (key.trim(), value.trim());
            (!key.is_empty() && !value.is_empty()).then(|| key.to_string())
        })
        .collect()
}

// 只回传键名、不回值：.env 与进程环境任一有非空值即算已配置
fn configured_keys(
    requested: &[String],
    file_keys: &HashSet<String>,
    in_process: &dyn Fn(&str) -> bool,
) -> Vec<String> {
    requested
        .iter()
        .filter(|key| file_keys.contains(*key) || in_process(key))
        .cloned()
        .collect()
}

#[tauri::command]
fn get_env_status(app: AppHandle, keys: Vec<String>) -> Result<Vec<String>, String> {
    let root = work_dir(&app)?;
    let file_keys = fs::read_to_string(root.join(".env"))
        .map(|content| parse_env_keys(&content))
        .unwrap_or_default();
    Ok(configured_keys(&keys, &file_keys, &|key| {
        std::env::var_os(key).is_some_and(|value| !value.is_empty())
    }))
}

#[tauri::command]
fn get_privacy_mode(app: AppHandle) -> Result<bool, String> {
    let root = work_dir(&app)?;
    let env_path = root.join(".env");
    if env_path.exists() {
        if let Ok(content) = fs::read_to_string(&env_path) {
            for line in content.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("CHECKIN_NO_DISCOVERY=") {
                    let val = trimmed.trim_start_matches("CHECKIN_NO_DISCOVERY=").trim();
                    return Ok(val == "1" || val.eq_ignore_ascii_case("true"));
                }
            }
        }
    }
    if let Ok(val) = std::env::var("CHECKIN_NO_DISCOVERY") {
        return Ok(val == "1" || val.eq_ignore_ascii_case("true"));
    }
    Ok(false)
}

#[tauri::command]
fn set_privacy_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    let _guard = ENV_LOCK.lock().map_err(|_| "环境变量文件锁不可用".to_string())?;
    let root = work_dir(&app)?;
    write_env_var(
        &root.join(".env"),
        "CHECKIN_NO_DISCOVERY",
        if enabled { "1" } else { "0" },
    )
}

#[tauri::command]
fn run_script_stream(
    app: AppHandle,
    state: tauri::State<'_, RunnerState>,
    script_name: String,
    args: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    let root = work_dir(&app)?;
    let engine = bundled_engine_root(&app);
    let slot = state.0.clone();

    // 工作目录显式注入子进程：runner 读写 .env/config 不依赖 cwd 假设
    // （此前 cf-deploy 按 process.cwd() 定位 .env，dev/安装模式下 cwd 错位导致 CF 配置回写丢失）
    let mut env_workdir = std::collections::HashMap::new();
    env_workdir.insert("AIPUNCH_WORK_DIR".to_string(), root.display().to_string());

    // 内置引擎：直接跑 Resources 里的 node + 打包脚本；开发模式回退到仓库 + npm
    let mut cmd = if let Some(engine) = &engine {
        let node = engine.join(if cfg!(windows) { "node.exe" } else { "node" });
        let file = script_file(&script_name).ok_or_else(|| format!("未知脚本: {}", script_name))?;
        let mut c = Command::new(node);
        c.current_dir(&root);
        // gh CLI 等外部命令需要 homebrew 路径（launchd 继承的 PATH 很短）
        apply_node_path(&mut c);
        c.arg(engine.join("engine").join(file));
        c
    } else {
        let mut c = Command::new(npm_bin());
        c.current_dir(&root);
        apply_node_path(&mut c);
        c.arg("run").arg(&script_name);
        c
    };
    if !args.is_empty() {
        if engine.is_none() {
            cmd.arg("--");
        }
        for arg in &args {
            cmd.arg(arg);
        }
    }
    // 凭据走环境变量而不是命令行参数，避免出现在 ps 的命令行里；工作目录注入对全部 runner 生效
    if let Some(env) = env {
        env_workdir.extend(env);
    }
    cmd.envs(env_workdir);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    // 独立进程组：停止时能连 npm 派生的 node/tsx 一起杀掉
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // 「检查空闲」和「登记占用」必须在同一把锁里：中间夹 spawn 就有竞态窗口，
    // 两个 invoke 会各起一个进程，后登记的句柄覆盖前者，被覆盖的进程再也 kill 不到
    let (stdout, stderr) = {
        let mut guard = slot.lock().map_err(|_| "任务状态锁不可用".to_string())?;
        if guard.is_some() {
            return Err("已有任务在运行".to_string());
        }
        let mut child = cmd.spawn().map_err(|e| format!("启动进程失败: {}", e))?;
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        *guard = Some(child);
        (stdout, stderr)
    };

    let _ = app.emit("console-log", format!("[START] Executing {}...", script_name));

    thread::spawn(move || {
        let app_out = app.clone();
        let h_out = thread::spawn(move || {
            if let Some(out) = stdout {
                let reader = BufReader::new(out);
                for line in reader.lines().flatten() {
                    let _ = app_out.emit("console-log", line);
                }
            }
        });

        let app_err = app.clone();
        let h_err = thread::spawn(move || {
            if let Some(err) = stderr {
                let reader = BufReader::new(err);
                for line in reader.lines().flatten() {
                    let _ = app_err.emit("console-log", line);
                }
            }
        });

        let _ = h_out.join();
        let _ = h_err.join();

        // 轮询 try_wait 而非阻塞 wait：stop_script 需要拿到同一把锁才能 kill
        let status = loop {
            let polled = match slot.lock() {
                Ok(mut guard) => guard.as_mut().map(|child| child.try_wait()),
                Err(_) => break None,
            };
            match polled {
                Some(Ok(Some(status))) => break Some(status),
                Some(Ok(None)) => thread::sleep(Duration::from_millis(100)),
                _ => break None,
            }
        };
        if let Ok(mut guard) = slot.lock() {
            *guard = None;
        }

        let code = match status {
            Some(s) => s.code().unwrap_or(-1),
            None => -1,
        };

        let _ = app.emit("console-log", format!("[DONE] Process exited with code {}", code));
        let _ = app.emit("script-finished", code);
    });

    Ok(())
}

// 终止当前任务：按平台杀掉整棵进程树，管道关闭后上面的轮询收尾并发 script-finished
#[tauri::command]
fn stop_script(state: tauri::State<'_, RunnerState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "任务状态锁不可用".to_string())?;
    if let Some(child) = guard.as_mut() {
        #[cfg(target_os = "macos")]
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGKILL);
        }
        // Windows 没有进程组：npm.cmd 派生的 node/tsx 只能按进程树杀，否则会变孤儿
        #[cfg(target_os = "windows")]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[tauri::command]
fn open_external(target: String) -> Result<(), String> {
    let is_url = target.starts_with("http://") || target.starts_with("https://");
    if is_url {
        #[cfg(target_os = "macos")]
        {
            Command::new("open")
                .arg(&target)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        // 走 argv 而不是 cmd /C，避免 URL 里的 & 被 cmd 当成命令分隔符
        #[cfg(target_os = "windows")]
        {
            Command::new("rundll32")
                .args(["url.dll,FileProtocolHandler", &target])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Command::new("xdg-open")
                .arg(&target)
                .spawn()
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg("-a")
            .arg(&target)
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    // Windows 没有按应用显示名调起客户端的等价能力，交给开始菜单
    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Err("当前系统不支持按应用名调起本地客户端，请从开始菜单启动".into())
    }
}

#[tauri::command]
fn set_env_variable(app: AppHandle, key: String, value: String) -> Result<(), String> {

    let _guard = ENV_LOCK.lock().map_err(|_| "环境变量文件锁不可用".to_string())?;
    let root = work_dir(&app)?;
    write_env_var(&root.join(".env"), &key, value.trim())
}

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

static ENV_LOCK: Mutex<()> = Mutex::new(());

// 当前运行的 npm 子进程；手动终止用（OAuth 等待等常驻脚本会锁住 UI）
type ChildSlot = Arc<Mutex<Option<std::process::Child>>>;

struct RunnerState(ChildSlot);

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn upsert_env(content: &str, key: &str, value: &str) -> String {
    let line = format!("{}={}", key, value);
    let prefix = format!("{}=", key);
    let mut replaced = false;
    let mut out: Vec<String> = Vec::new();
    for existing in content.lines() {
        if !replaced && existing.trim_start().starts_with(&prefix) {
            out.push(line.clone());
            replaced = true;
        } else {
            out.push(existing.to_string());
        }
    }
    if !replaced {
        out.push(line);
    }
    format!("{}\n", out.join("\n"))
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("env");
    let tmp = path.with_file_name(format!("{}.tmp", name));
    fs::write(&tmp, content).map_err(|e| format!("写入临时文件失败: {}", e))?;
    // .env 存的是 refreshToken：临时文件落盘即 0600，避免 rename 前有一段时间是 umask 默认权限
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("设置 {} 权限失败: {}", tmp.display(), e));
        }
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("替换 {} 失败: {}", path.display(), e)
    })
}

// 读取失败必须报错：否则会拿空内容覆盖掉其他凭证。写入走临时文件 + rename。
fn write_env_var(path: &Path, key: &str, value: &str) -> Result<(), String> {
    if !is_valid_env_key(key) {
        return Err(format!("非法环境变量名: {}", key));
    }
    if value.contains('\n') || value.contains('\r') {
        return Err("环境变量值不能包含换行".into());
    }
    let content = if path.exists() {
        fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {}", path.display(), e))?
    } else {
        String::new()
    };
    atomic_write(path, &upsert_env(&content, key, value))?;
    Ok(())
}

fn npm_bin() -> String {
    if cfg!(windows) {
        return "npm.cmd".to_string();
    }
    for candidate in ["/opt/homebrew/bin/npm", "/usr/local/bin/npm"] {
        if Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "npm".to_string()
}

// GUI 启动的进程 PATH 不含 Homebrew；npm 的 shebang 也需要 node 在 PATH 里
fn apply_node_path(cmd: &mut Command) {
    let separator = if cfg!(windows) { ";" } else { ":" };
    let mut dirs: Vec<String> = Vec::new();
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        if Path::new(dir).is_dir() {
            dirs.push(dir.to_string());
        }
    }
    if let Ok(path) = std::env::var("PATH") {
        dirs.push(path);
    }
    cmd.env("PATH", dirs.join(separator));
}

#[cfg(target_os = "macos")]
use objc2_app_kit::NSWindow;
#[cfg(target_os = "macos")]
use objc2_foundation::NSRect;

#[cfg(target_os = "macos")]
static SAVED_RESTORE_FRAME: Mutex<Option<NSRect>> = Mutex::new(None);
static LAST_MAXIMIZE_TOGGLE: Mutex<Option<Instant>> = Mutex::new(None);

#[tauri::command]
fn toggle_maximize(window: tauri::Window) -> Result<(), String> {
    let mut last = LAST_MAXIMIZE_TOGGLE
        .lock()
        .map_err(|_| "最大化状态锁不可用".to_string())?;
    if let Some(prev) = *last {
        if prev.elapsed().as_millis() < 400 {
            return Ok(());
        }
    }
    *last = Some(Instant::now());

    #[cfg(target_os = "macos")]
    {
        if let Ok(ptr) = window.ns_window() {
            unsafe {
                if let Some(ns_win) = (ptr as *mut NSWindow).as_ref() {
                    let mut saved = SAVED_RESTORE_FRAME
                        .lock()
                        .map_err(|_| "窗口尺寸锁不可用".to_string())?;
                    let current_frame = ns_win.frame();

                    let is_full = if let Some(screen) = ns_win.screen() {
                        let vf = screen.visibleFrame();
                        (current_frame.size.width - vf.size.width).abs() < 4.0
                            && (current_frame.size.height - vf.size.height).abs() < 4.0
                    } else {
                        ns_win.isZoomed()
                    };

                    if is_full {
                        let restore_rect = saved.take().unwrap_or_else(|| {
                            let mut r = current_frame;
                            r.size.width = 1180.0;
                            r.size.height = 740.0;
                            r
                        });
                        ns_win.setFrame_display_animate(restore_rect, true, true);
                    } else {
                        *saved = Some(current_frame);
                        if let Some(screen) = ns_win.screen() {
                            let target_rect = screen.visibleFrame();
                            ns_win.setFrame_display_animate(target_rect, true, true);
                        } else {
                            ns_win.zoom(None);
                        }
                    }
                }
            }
            return Ok(());
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if let Ok(is_max) = window.is_maximized() {
            if is_max {
                let _ = window.unmaximize();
            } else {
                let _ = window.maximize();
            }
        }
    }

    Ok(())
}

#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RunnerState(Arc::new(Mutex::new(None))))
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_last_run,
            get_run_history,
            get_runtime_info,
            get_env_status,
            get_privacy_mode,
            set_privacy_mode,
            run_script_stream,
            stop_script,
            open_external,
            set_env_variable,
            toggle_maximize,
            restart_app,
            get_project_root,
            set_project_root
        ])
        .run(tauri::generate_context!())
        .expect("error while building aipunch tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_env_path() -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("aipunch-env-test-{}-{}.env", std::process::id(), nanos))
    }

    #[test]
    fn upsert_replaces_existing_and_keeps_others() {
        let out = upsert_env("# comment\nFOO=1\nWORKBUDDY_REFRESH_TOKEN=old\nBAR=2\n", "WORKBUDDY_REFRESH_TOKEN", "new");
        assert_eq!(out, "# comment\nFOO=1\nWORKBUDDY_REFRESH_TOKEN=new\nBAR=2\n");
    }

    #[test]
    fn upsert_appends_missing_key() {
        assert_eq!(upsert_env("FOO=1\n", "BAR", "2"), "FOO=1\nBAR=2\n");
        assert_eq!(upsert_env("", "BAR", "2"), "BAR=2\n");
    }

    #[test]
    fn env_key_validation() {
        assert!(is_valid_env_key("WORKBUDDY_REFRESH_TOKEN"));
        assert!(is_valid_env_key("_PRIVATE"));
        assert!(!is_valid_env_key(""));
        assert!(!is_valid_env_key("BAD-KEY"));
        assert!(!is_valid_env_key("A=B"));
        assert!(!is_valid_env_key("A\nB"));
    }

    #[test]
    fn write_env_var_rejects_injection_and_preserves_file() {
        let path = temp_env_path();
        fs::write(&path, "FOO=1\n").unwrap();
        assert!(write_env_var(&path, "FOO", "a\nNODE_OPTIONS=--require x").is_err());
        assert!(write_env_var(&path, "BAD KEY", "x").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "FOO=1\n");
        let _ = fs::remove_file(&path);
    }

    #[cfg(unix)]
    #[test]
    fn write_env_var_sets_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_env_path();
        write_env_var(&path, "FOO", "1").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn write_env_var_preserves_other_credentials() {
        let path = temp_env_path();
        fs::write(&path, "FOO=1\nCHECKIN_NO_DISCOVERY=0\n").unwrap();
        write_env_var(&path, "CHECKIN_NO_DISCOVERY", "1").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "FOO=1\nCHECKIN_NO_DISCOVERY=1\n");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn project_root_check_requires_config_and_package() {
        assert!(!is_project_root(Path::new("/definitely/not/aipunch")));
    }

    fn temp_repo_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        std::env::temp_dir().join(format!("aipunch-scan-{}-{}-{}", tag, std::process::id(), nanos))
    }

    fn write_repo(dir: &Path, name: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("config.json"), "{}").unwrap();
        fs::write(dir.join("package.json"), format!(r#"{{"name":"{}"}}"#, name)).unwrap();
    }

    #[test]
    fn scan_finds_aipunch_repo_below_home() {
        let base = temp_repo_dir("nested");
        write_repo(&base.join("Sites/aipunch"), "aipunch");
        assert_eq!(
            scan_for_root(&base, 2).unwrap(),
            base.join("Sites/aipunch"),
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn scan_ignores_other_repos_and_respects_depth() {
        let base = temp_repo_dir("decoy");
        write_repo(&base.join("work/other-project"), "other");
        write_repo(&base.join("a/b/aipunch"), "aipunch");
        assert_eq!(scan_for_root(&base, 2), None);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn configured_keys_merges_env_file_and_process() {
        let mut file_keys = HashSet::new();
        file_keys.insert("WORKBUDDY_REFRESH_TOKEN".to_string());
        let requested = vec![
            "WORKBUDDY_REFRESH_TOKEN".to_string(),
            "TRAE_DEVICE_ID".to_string(),
            "QODER_REFRESH_TOKEN".to_string(),
        ];
        let in_process = |key: &str| key == "TRAE_DEVICE_ID";
        assert_eq!(
            configured_keys(&requested, &file_keys, &in_process),
            vec!["WORKBUDDY_REFRESH_TOKEN".to_string(), "TRAE_DEVICE_ID".to_string()]
        );
    }

    #[test]
    fn parse_env_keys_skips_comments_and_empty_values() {
        let keys = parse_env_keys("# 注释\nFOO=1\nBAR=\nBAZ=\"x\"\n");
        assert!(keys.contains("FOO"));
        assert!(keys.contains("BAZ"));
        assert!(!keys.contains("BAR"));
        assert_eq!(keys.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_creates_owner_only_file() {
        use std::os::unix::fs::PermissionsExt;
        let path = temp_env_path();
        atomic_write(&path, "SECRET=1\n").unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_file(&path);
    }
}
