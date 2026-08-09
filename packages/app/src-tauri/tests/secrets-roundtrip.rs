//! 回归测试：keyring 持久化闭环（set → 同实例读 → 新实例读 → 清理）。
//! 背景：keyring v3 默认 features 为空会落入 mock 后端，写入不持久化（新实例读不到）；
//! 本测试守住 Cargo.toml 的平台原生后端特性（windows-native/apple-native）不被意外丢掉。
//! 运行：cargo test --test secrets-roundtrip -- --nocapture

const SERVICE: &str = "com.xincmm.sageread";

#[test]
fn keyring_roundtrip() {
    let account = "diag:roundtrip-test";
    let value = "diag-value-12345";

    // 清理可能的残留
    if let Ok(entry) = keyring::Entry::new(SERVICE, account) {
        let _ = entry.delete_credential();
    }

    // 写入前：应为 NoEntry
    let entry = keyring::Entry::new(SERVICE, account).expect("Entry::new 失败");
    match entry.get_password() {
        Err(keyring::Error::NoEntry) => println!("OK 写入前为 NoEntry"),
        other => println!("WARN 写入前状态异常: {:?}", other.map(|_| "有值".to_string())),
    }

    // 写入
    entry.set_password(value).expect("set_password 失败");
    println!("OK set_password 成功");

    // 立即读取
    let got = entry.get_password().expect("写入后立即读取失败");
    assert_eq!(got, value, "写入后立即读取不一致");
    println!("OK 写入后立即读取一致");

    // 新建 Entry 再读（模拟重启后新进程读取）
    let entry2 = keyring::Entry::new(SERVICE, account).expect("Entry::new 第二次失败");
    match entry2.get_password() {
        Ok(v) => {
            assert_eq!(v, value, "新 Entry 读取不一致");
            println!("OK 新 Entry 实例读取一致（模拟重启后可读）");
        }
        Err(e) => panic!("新 Entry 读取失败（keyring 平台后端未启用，检查 Cargo.toml features）: {e}"),
    }

    // 清理
    entry2.delete_credential().expect("删除失败");
    println!("OK 清理完成");
}
