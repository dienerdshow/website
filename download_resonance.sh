#!/bin/bash
set -e

ROLES=(
  "product" "architect" "qa" "researcher" "frontend" "security"
  "conversion_engineer" "seo" "devops" "database" "backend" "growth"
  "debugger" "venture_validator" "reviewer" "performance" "designer"
)

WORKFLOWS=(
  "01_project_initiation" "02_technical_architecture" "03_task_scoping"
  "04_review_and_merge" "05_quality_assurance" "06_system_health"
  "07_debugging" "99_framework_update"
)

echo "Downloading roles..."
for role in "${ROLES[@]}"; do
  curl -s -f -o ".resonance/roles/${role}.md" "https://raw.githubusercontent.com/manusco/resonance/main/.resonance/roles/${role}.md" || echo "Failed to download $role"
done

echo "Downloading workflows..."
for workflow in "${WORKFLOWS[@]}"; do
  curl -s -f -o ".resonance/workflows/${workflow}.md" "https://raw.githubusercontent.com/manusco/resonance/main/.resonance/workflows/${workflow}.md" || echo "Failed to download $workflow"
done

echo "Downloading utility scripts..."
curl -s -f -o ".resonance/scripts/safe-commit.sh" "https://raw.githubusercontent.com/manusco/resonance/main/.resonance/scripts/safe-commit.sh"
curl -s -f -o ".resonance/scripts/safe-commit.ps1" "https://raw.githubusercontent.com/manusco/resonance/main/.resonance/scripts/safe-commit.ps1"
chmod +x .resonance/scripts/safe-commit.sh

echo "Downloading resonance.sh..."
curl -s -f -o "resonance.sh" "https://raw.githubusercontent.com/manusco/resonance/main/resonance.sh"
chmod +x resonance.sh

echo "All complete!"
