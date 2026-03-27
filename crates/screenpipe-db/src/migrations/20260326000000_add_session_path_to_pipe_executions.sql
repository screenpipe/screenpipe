-- Add session_path column to link pipe executions to Pi agent session files
ALTER TABLE pipe_executions ADD COLUMN session_path TEXT;
