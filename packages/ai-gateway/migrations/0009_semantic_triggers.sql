-- screenpipe — AI that knows everything you've seen, said, or heard
-- https://screenpipe.com
-- No captured content or trigger conditions are stored in this quota registry.
CREATE TABLE IF NOT EXISTS semantic_triggers (
    user_id TEXT NOT NULL,
    trigger_id TEXT NOT NULL,
    PRIMARY KEY (user_id, trigger_id)
);
