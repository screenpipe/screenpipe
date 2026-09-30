// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#[allow(dead_code)]
#[path = "../evals/quality/mod.rs"]
mod quality;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!(
        "{}",
        serde_json::to_string_pretty(&quality::evaluate_cases(include_str!(
            "../evals/web_content/cases.json"
        ),)?)?
    );
    Ok(())
}
