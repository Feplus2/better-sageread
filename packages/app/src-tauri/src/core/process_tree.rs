//! 进程树终结（Windows）：converter / paper_converter 的 sidecar 是 PyInstaller 单文件包
//! （bootloader 父进程 + 实际转换子进程），`CommandChild::kill()`（TerminateProcess）
//! 只杀直接子进程 PID，孙进程孤儿化后继续拖 30-60 秒。取消语义要求整棵树都死。
//!
//! 时序注意：必须先 `kill_tree`（taskkill /T 沿树杀掉父+子），再让调用方 `child.kill()`
//! 兜底——顺序颠倒时父进程已死，taskkill /PID 找不到根，整棵树反而杀不掉。

/// 杀整棵进程树（best-effort、幂等：进程已退出时 taskkill 的报错被吞，不算失败）。
/// 参数走数组形式（不经 cmd 解析），路径/PID 不存在引号转义问题。
#[cfg(windows)]
pub async fn kill_tree(pid: u32) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = tokio::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .await;
}

/// 非 Windows：sidecar 无 PyInstaller bootloader 双进程结构，直接 kill 子进程即可（调用方负责）。
#[cfg(not(windows))]
pub async fn kill_tree(_pid: u32) {}

#[cfg(all(test, windows))]
mod tests {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    const STILL_ACTIVE: u32 = 259;

    /// pid 是否仍存活（进程对象存在且未退出）
    fn pid_alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(h, &mut code as *mut u32);
            CloseHandle(h);
            ok != 0 && code == STILL_ACTIVE
        }
    }

    /// 经 PowerShell CIM 查询某进程的直接子进程 pid（语言无关，只回数字）
    async fn child_pids(parent: u32) -> Vec<u32> {
        let out = tokio::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                &format!(
                    "Get-CimInstance Win32_Process -Filter \"ParentProcessId={}\" | Select-Object -ExpandProperty ProcessId",
                    parent
                ),
            ])
            .creation_flags(0x0800_0000)
            .output()
            .await;
        match out {
            Ok(o) => String::from_utf8_lossy(&o.stdout)
                .lines()
                .filter_map(|l| l.trim().parse::<u32>().ok())
                .collect(),
            Err(_) => vec![],
        }
    }

    #[tokio::test]
    async fn kill_tree_on_missing_pid_is_noop() {
        // 不存在的 PID：taskkill 报错被吞，函数正常返回（幂等容错）
        super::kill_tree(u32::MAX - 1).await;
    }

    #[tokio::test]
    async fn kill_tree_kills_whole_tree() {
        // 造一棵真树：cmd（根）→ ping（子，-t 永续）；模拟 PyInstaller 父子结构
        let mut cmd = tokio::process::Command::new("cmd")
            .args(["/c", "ping -t 127.0.0.1 > nul"])
            .creation_flags(0x0800_0000)
            .spawn()
            .expect("spawn cmd");
        let root = cmd.id().expect("cmd pid");
        // 等 ping 起来
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let grandchildren = child_pids(root).await;

        super::kill_tree(root).await;
        // taskkill 返回后树已死；根进程收尸
        let _ = cmd.wait().await;

        assert!(!pid_alive(root), "根进程 cmd 应被 taskkill /T /F 杀掉");
        assert!(
            !grandchildren.is_empty(),
            "ping 子进程应已被发现（否则本测试未真正覆盖树杀）"
        );
        for gc in grandchildren {
            assert!(!pid_alive(gc), "孙进程 ping (pid={}) 应随树杀退出", gc);
        }
    }
}
