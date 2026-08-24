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

// ---- Windows：Job Object（孤儿进程防护，app 退出/崩溃时整树陪葬） ----
// 全局共享一个 Job Object（KILL_ON_JOB_CLOSE）：converter / paper_converter sidecar 与
// MCP stdio server 统一挂靠。Job 成员的子进程默认自动入 Job，PyInstaller 孙进程同样陪葬。

#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    // HANDLE 是裸指针（非 Send/Sync），以 usize 存 OnceLock
    static JOB: OnceLock<usize> = OnceLock::new();

    /// 全局 Job Object：最后一个句柄关闭（app 退出）时杀死全部挂靠进程
    fn global_job() -> HANDLE {
        let stored = *JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !job.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const std::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
            job as usize
        });
        stored as HANDLE
    }

    /// 按 pid 挂靠 Job（best-effort，失败仅意味着该进程失去孤儿防护）
    pub fn assign_by_pid(pid: u32) {
        unsafe {
            let job = global_job();
            if job.is_null() {
                return;
            }
            let handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if handle.is_null() {
                return;
            }
            AssignProcessToJobObject(job, handle);
            CloseHandle(handle);
        }
    }
}

/// 把进程挂靠进全局 Job Object（app 退出时陪葬）。非 Windows 无需（无 PyInstaller 双进程结构）。
#[cfg(windows)]
pub fn assign_by_pid(pid: u32) {
    job::assign_by_pid(pid);
}

/// 非 Windows 平台无 Job Object 机制，空实现。
#[cfg(not(windows))]
pub fn assign_by_pid(_pid: u32) {}

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
