#!/bin/bash

echo " Running k6 load test against WordPress..."
echo ""

# Check if k6 is installed
if ! command -v k6 &> /dev/null; then
    echo "❌ k6 not found. Install with: brew install k6"
    exit 1
fi

# Run the test
k6 run configs/k6/tests/wordpress-load.js

echo ""
echo " Load test complete!"
echo ""
echo " View results in Grafana:"
echo "   kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80"
echo "   Import dashboard ID: 19665"
