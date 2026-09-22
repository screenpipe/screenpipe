// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use screenpipe_db::DatabaseManager;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let root = std::path::PathBuf::from(std::env::args().nth(1).expect("fixture path"));
    anyhow::ensure!(
        root.parent()
            .unwrap()
            .join(".screenpipe-disposable-volume")
            .is_file(),
        "owned test share required"
    );
    std::fs::create_dir_all(&root)?;
    anyhow::ensure!(!root.join("db.sqlite").exists(), "must be fresh fixture");
    let image_path = root.join("historical-marker.jpg");
    image::DynamicImage::new_rgb8(640, 480).save(&image_path)?;
    screenpipe_fs::sync_all(&std::fs::File::open(&image_path)?)?;
    let db =
        DatabaseManager::new(root.join("db.sqlite").to_str().unwrap(), Default::default()).await?;
    db.insert_video_chunk(image_path.to_str().unwrap(), "Display 1")
        .await?;
    for n in 0..8 {
        let frame = db
            .insert_frame(
                "Display 1",
                Some(chrono::Utc::now() - chrono::Duration::minutes(20 - n)),
                None,
                Some("NAS History"),
                Some("NAS retained historical marker"),
                true,
                Some(0),
            )
            .await?;
        let mut tx = db.begin_immediate_with_retry().await?;
        sqlx::query("UPDATE frames SET full_text=?,accessibility_text=?,accessibility_tree_json=? WHERE id=?")
          .bind(format!("NAS retained historical marker {n}"))
          .bind(format!("NAS retained historical marker {n}"))
          .bind("historical payload ".repeat(32768)).bind(frame).execute(&mut **tx.conn()).await?;
        tx.commit().await?;
    }
    db.close().await;
    println!(
        "Created 8 legacy history frames through the production writer in {}",
        root.display()
    );
    Ok(())
}
