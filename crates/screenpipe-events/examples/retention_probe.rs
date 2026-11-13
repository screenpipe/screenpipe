// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
//! macOS physical-footprint probe for consumed event retention.
//!
//! Run `cargo run --locked -p screenpipe-events --example retention_probe`.
//! Sends and consumes 256 MiB of synthetic payloads, then samples physical
//! footprint after allocator relief. Compare fresh processes with identical
//! payloads; this measures the event crate, not the full desktop application.

#[cfg(target_os = "macos")]
use futures::StreamExt;
#[cfg(target_os = "macos")]
use screenpipe_events::{send_event, subscribe_to_event};

#[cfg(target_os = "macos")]
fn footprint() -> u64 {
    unsafe extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut std::ffi::c_void) -> i32;
        fn getpid() -> i32;
        fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
    }
    // RUSAGE_INFO_V2 starts with a 16-byte UUID; ri_phys_footprint is
    // the eighth u64 after it (byte offset 72). Leave ample buffer space
    // for the remaining fields that proc_pid_rusage writes.
    let mut info = [0u64; 512];
    unsafe {
        malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        assert_eq!(proc_pid_rusage(getpid(), 2, info.as_mut_ptr().cast()), 0);
    }
    info[9]
}

#[cfg(target_os = "macos")]
#[tokio::main(flavor = "current_thread")]
async fn main() {
    let mut sub = subscribe_to_event::<serde_json::Value>("memory_retention_eval");
    let before = footprint();
    for i in 0..4096 {
        send_event(
            "memory_retention_eval",
            serde_json::json!({"id":i,"payload":"x".repeat(65536)}),
        )
        .unwrap();
        let event = sub.next().await.unwrap();
        assert_eq!(event.data["id"], i);
        drop(event);
    }
    let consumed = footprint();
    drop(sub);
    let dropped = footprint();
    println!("{{\"messages\":4096,\"payload_bytes\":65536,\"before_bytes\":{before},\"after_consumed_bytes\":{consumed},\"after_drop_bytes\":{dropped},\"retained_delta_bytes\":{}}}", consumed.saturating_sub(before));
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This probe requires macOS physical-footprint accounting.");
    std::process::exit(2);
}
