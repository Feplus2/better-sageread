; ============================================================================
; Tauri NSIS 安装器钩子（tauri.conf.json → bundle.windows.nsis.installerHooks）
;
; 迁移断层修复（2026-09-10）：v0.2.0–v0.2.2 未配 installMode，按 Tauri 默认
; currentUser 模式安装，安装目录记录在 HKCU\Software\bettersageread\Better SageRead；
; v0.2.3 起钉死 perMachine，更新器拉起的安装器只从 HKLM 恢复安装位置（模板
; RestorePreviousInstallLocation 读 SHCTX），读不到旧记录便回退默认目录
; C:\Program Files——用户反馈「装在 E 盘、更新后 exe 跑到 C 盘」即此断层
; （旧快捷方式仍指 E: 旧 exe，还会反复弹更新提示）。
;
; 对策：HKLM 无记录（= 模板没能恢复安装位置，$INSTDIR 已是默认目录）且
; HKCU 留有旧记录、旧目录里确有主程序时，把 $INSTDIR 改回旧目录。
; 失败方向 = 不动作：任一步读不到都维持模板默认行为，与修复前完全一致。
; PREINSTALL 在 Section Install 开头、复制文件/写注册表/建快捷方式之前执行；
; 本次安装完成后模板会把新位置写入 HKLM，此后更新即稳定。
; ============================================================================
!macro NSIS_HOOK_PREINSTALL
  Push $5
  ReadRegStr $5 HKLM "Software\bettersageread\Better SageRead" ""
  ${If} $5 == ""
    ReadRegStr $5 HKCU "Software\bettersageread\Better SageRead" ""
    ${If} $5 != ""
    ${AndIf} ${FileExists} "$5\better-sageread.exe"
      StrCpy $INSTDIR $5
    ${EndIf}
  ${EndIf}
  Pop $5
!macroend
