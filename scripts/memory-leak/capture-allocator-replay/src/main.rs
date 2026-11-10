// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! macOS-only replay of large allocation sizes/lifetimes from a capture trace.
//! IDs are anonymous; the fixture contains no pixels, text, addresses or timestamps.
//! Both arms use System; set MallocLargeCache=1 (control) or 0 (fixed) at launch.
use std::{
    alloc::{GlobalAlloc, Layout, System},
    collections::HashMap,
    time::Duration,
};
#[derive(Clone, Copy)]
enum Event {
    Alloc(u64, usize),
    Free(u64),
}
struct Block {
    pointer: *mut u8,
    layout: Layout,
}
unsafe fn allocate(layout: Layout) -> *mut u8 {
    System.alloc(layout)
}
unsafe fn release(block: Block) {
    System.dealloc(block.pointer, block.layout)
}
fn footprint() -> u64 {
    extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, data: *mut u8) -> i32;
    }
    let mut data = [0u64; 512];
    assert_eq!(
        unsafe { proc_pid_rusage(std::process::id() as i32, 2, data.as_mut_ptr().cast()) },
        0
    );
    data[9]
}
fn main() {
    let text = include_str!("../capture-profile.tsv");
    let events: Vec<_> = text
        .lines()
        .map(|line| {
            let mut parts = line.split('\t');
            let kind = parts.next().unwrap();
            let address = parts.next().unwrap().parse::<u64>().unwrap();
            if kind == "f" {
                Event::Free(address)
            } else {
                Event::Alloc(
                    address,
                    parts.next().unwrap().parse::<usize>().unwrap().max(1),
                )
            }
        })
        .collect();
    let before = footprint();
    println!(
        "{{\"phase\":\"baseline\",\"footprint\":{before},\"events\":{}}}",
        events.len()
    );
    let mut blocks = HashMap::<u64, Block>::new();
    for round in 0..4 {
        for event in &events {
            match *event {
                Event::Alloc(address, size) => {
                    let layout = Layout::from_size_align(size, 16).unwrap();
                    let pointer = unsafe { allocate(layout) };
                    assert!(!pointer.is_null());
                    unsafe {
                        std::ptr::write_bytes(pointer, 0xa5, size);
                    }
                    if let Some(old) = blocks.insert(address, Block { pointer, layout }) {
                        unsafe {
                            release(old);
                        }
                    }
                }
                Event::Free(address) => {
                    if let Some(block) = blocks.remove(&address) {
                        unsafe {
                            release(block);
                        }
                    }
                }
            }
        }
        let live = blocks
            .values()
            .map(|block| block.layout.size())
            .sum::<usize>();
        println!(
            "{{\"phase\":\"replay\",\"round\":{round},\"footprint\":{},\"live_bytes\":{live}}}",
            footprint()
        );
        for (_, block) in blocks.drain() {
            unsafe {
                release(block);
            }
        }
        extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        unsafe {
            malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        }
        std::thread::sleep(Duration::from_millis(250));
        println!(
            "{{\"phase\":\"freed\",\"round\":{round},\"footprint\":{}}}",
            footprint()
        );
    }
    let retained = footprint().saturating_sub(before);
    println!("retained_after_cleanup_bytes={retained}");
    // This threshold fails on the original XZM trace replay, after all owned
    // buffers have been freed, and passes with the native cache disabled.
    assert!(
        retained < 150 * 1024 * 1024,
        "retained capture heap exceeded 150 MiB"
    );
}
