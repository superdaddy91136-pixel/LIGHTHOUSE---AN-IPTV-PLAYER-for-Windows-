use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;

use crate::sql;
use crate::types::{Source, SourceDeviceRefreshStatus};
use crate::utils;

pub const AUTO_REFRESH_INTERVAL_SECS: i64 = 48 * 3600; // 48 hours (2 days)

#[cfg(target_os = "windows")]
pub mod network_cost {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct GUID {
        pub data1: u32,
        pub data2: u16,
        pub data3: u16,
        pub data4: [u8; 8],
    }

    // CLSID_NetworkListManager: DCB00C01-570F-4A9B-8D69-199FDBA5723B
    pub const CLSID_NETWORK_LIST_MANAGER: GUID = GUID {
        data1: 0xDCB00C01,
        data2: 0x570F,
        data3: 0x4A9B,
        data4: [0x8D, 0x69, 0x19, 0x9F, 0xDB, 0xA5, 0x72, 0x3B],
    };

    // IID_INetworkCostManager: DCB00008-570F-4A9B-8D69-199FDBA5723B
    pub const IID_INETWORK_COST_MANAGER: GUID = GUID {
        data1: 0xDCB00008,
        data2: 0x570F,
        data3: 0x4A9B,
        data4: [0x8D, 0x69, 0x19, 0x9F, 0xDB, 0xA5, 0x72, 0x3B],
    };

    pub const CLSCTX_INPROC_SERVER: u32 = 0x1;
    pub const CLSCTX_LOCAL_SERVER: u32 = 0x4;
    pub const CLSCTX_ALL: u32 = CLSCTX_INPROC_SERVER | CLSCTX_LOCAL_SERVER;

    pub const COINIT_MULTITHREADED: u32 = 0x0;

    pub const NLM_CONNECTION_COST_UNKNOWN: u32 = 0x0;
    pub const NLM_CONNECTION_COST_UNRESTRICTED: u32 = 0x1;
    pub const NLM_CONNECTION_COST_FIXED: u32 = 0x2;
    pub const NLM_CONNECTION_COST_VARIABLE: u32 = 0x4;
    pub const NLM_CONNECTION_COST_OVERDATALIMIT: u32 = 0x10000;
    pub const NLM_CONNECTION_COST_CONGESTED: u32 = 0x20000;
    pub const NLM_CONNECTION_COST_ROAMING: u32 = 0x40000;
    pub const NLM_CONNECTION_COST_APPROACHINGDATALIMIT: u32 = 0x80000;

    #[repr(C)]
    pub struct INetworkCostManagerVTable {
        pub query_interface:
            unsafe extern "system" fn(this: *mut c_void, riid: *const GUID, ppv: *mut *mut c_void) -> i32,
        pub add_ref: unsafe extern "system" fn(this: *mut c_void) -> u32,
        pub release: unsafe extern "system" fn(this: *mut c_void) -> u32,
        pub get_cost: unsafe extern "system" fn(
            this: *mut c_void,
            p_cost: *mut u32,
            p_dest_ip_addr: *const c_void,
        ) -> i32,
        pub get_data_plan_status: unsafe extern "system" fn(
            this: *mut c_void,
            p_data_plan_status: *mut c_void,
            p_dest_ip_addr: *const c_void,
        ) -> i32,
        pub set_destination_addresses: unsafe extern "system" fn(
            this: *mut c_void,
            length: u32,
            p_dest_ip_addr_list: *const c_void,
            b_sort_addresses: i32,
        ) -> i32,
    }

    #[link(name = "ole32")]
    unsafe extern "system" {
        pub fn CoInitializeEx(pv_reserved: *mut c_void, dw_co_init: u32) -> i32;
        pub fn CoUninitialize();
        pub fn CoCreateInstance(
            rclsid: *const GUID,
            p_unk_outer: *mut c_void,
            dw_cls_context: u32,
            riid: *const GUID,
            ppv: *mut *mut c_void,
        ) -> i32;
    }

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum NetworkCostStatus {
        Unmetered,
        Metered,
        UnknownOrOffline,
    }

    pub fn get_network_cost_status() -> NetworkCostStatus {
        unsafe {
            let hr_init = CoInitializeEx(std::ptr::null_mut(), COINIT_MULTITHREADED);
            let should_uninit = hr_init == 0 || hr_init == 1; // S_OK or S_FALSE

            let mut cost_mgr_ptr: *mut c_void = std::ptr::null_mut();
            let hr_create = CoCreateInstance(
                &CLSID_NETWORK_LIST_MANAGER,
                std::ptr::null_mut(),
                CLSCTX_ALL,
                &IID_INETWORK_COST_MANAGER,
                &mut cost_mgr_ptr,
            );

            if hr_create != 0 || cost_mgr_ptr.is_null() {
                if should_uninit {
                    CoUninitialize();
                }
                return NetworkCostStatus::UnknownOrOffline;
            }

            let vtable = *(cost_mgr_ptr as *mut *const INetworkCostManagerVTable);
            let mut cost: u32 = 0;
            let hr_cost = ((&*vtable).get_cost)(cost_mgr_ptr, &mut cost, std::ptr::null());

            // Release interface
            ((&*vtable).release)(cost_mgr_ptr);

            if should_uninit {
                CoUninitialize();
            }

            if hr_cost != 0 {
                return NetworkCostStatus::UnknownOrOffline;
            }

            if cost == NLM_CONNECTION_COST_UNKNOWN {
                return NetworkCostStatus::UnknownOrOffline;
            }

            const METERED_MASK: u32 = NLM_CONNECTION_COST_FIXED
                | NLM_CONNECTION_COST_VARIABLE
                | NLM_CONNECTION_COST_OVERDATALIMIT
                | NLM_CONNECTION_COST_CONGESTED
                | NLM_CONNECTION_COST_ROAMING
                | NLM_CONNECTION_COST_APPROACHINGDATALIMIT;

            if (cost & METERED_MASK) != 0 {
                return NetworkCostStatus::Metered;
            }

            if (cost & NLM_CONNECTION_COST_UNRESTRICTED) != 0 {
                return NetworkCostStatus::Unmetered;
            }

            NetworkCostStatus::UnknownOrOffline
        }
    }
}

#[cfg(not(target_os = "windows"))]
pub mod network_cost {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum NetworkCostStatus {
        Unmetered,
        Metered,
        UnknownOrOffline,
    }

    pub fn get_network_cost_status() -> NetworkCostStatus {
        NetworkCostStatus::Unmetered
    }
}

pub fn is_playback_active(app: &AppHandle) -> bool {
    let embedded_state = match app.try_state::<crate::embedded_poc::EmbeddedPocState>() {
        Some(s) => s,
        None => return false,
    };
    let pid = embedded_state.active_pid.load(Ordering::SeqCst);
    if pid == 0 {
        return false;
    }

    #[cfg(target_os = "windows")]
    unsafe {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn OpenProcess(
                dw_desired_access: u32,
                b_inherit_handle: i32,
                dw_process_id: u32,
            ) -> *mut std::ffi::c_void;
            fn GetExitCodeProcess(h_process: *mut std::ffi::c_void, lp_exit_code: *mut u32) -> i32;
            fn CloseHandle(h_object: *mut std::ffi::c_void) -> i32;
        }
        const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
        const STILL_ACTIVE: u32 = 259;

        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            embedded_state.active_pid.store(0, Ordering::SeqCst);
            return false;
        }
        let mut exit_code: u32 = 0;
        let res = GetExitCodeProcess(handle, &mut exit_code);
        CloseHandle(handle);
        if res != 0 && exit_code == STILL_ACTIVE {
            return true;
        }
        embedded_state.active_pid.store(0, Ordering::SeqCst);
        false
    }

    #[cfg(not(target_os = "windows"))]
    {
        true
    }
}

#[derive(Clone)]
pub struct AutoRefreshCoordinator {
    pub app_handle: AppHandle,
    pub eval_tx: mpsc::Sender<()>,
    pub eval_lock: Arc<tokio::sync::Mutex<()>>,
    pub is_evaluating: Arc<AtomicBool>,
    pub status_cache: Arc<RwLock<HashMap<i64, SourceDeviceRefreshStatus>>>,
}

impl AutoRefreshCoordinator {
    pub fn new(app_handle: AppHandle, eval_tx: mpsc::Sender<()>) -> Self {
        Self {
            app_handle,
            eval_tx,
            eval_lock: Arc::new(tokio::sync::Mutex::new(())),
            is_evaluating: Arc::new(AtomicBool::new(false)),
            status_cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn get_status(&self, source_id: i64) -> SourceDeviceRefreshStatus {
        if let Ok(cache) = self.status_cache.read() {
            if let Some(st) = cache.get(&source_id) {
                return st.clone();
            }
        }

        // Compute fallback from DB
        let db_state = sql::get_source_refresh_state(source_id).ok().flatten();
        let last_success = db_state.as_ref().and_then(|s| s.last_successful_refresh);
        let next_eligible = last_success.map(|t| t + AUTO_REFRESH_INTERVAL_SECS);
        let last_err = db_state.as_ref().and_then(|s| s.last_error.clone());

        let current_status = if last_success.is_none() {
            "never_refreshed".to_string()
        } else if last_err.is_some() {
            "error".to_string()
        } else {
            "idle".to_string()
        };

        SourceDeviceRefreshStatus {
            source_id,
            last_successful_refresh: last_success,
            next_eligible_refresh: next_eligible,
            current_status,
            is_deferred_playback: false,
            is_deferred_metered: false,
            last_error: last_err,
        }
    }

    pub fn get_all_statuses(&self) -> Vec<SourceDeviceRefreshStatus> {
        let sources = sql::get_sources().unwrap_or_default();
        let mut list = Vec::new();
        for s in sources {
            if let Some(id) = s.id {
                list.push(self.get_status(id));
            }
        }
        list
    }

    pub fn request_evaluation(&self) {
        let _ = self.eval_tx.try_send(());
    }

    pub fn remove_source(&self, source_id: i64) {
        if let Ok(mut cache) = self.status_cache.write() {
            cache.remove(&source_id);
        }
    }

    pub fn update_cached_status(&self, status: SourceDeviceRefreshStatus) {
        if let Ok(mut cache) = self.status_cache.write() {
            cache.insert(status.source_id, status.clone());
        }
        let _ = self.app_handle.emit("source-refresh-status-changed", &status);
    }

    pub async fn evaluate_and_refresh(&self) {
        let Ok(_guard) = self.eval_lock.try_lock() else {
            return;
        };

        self.is_evaluating.store(true, Ordering::SeqCst);

        let sources = match sql::get_sources() {
            Ok(s) => s,
            Err(_) => {
                self.is_evaluating.store(false, Ordering::SeqCst);
                return;
            }
        };

        let db_states = sql::get_all_source_refresh_states().unwrap_or_default();
        let now = chrono::Utc::now().timestamp();

        let mut due_sources: Vec<Source> = Vec::new();

        for source in &sources {
            let id = match source.id {
                Some(id) => id,
                None => continue,
            };

            // Custom sources have no remote provider to auto-refresh
            if source.source_type == crate::source_type::CUSTOM {
                continue;
            }

            let last_success = db_states.get(&id).and_then(|s| s.last_successful_refresh);
            let is_due = match last_success {
                None => true, // Never refreshed on this device!
                Some(t) => (now - t) >= AUTO_REFRESH_INTERVAL_SECS,
            };

            if source.enabled && is_due {
                due_sources.push(source.clone());
            }
        }

        let playback_active = is_playback_active(&self.app_handle);
        let network_cost_status = network_cost::get_network_cost_status();
        let metered_active = network_cost_status != network_cost::NetworkCostStatus::Unmetered;

        // If no sources are due, update non-due statuses and return
        if due_sources.is_empty() {
            for source in &sources {
                let id = match source.id {
                    Some(id) => id,
                    None => continue,
                };
                let db_st = db_states.get(&id);
                let last_success = db_st.and_then(|s| s.last_successful_refresh);
                let next_eligible = last_success.map(|t| t + AUTO_REFRESH_INTERVAL_SECS);
                let last_err = db_st.and_then(|s| s.last_error.clone());

                let cur_status = if last_success.is_none() {
                    "never_refreshed".to_string()
                } else if last_err.is_some() {
                    "error".to_string()
                } else {
                    "idle".to_string()
                };

                let status = SourceDeviceRefreshStatus {
                    source_id: id,
                    last_successful_refresh: last_success,
                    next_eligible_refresh: next_eligible,
                    current_status: cur_status,
                    is_deferred_playback: false,
                    is_deferred_metered: false,
                    last_error: last_err,
                };
                self.update_cached_status(status);
            }
            self.is_evaluating.store(false, Ordering::SeqCst);
            return;
        }

        // Priority 1: Playback protection
        if playback_active {
            for source in &sources {
                let id = match source.id {
                    Some(id) => id,
                    None => continue,
                };
                let is_this_due = due_sources.iter().any(|s| s.id == Some(id));
                let db_st = db_states.get(&id);
                let last_success = db_st.and_then(|s| s.last_successful_refresh);
                let next_eligible = last_success.map(|t| t + AUTO_REFRESH_INTERVAL_SECS);
                let last_err = db_st.and_then(|s| s.last_error.clone());

                let (cur_status, deferred_pb) = if is_this_due {
                    ("deferred_playback".to_string(), true)
                } else if last_success.is_none() {
                    ("never_refreshed".to_string(), false)
                } else {
                    ("idle".to_string(), false)
                };

                let status = SourceDeviceRefreshStatus {
                    source_id: id,
                    last_successful_refresh: last_success,
                    next_eligible_refresh: next_eligible,
                    current_status: cur_status,
                    is_deferred_playback: deferred_pb,
                    is_deferred_metered: false,
                    last_error: last_err,
                };
                self.update_cached_status(status);
            }
            self.is_evaluating.store(false, Ordering::SeqCst);
            return;
        }

        // Priority 2: Metered connection protection
        if metered_active {
            for source in &sources {
                let id = match source.id {
                    Some(id) => id,
                    None => continue,
                };
                let is_this_due = due_sources.iter().any(|s| s.id == Some(id));
                let db_st = db_states.get(&id);
                let last_success = db_st.and_then(|s| s.last_successful_refresh);
                let next_eligible = last_success.map(|t| t + AUTO_REFRESH_INTERVAL_SECS);
                let last_err = db_st.and_then(|s| s.last_error.clone());

                let (cur_status, deferred_metered) = if is_this_due {
                    ("deferred_metered".to_string(), true)
                } else if last_success.is_none() {
                    ("never_refreshed".to_string(), false)
                } else {
                    ("idle".to_string(), false)
                };

                let status = SourceDeviceRefreshStatus {
                    source_id: id,
                    last_successful_refresh: last_success,
                    next_eligible_refresh: next_eligible,
                    current_status: cur_status,
                    is_deferred_playback: false,
                    is_deferred_metered: deferred_metered,
                    last_error: last_err,
                };
                self.update_cached_status(status);
            }
            self.is_evaluating.store(false, Ordering::SeqCst);
            return;
        }

        // Eligible! Process due sources sequentially
        for source in due_sources {
            let id = match source.id {
                Some(id) => id,
                None => continue,
            };

            // Check if playback became active before starting this source
            if is_playback_active(&self.app_handle) {
                let db_states_fresh = sql::get_all_source_refresh_states().unwrap_or_default();
                let db_st = db_states_fresh.get(&id);
                let last_success = db_st.and_then(|s| s.last_successful_refresh);
                let next_eligible = last_success.map(|t| t + AUTO_REFRESH_INTERVAL_SECS);
                let status = SourceDeviceRefreshStatus {
                    source_id: id,
                    last_successful_refresh: last_success,
                    next_eligible_refresh: next_eligible,
                    current_status: "deferred_playback".to_string(),
                    is_deferred_playback: true,
                    is_deferred_metered: false,
                    last_error: db_st.and_then(|s| s.last_error.clone()),
                };
                self.update_cached_status(status);
                break;
            }

            // Check if connection became metered before starting this source
            if network_cost::get_network_cost_status() != network_cost::NetworkCostStatus::Unmetered {
                let db_states_fresh = sql::get_all_source_refresh_states().unwrap_or_default();
                let db_st = db_states_fresh.get(&id);
                let last_success = db_st.and_then(|s| s.last_successful_refresh);
                let next_eligible = last_success.map(|t| t + AUTO_REFRESH_INTERVAL_SECS);
                let status = SourceDeviceRefreshStatus {
                    source_id: id,
                    last_successful_refresh: last_success,
                    next_eligible_refresh: next_eligible,
                    current_status: "deferred_metered".to_string(),
                    is_deferred_playback: false,
                    is_deferred_metered: true,
                    last_error: db_st.and_then(|s| s.last_error.clone()),
                };
                self.update_cached_status(status);
                break;
            }

            // Mark refreshing
            let db_states_fresh = sql::get_all_source_refresh_states().unwrap_or_default();
            let db_st = db_states_fresh.get(&id);
            let last_success = db_st.and_then(|s| s.last_successful_refresh);
            let next_eligible = last_success.map(|t| t + AUTO_REFRESH_INTERVAL_SECS);
            let status = SourceDeviceRefreshStatus {
                source_id: id,
                last_successful_refresh: last_success,
                next_eligible_refresh: next_eligible,
                current_status: "refreshing".to_string(),
                is_deferred_playback: false,
                is_deferred_metered: false,
                last_error: None,
            };
            self.update_cached_status(status);

            // Execute refresh using existing safe unlocked pipeline
            let res = utils::refresh_source(&self.app_handle, source.clone()).await;

            // Update status after completion
            let db_states_after = sql::get_all_source_refresh_states().unwrap_or_default();
            let db_st_after = db_states_after.get(&id);
            let last_success_after = db_st_after.and_then(|s| s.last_successful_refresh);
            let next_eligible_after = last_success_after.map(|t| t + AUTO_REFRESH_INTERVAL_SECS);
            let last_err_after = db_st_after.and_then(|s| s.last_error.clone());

            let cur_status_after = match res {
                Ok(_) => "idle".to_string(),
                Err(_) => "error".to_string(),
            };

            let status_after = SourceDeviceRefreshStatus {
                source_id: id,
                last_successful_refresh: last_success_after,
                next_eligible_refresh: next_eligible_after,
                current_status: cur_status_after,
                is_deferred_playback: false,
                is_deferred_metered: false,
                last_error: last_err_after,
            };
            self.update_cached_status(status_after);
        }

        self.is_evaluating.store(false, Ordering::SeqCst);
    }
}

pub fn notify_playback_ended(app: &AppHandle) {
    if let Some(coord) = app.try_state::<AutoRefreshCoordinator>() {
        let _ = coord.eval_tx.try_send(());
    }
}

pub fn notify_source_refresh_settled(app: &AppHandle, _source_id: i64) {
    if let Some(coord) = app.try_state::<AutoRefreshCoordinator>() {
        let _ = coord.eval_tx.try_send(());
    }
}

pub fn start_auto_refresh_coordinator(app_handle: AppHandle) -> AutoRefreshCoordinator {
    let (eval_tx, mut eval_rx) = mpsc::channel::<()>(16);
    let coordinator = AutoRefreshCoordinator::new(app_handle.clone(), eval_tx);
    let coord_clone = coordinator.clone();

    tauri::async_runtime::spawn(async move {
        // Initial delay on startup (3 seconds) to allow DB migrations and window init
        tokio::time::sleep(Duration::from_secs(3)).await;

        coord_clone.evaluate_and_refresh().await;

        // Periodic check interval: every 3 minutes
        let mut interval = tokio::time::interval(Duration::from_secs(180));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                _ = interval.tick() => {
                    coord_clone.evaluate_and_refresh().await;
                }
                msg = eval_rx.recv() => {
                    match msg {
                        Some(_) => {
                            coord_clone.evaluate_and_refresh().await;
                        }
                        None => {
                            // Receiver closed (app exit)
                            break;
                        }
                    }
                }
            }
        }
    });

    coordinator
}
