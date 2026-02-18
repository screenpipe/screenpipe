import { ScreenpipeClient } from "@screenpipe/js";

async function queryScreenpipe() {
  const client = new ScreenpipeClient();

  console.log("starting query screenpipe...");
  console.log("------------------------------");
  console.log("querying last 5 minutes of activity...");
  console.log("------------------------------");

  // get content from last 5 minutes
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  const results = await client.search({
    startTime: fiveMinutesAgo,
    limit: 10,
    contentType: "all", // can be "ocr", "audio", "input", "accessibility", or "all"
  });

  console.log(`found ${results.pagination.total} items`);

  // process each result
  for (const item of results.data) {
    console.log("\n--- new item ---");
    console.log(`type: ${item.type}`);
    console.log(`timestamp: ${item.content.timestamp}`);

    if (item.type === "OCR") {
      console.log(`vision: ${JSON.stringify(item.content)}`);
    } else if (item.type === "Audio") {
      console.log(`transcript: ${JSON.stringify(item.content)}`);
    } else if (item.type === "Input") {
      console.log(`input: ${JSON.stringify(item.content)}`);
    }

    // here you could send to openai or other ai service
    // example pseudo-code:
    // const aiResponse = await openai.chat.completions.create({
    //   messages: [{ role: "user", content: JSON.stringify(item.content) }],
    //   model: "gpt-4"
    // });
  }
}

queryScreenpipe().catch(console.error);
