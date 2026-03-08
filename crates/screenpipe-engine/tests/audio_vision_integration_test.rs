use serde_json::Value;
use std::time::{Duration, Instant};

#[tokio::test]
#[ignore] // only run locally atm
async fn test_screen_capture_to_api_delay() {
    // rm the data directory
    std::fs::remove_dir_all("../data-test").unwrap_or_default();

    println!("Run: ./target/release/screenpipe --data-dir ./data-test");

    let wikipedia_url = "https://en.wikipedia.org/wiki/Rust_(programming_language)";
    println!("Go to this Wikipedia page: {}", wikipedia_url);

    // wait 2 seconds
    tokio::time::sleep(Duration::from_secs(5)).await;

    // Record start time
    let start_time = Instant::now();

    // Initialize client
    let client = reqwest::Client::new();

    // Poll the API until the desired phrase is found
    let mut found = false;
    while !found {
        let response: Value = client
            .get("http://localhost:3030/search?q=Graydon&limit=5&offset=0")
            .send()
            .await
            .expect("Failed to send request")
            .json()
            .await
            .expect("Failed to parse JSON");

        let data: Vec<Value> = response["data"].as_array().unwrap().to_vec();

        found = data
            .iter()
            .filter(|item| item["type"] == "OCR")
            .any(|item| {
                item["content"]["text"]
                    .as_str()
                    .unwrap()
                    .contains("without a garbage collector")
            });

        if !found {
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    println!("Found the phrase!");
    println!("Time elapsed: {:?}", start_time.elapsed());

    // Mac M3 max: Time elapsed: 33.516971916s
    // Mac M3 max: Time elapsed: 153.62804525s

    // You can add assertions here if needed
    // assert!(elapsed_time < Duration::from_secs(30), "Test took too long");
}
