#!/bin/bash
cd "/Users/adamsussman/CLAWDBOT EDU"

echo "🚀 Starting Import Opportunity Scanner..."
echo ""

# Start API server in background
node api-server.js > /dev/null 2>&1 &
SERVER_PID=$!
echo "✅ API Server started (PID: $SERVER_PID)"

sleep 2

# Run the scanner
echo ""
echo "🔍 Scanning for opportunities..."
echo ""
node find-best-opportunities.js

# Stop server
kill $SERVER_PID 2>/dev/null
echo ""
echo "✅ Scan complete!"
