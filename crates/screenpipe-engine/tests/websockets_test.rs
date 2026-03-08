use futures::{SinkExt, StreamExt};

#[tokio::test]
#[ignore] // only run locally atm
async fn send_test_event() {
    let url = "ws://127.0.0.1:3030/ws/events";
    let (ws_stream, _) = tokio_tungstenite::connect_async(url)
        .await
        .expect("Failed to connect to websocket");

    let (mut write, mut read) = ws_stream.split();
    let test_event = serde_json::json!({
        "name": "test_event",
        "data": 123
    });

    write
        .send(tokio_tungstenite::tungstenite::Message::Text(
            test_event.to_string(),
        ))
        .await
        .expect("Failed to send message");

    println!("waiting for event");

    // Keep the connection alive while waiting for the event
    tokio::select! {
        ws_msg = read.next() => {
            println!("Received websocket message: {:?}", ws_msg);
        }
    }
}
