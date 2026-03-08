#!/bin/bash

# Create screenshots directory if it doesn't exist
mkdir -p ~/screenshots
cd ~/screenshots

# List all available devices first
echo "Available devices:"
ffmpeg -f avfoundation -list_devices true -i ""

echo "Attempting capture..."
while true; do
    filename="screenshot_$(date +%Y%m%d_%H%M%S).jpg"
    ffmpeg -f avfoundation -framerate 30  -i "4:" \
        -frames:v 1 \
        -q:v 1 \
        "$filename" 2>&1
    
    if [ $? -eq 0 ]; then
        echo "Successfully captured: $filename"
    else
        echo "Failed to capture. Error code: $?"
    fi
    sleep 1
done
