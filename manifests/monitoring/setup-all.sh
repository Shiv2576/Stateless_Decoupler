#!/bin/bash

set -e

echo "Setting up complete monitoring stack"
echo "======================================="

# Create namespace
echo ""
echo "Creating monitoring namespace..."
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -

# Install Prometheus + Grafana
echo ""
echo "Deploying Prometheus + Grafana..."
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  -n monitoring \
  -f configs/grafana/prometheus-values.yaml \
  --wait \
  --timeout 10m

# Wait for pods
echo "⏳ Waiting for monitoring pods..."
kubectl wait --for=condition=ready pod -l app.kubernetes.io/instance=monitoring -n monitoring --timeout=300s

# Get Grafana password
GRAFANA_PASS=$(kubectl get secret monitoring-grafana -n monitoring -o jsonpath="{.data.admin-password}" | base64 -d)

echo ""
echo "Monitoring stack deployed successfully!"
echo ""
echo "Access Grafana:"
echo "   kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80"
echo "   Username: admin"
echo "   Password: $GRAFANA_PASS"
echo ""
echo "Access Prometheus:"
echo "   kubectl port-forward -n monitoring svc/monitoring-kube-prometheus-prometheus 9090:9090"
