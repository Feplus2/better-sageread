// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

mod core;
use crate::core::{
    agent_ws::commands::{
        agent_edit_file, agent_read_file, agent_resolve_path, agent_run_command, agent_search_files,
        agent_write_file,
    },
    books::commands::{
        create_book_note,
        create_reading_session,
        delete_ai_book_notes,
        delete_book,
        delete_book_note,
        get_active_reading_session,
        get_all_book_notes,
        get_all_reading_sessions,
        get_book_by_id,
        get_book_notes,
        get_book_status,
        get_book_with_status_by_id,
        get_books,
        get_books_with_status,
        get_reading_session,
        get_reading_sessions_by_book,
        get_trashed_books,
        path_exists,
        purge_book,
        replace_paper_content,
        restore_book,
        save_book,
        save_paper,
        scan_papers_dir,
        update_book,
        update_book_note,
        update_book_status,
        update_reading_session,
    },
    database,
    converter::{cancel_convert, convert_pdf_to_epub, ConverterState},
    paper_converter::{cancel_paper_convert, convert_paper_pdf, PaperConverterState},
    fonts::commands::{upload_and_convert_font, upload_font_data},
    llama::commands::{
        delete_local_model, download_llama_server, download_model_file,
        ensure_llamacpp_directories, get_app_data_dir, get_llamacpp_backend_path, greet,
        list_local_models, llama_server_binary_name_cmd,
    },
    papers::commands::{
        create_folder, delete_folder, get_paper_folder_map, list_folders, list_trashed_folders,
        move_folder, purge_folder, rename_folder, restore_folder, set_paper_folders,
    },
    prompts::commands::{
        clear_active_prompt_preset, create_prompt_preset, delete_prompt_preset,
        get_active_prompt_preset, list_prompt_presets, set_active_prompt_preset,
        update_prompt_preset,
    },
    skills::commands::{
        create_skill, delete_skill, get_skill_by_id, get_skills, toggle_skill_active,
        update_skill,
    },
    state::AppState,
    sync::commands::{
        sync_backup_now, sync_delete_backup, sync_download_book, sync_get_cloud_assets,
        sync_get_cloud_books, sync_get_config, sync_get_l2_status, sync_get_state,
        sync_get_ui_config, sync_has_unpushed, sync_list_backups, sync_list_l2_snapshots,
        sync_pull_now, sync_put_ui_config, sync_restore, sync_restart_app, sync_rollback,
        sync_rollback_l2, sync_run_now, sync_save_config, sync_test_connection,
        sync_update_prefs, sync_upload_all_books, sync_upload_book,
    },
    tags::commands::{
        create_tag, delete_tag, get_tag_by_id, get_tag_by_name, get_tags, update_tag,
    },
    threads::commands::{
        create_thread, delete_thread, edit_thread, get_all_threads, get_global_threads,
        get_latest_thread_by_book_id, get_thread_by_id, get_threads_by_book_id,
    },
    web_search::web_search,
    zotero::{
        inject_zotero_key, list_paper_dedup_keys, zotero_get_state, zotero_scan_library,
        zotero_upsert_collection, zotero_upsert_paper_state,
    },
};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(AppState::default())
        .manage(ConverterState::default())
        .manage(PaperConverterState::default())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_llamacpp::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_epub::init())
        .setup(|app| {
            let app_handle = app.handle().clone();
            if std::env::consts::OS == "windows" {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.set_decorations(false) {
                        eprintln!("Failed to set window decorations: {}", e);
                    }
                }
            }
            
            // Check for updates on startup
            #[cfg(not(debug_assertions))]
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use tauri_plugin_updater::UpdaterExt;
                    match handle.updater() {
                        Ok(updater) => match updater.check().await {
                            Ok(Some(update)) => {
                                if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                                    log::error!("Failed to install update: {}", e);
                                }
                            }
                            Ok(None) => {
                                log::info!("No update available");
                            }
                            Err(e) => {
                                log::error!("Failed to check for updates: {}", e);
                            }
                        },
                        Err(e) => {
                            log::error!("Failed to get updater: {}", e);
                        }
                    }
                });
            }
            
            tauri::async_runtime::spawn(async move {
                // 启动时先应用待恢复数据（在数据库初始化之前）
                if let Err(e) = core::sync::restore::apply_pending_restore(&app_handle) {
                    log::error!("应用待恢复数据失败: {}", e);
                }

                let pool = database::initialize(&app_handle)
                    .await
                    .expect("Failed to initialize database");

                let state = app_handle.state::<AppState>();
                let mut db_pool_guard = state.db_pool.lock().await;
                *db_pool_guard = Some(pool);

                // 启动时清理回收站：超过保留期的书籍彻底删除
                drop(db_pool_guard);
                if let Err(e) = core::books::commands::purge_expired_trash(&app_handle).await {
                    log::error!("回收站自动清理失败: {}", e);
                }

                // 云端目录布局迁移（sageread-{sync,backups} → sageread/{sync,backups}），
                // 尽力而为：失败仅告警，后续同步/备份命令入口会重试；
                // 启动走 force 复查——用户可能在 WebDAV 后台手动搬了家
                if let Err(e) = core::sync::commands::migrate_cloud_layout_at_startup(&app_handle).await {
                    log::warn!("云端目录布局迁移未完成（下轮同步时重试）: {e}");
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            create_thread,
            edit_thread,
            delete_thread,
            get_latest_thread_by_book_id,
            get_threads_by_book_id,
            get_thread_by_id,
            get_all_threads,
            get_global_threads,
            save_book,
            get_books,
            get_book_by_id,
            update_book,
            delete_book,
            restore_book,
            get_trashed_books,
            purge_book,
            // papers (MARKDOWN 论文入库)
            scan_papers_dir,
            save_paper,
            replace_paper_content,
            path_exists,
            // papers (文献库文件夹)
            list_folders,
            list_trashed_folders,
            create_folder,
            rename_folder,
            delete_folder,
            restore_folder,
            purge_folder,
            move_folder,
            set_paper_folders,
            get_paper_folder_map,
            // zotero (Zotero 批量导入)
            zotero_scan_library,
            list_paper_dedup_keys,
            inject_zotero_key,
            zotero_get_state,
            zotero_upsert_collection,
            zotero_upsert_paper_state,
            get_book_status,
            update_book_status,
            get_books_with_status,
            get_book_with_status_by_id,
            // reading sessions
            create_reading_session,
            get_reading_session,
            update_reading_session,
            get_reading_sessions_by_book,
            get_active_reading_session,
            get_all_reading_sessions,
            // book notes
            create_book_note,
            get_book_notes,
            get_all_book_notes,
            update_book_note,
            delete_book_note,
            delete_ai_book_notes,
            create_tag,
            get_tags,
            get_tag_by_id,
            get_tag_by_name,
            update_tag,
            delete_tag,
            // skills
            create_skill,
            get_skills,
            get_skill_by_id,
            update_skill,
            delete_skill,
            toggle_skill_active,
            // prompt presets (提示词热插拔)
            list_prompt_presets,
            create_prompt_preset,
            update_prompt_preset,
            delete_prompt_preset,
            set_active_prompt_preset,
            clear_active_prompt_preset,
            get_active_prompt_preset,
            // fonts
            upload_and_convert_font,
            upload_font_data,
            // llama
            greet,
            get_app_data_dir,
            get_llamacpp_backend_path,
            ensure_llamacpp_directories,
            download_llama_server,
            llama_server_binary_name_cmd,
            list_local_models,
            download_model_file,
            delete_local_model,
            // sync (WebDAV 备份/恢复)
            sync_get_config,
            sync_save_config,
            sync_test_connection,
            sync_backup_now,
            sync_list_backups,
            sync_delete_backup,
            sync_get_state,
            sync_restore,
            sync_rollback,
            sync_restart_app,
            sync_get_l2_status,
            sync_run_now,
            sync_pull_now,
            sync_has_unpushed,
            sync_upload_book,
            sync_download_book,
            sync_get_cloud_books,
            sync_upload_all_books,
            sync_list_l2_snapshots,
            sync_rollback_l2,
            sync_get_cloud_assets,
            sync_put_ui_config,
            sync_get_ui_config,
            sync_update_prefs,
            web_search,
            // converter (PDF → EPUB)
            convert_pdf_to_epub,
            cancel_convert,
            // paper converter (单篇 PDF → paper.md)
            convert_paper_pdf,
            cancel_paper_convert,
            // agent workspace (P1：写工具/执行命令，路径守卫 + 审计)
            agent_resolve_path,
            agent_read_file,
            agent_write_file,
            agent_edit_file,
            agent_search_files,
            agent_run_command,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 阻止默认关闭：先完成退出前推送与进程清理，再主动销毁窗口
                api.prevent_close();
                let window = window.clone();
                tauri::async_runtime::spawn(async move {
                    let app_handle = window.app_handle().clone();

                    // 退出前推送：L2 开启且有未推送变更时同步一轮（5s 超时，失败不阻塞退出）
                    let exit_sync = async {
                        let config = crate::core::sync::commands::load_webdav_config(&app_handle)?;
                        if !config.l2_enabled || config.endpoint.is_empty() {
                            return Ok::<(), String>(());
                        }
                        let state = app_handle.state::<AppState>();
                        let pool_guard = state.db_pool.lock().await;
                        let Some(pool) = pool_guard.as_ref() else {
                            return Ok(());
                        };
                        let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
                        let sync_state = crate::core::sync::backup::read_sync_state(&config_dir);
                        if crate::core::sync::engine::has_unpushed(pool, sync_state.last_pushed_seq.unwrap_or(0))
                            .await?
                        {
                            log::info!("退出前推送未同步变更...");
                            crate::core::sync::engine::run_sync(&app_handle, pool, &config).await?;
                        }
                        Ok(())
                    };
                    let _ = tokio::time::timeout(std::time::Duration::from_secs(5), exit_sync).await;

                    if let Err(e) = tauri_plugin_llamacpp::cleanup_llama_processes(app_handle).await
                    {
                        log::error!("清理 llamacpp 进程失败: {}", e);
                    }

                    // destroy 不再触发 CloseRequested，避免循环
                    let _ = window.destroy();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
