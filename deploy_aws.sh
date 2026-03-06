#!/bin/bash
# AWS Deployment Script for Auto-Login Service

set -e

echo "🚀 Deploying Auto-Login Service to AWS..."

# Check if config.json exists (optional if using env vars)
if [ ! -f "config.json" ] && [ -z "$LOGIN_EMAIL" ]; then
    echo "⚠️  Warning: config.json not found and no environment variables set!"
    echo "Please either:"
    echo "  1. Copy config.json.example to config.json and configure it, OR"
    echo "  2. Set LOGIN_EMAIL, LOGIN_PIN, and LOGIN_URL environment variables"
    exit 1
fi

# Build Docker image
echo "📦 Building Docker image..."
docker build -t auto-login:latest .

echo "✅ Docker image built successfully!"
echo ""
echo "Next steps:"
echo "1. For EC2 (with config.json):"
echo "   docker run -d --restart=always -v \$(pwd)/config.json:/app/config.json auto-login:latest"
echo ""
echo "2. For EC2 (with environment variables):"
echo "   docker run -d --restart=always -e LOGIN_EMAIL -e LOGIN_PIN -e LOGIN_URL auto-login:latest"
echo ""
echo "3. For ECS:"
echo "   - Push to ECR:"
echo "     aws ecr create-repository --repository-name auto-login"
echo "     docker tag auto-login:latest <account-id>.dkr.ecr.<region>.amazonaws.com/auto-login:latest"
echo "     docker push <account-id>.dkr.ecr.<region>.amazonaws.com/auto-login:latest"
echo ""
echo "4. For Lambda:"
echo "   - Use the ECR image in Lambda container image configuration"
