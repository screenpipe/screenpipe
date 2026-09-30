// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use std::{
    fs::OpenOptions,
    io::{Seek, SeekFrom, Write},
    time::Instant,
};
fn main() {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open("/tmp/screenpipe-nas-evidence/sync-bench.dat")
        .unwrap();
    let data = [17_u8; 4096];
    let mut baseline = Vec::new();
    let mut candidate = Vec::new();
    for round in 0..10 {
        for patched in [round % 2 == 0, round % 2 != 0] {
            let start = Instant::now();
            for _ in 0..100 {
                file.seek(SeekFrom::Start(0)).unwrap();
                file.write_all(&data).unwrap();
                if patched {
                    screenpipe_fs::sync_all(&file).unwrap()
                } else {
                    file.sync_all().unwrap()
                }
            }
            (if patched {
                &mut candidate
            } else {
                &mut baseline
            })
            .push(start.elapsed().as_secs_f64() * 1000.0 / 100.0);
        }
    }
    baseline.sort_by(f64::total_cmp);
    candidate.sort_by(f64::total_cmp);
    println!("APFS 4KiB overwrite+flush: 10 alternating rounds x 100 writes; baseline median_ms={:.4} candidate median_ms={:.4}; baseline_samples={baseline:?}; candidate_samples={candidate:?}",baseline[5],candidate[5]);
}
