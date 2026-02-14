#!/bin/bash

echo "🚀 Starting Import Opportunity Finder..."
echo ""
echo "📡 Starting API server on port 3000..."
node api-server.js &
SERVER_PID=$!

sleep 2

echo ""
echo "✅ Server running at http://localhost:3000"
echo ""
echo "Available endpoints:"
echo "  POST /api/scan-opportunity"
echo "  POST /api/scan-multiple"
echo "  GET  /api/trending"
echo ""
echo "🌐 Opening frontend in browser..."
sleep 1

# Open the HTML file
open import-finder-live.html

echo ""
echo "✨ System ready! The scanner is now operational."
echo ""
echo "To stop the server, press Ctrl+C"
echo ""

# Wait for Ctrl+C
trap "kill $SERVER_PID; echo 'Server stopped.'; exit" INT
wait $SERVER_PID
