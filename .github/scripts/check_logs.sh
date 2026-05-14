#!/bin/bash
tail -n 100 screenpipe_output.log
if grep -q "panic" screenpipe_output.log; then
  echo "CLI crashed"
  exit 1
fi
if ! grep -Eq "Server listening on (0\.0\.0\.0|127\.0\.0\.1):3030" screenpipe_output.log; then
  echo "Server did not start correctly"
  exit 1
fi
if grep -q "No windows found" screenpipe_output.log; then
  echo "No windows were detected"
  exit 1
fi
if grep -q "tesseract not found" screenpipe_output.log; then
  echo "Tesseract OCR not found"
  exit 1
fi
echo "CLI ran successfully without crashing"
