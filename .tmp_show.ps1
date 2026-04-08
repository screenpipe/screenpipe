cd C:\Users\louis030195\screenpipe
git --no-pager show --stat 4416d8ffa | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_4416d8ffa.txt
git --no-pager show --stat b368bbc59 | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_b368bbc59.txt
git --no-pager show --stat 458496dc2 | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_458496dc2.txt
git --no-pager show --stat e7bde644e | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_e7bde644e.txt
git --no-pager show --stat 4fc95a611 | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_4fc95a611.txt
git --no-pager log --oneline -n 30 -- crates/screenpipe-engine/src/meeting_detector.rs | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_log_md.txt
git --no-pager log --oneline -n 30 -- crates/screenpipe-engine/src/paired_capture.rs | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_log_pc.txt
git --no-pager log --oneline -n 30 -- crates/screenpipe-audio/src/meeting_detector.rs | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_log_amd.txt
git --no-pager log --oneline -n 30 -- apps/screenpipe-app-tauri/app/home/page.tsx | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_log_hp.txt
git --no-pager log --oneline -n 30 -- crates/screenpipe-engine/src/meeting_watcher.rs | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_log_mw.txt
git --no-pager log --oneline -n 30 -- crates/screenpipe-engine/src/meeting_persister.rs | Out-File -Encoding utf8 C:\Users\louis030195\screenpipe\.tmp_log_mp.txt
