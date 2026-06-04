#!/usr/bin/env pwsh
<#
.SYNOPSIS
    PhishGuard Voice — Cloud Run Deploy Script
.DESCRIPTION
    Builds the backend container and deploys it to Cloud Run, then deploys
    Firebase Hosting and Firestore rules.

.PARAMETER ProjectId
    Your GCP project ID (required)

.PARAMETER Region
    Cloud Run region (default: us-central1)

.PARAMETER ServiceName
    Cloud Run service name (default: phishguard-backend)

.EXAMPLE
    .\deploy.ps1 -ProjectId my-gcp-project
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$ProjectId,

    [string]$Region      = "us-central1",
    [string]$ServiceName = "phishguard-backend"
)

$Root      = $PSScriptRoot
$Backend   = Join-Path $Root "backend"
$ImageTag  = "gcr.io/$ProjectId/$ServiceName"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║    PhishGuard Voice — Cloud Run + Firebase Deploy        ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Project   : $ProjectId"  -ForegroundColor Gray
Write-Host "  Region    : $Region"     -ForegroundColor Gray
Write-Host "  Service   : $ServiceName"-ForegroundColor Gray
Write-Host "  Image     : $ImageTag"   -ForegroundColor Gray
Write-Host ""

# ── 1. Set active GCP project ─────────────────────────────────────────────────
Write-Host "[ 1/5 ] Setting GCP project..." -ForegroundColor Yellow
gcloud config set project $ProjectId
if ($LASTEXITCODE -ne 0) { Write-Error "gcloud config set failed"; exit 1 }

# ── 2. Enable required APIs ───────────────────────────────────────────────────
Write-Host "[ 2/5 ] Enabling required APIs..." -ForegroundColor Yellow
gcloud services enable `
    run.googleapis.com `
    aiplatform.googleapis.com `
    firestore.googleapis.com `
    cloudbuild.googleapis.com `
    containerregistry.googleapis.com `
    --project $ProjectId

# ── 3. Build & push container ─────────────────────────────────────────────────
Write-Host "[ 3/5 ] Building container image via Cloud Build..." -ForegroundColor Yellow
gcloud builds submit $Backend --tag $ImageTag --project $ProjectId
if ($LASTEXITCODE -ne 0) { Write-Error "Cloud Build failed"; exit 1 }

# ── 4. Deploy to Cloud Run ────────────────────────────────────────────────────
Write-Host "[ 4/5 ] Deploying to Cloud Run..." -ForegroundColor Yellow
gcloud run deploy $ServiceName `
    --image        $ImageTag `
    --region       $Region `
    --platform     managed `
    --allow-unauthenticated `
    --memory       512Mi `
    --timeout      3600 `
    --set-env-vars "GOOGLE_CLOUD_PROJECT=$ProjectId,GOOGLE_CLOUD_LOCATION=$Region" `
    --project      $ProjectId

if ($LASTEXITCODE -ne 0) { Write-Error "Cloud Run deploy failed"; exit 1 }

# ── Capture the Cloud Run URL ─────────────────────────────────────────────────
$ServiceUrl = gcloud run services describe $ServiceName `
    --region $Region --format "value(status.url)" --project $ProjectId
Write-Host ""
Write-Host "  ✅ Backend deployed: $ServiceUrl" -ForegroundColor Green

# ── 5. Deploy Firebase ────────────────────────────────────────────────────────
Write-Host "[ 5/5 ] Deploying Firebase Hosting + Firestore rules..." -ForegroundColor Yellow
Set-Location $Root
firebase deploy --only hosting,firestore --project $ProjectId
if ($LASTEXITCODE -ne 0) { Write-Error "Firebase deploy failed"; exit 1 }

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔══════════════════════════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║                  ✅  Deploy Complete!                    ║" -ForegroundColor Green
Write-Host "╚══════════════════════════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Backend URL  : $ServiceUrl" -ForegroundColor Cyan
Write-Host "  Dashboard    : https://$ProjectId.web.app" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Gray
Write-Host "    1. Open the dashboard URL above" -ForegroundColor Gray
Write-Host "    2. Click ⚙️ and paste the Backend URL into the config modal" -ForegroundColor Gray
Write-Host "    3. Add your Firebase API Key and App ID" -ForegroundColor Gray
Write-Host "    4. Click 'Save & Connect', then '🎙️ Intercept Call'" -ForegroundColor Gray
Write-Host ""
