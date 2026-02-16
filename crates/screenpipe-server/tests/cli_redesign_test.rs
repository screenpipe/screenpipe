use clap::Parser;
use screenpipe_server::cli::{Cli, Command, CliContentType};

#[test]
fn parse_search_command() {
    let cli = Cli::try_parse_from([
        "screenpipe",
        "search",
        "meeting notes",
        "--json",
        "--type",
        "vision",
        "--from",
        "2h",
        "--limit",
        "5",
    ])
    .unwrap();

    let Some(Command::Search(args)) = cli.command else {
        panic!("expected search command");
    };
    assert!(args.json);
    assert_eq!(args.r#type, CliContentType::Vision);
    assert_eq!(args.query, "meeting notes");
    assert_eq!(args.limit, 5);
    assert_eq!(args.from.as_deref(), Some("2h"));
}

#[test]
fn parse_server_command() {
    let cli = Cli::try_parse_from(["screenpipe", "server", "--port", "4040"]).unwrap();
    let Some(Command::Server(args)) = cli.command else {
        panic!("expected server command");
    };
    assert_eq!(args.port, 4040);
}
