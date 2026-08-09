#!/bin/bash

echo "🚀 Stateless Decoupler - Complete Setup"
echo "======================================="

# Step 1: Deploy monitoring
echo ""
echo "📊 Deploying monitoring stack..."
./manifests/monitoring/setup-all.sh

# Step 2: Wait for monitoring to be ready
echo ""
echo "⏳ Waiting for monitoring stack..."
sleep 10

# Step 3: Port forward Grafana
echo ""
echo "🔗 Port forwarding Grafana..."
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80 &

# Step 4: Run load test
echo ""
echo "🧪 Running k6 load test..."
./scripts/run-k6-test.sh

echo ""
echo "✅ All done!"
echo ""
echo "📊 Access Grafana: http://localhost:3000"
echo "   Username: admin"
echo "   Password: $(kubectl get secret monitoring-grafana -n monitoring -o jsonpath='{.data.admin-password}' | base64 -d)"
