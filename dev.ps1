#!/usr/bin/env pwsh
<#
.SYNOPSIS
    PhishGuard Voice — Local Development Helper
.DESCRIPTION
    Starts the backend FastAPI server and a frontend static server simultaneously.
    Requires Python 3.12+ and the packages from requirements.txt to be installed.
#>

param(
    [int]$BackendPort  = 8080,
    [int]$FrontendPort = 5000
)

$Root    = $PSScriptRoot
$Backend = Join-Path $Root "backend"
$Frontend= Join-Path $Root "frontend"

Write-Host ""
Write-Host "╔══════════════════════════════════════════════╗" -ForegroundColor Cyan
Write-Host "║    PhishGuard Voice — Local Dev Server       ║" -ForegroundColor Cyan
Write-Host "╚══════════════════════════════════════════════╝" -ForegroundColor Cyan
Write-Host ""

# ── Check .env exists ─────────────────────────────────────────────────────────
$EnvFile = Join-Path $Backend ".env"
if (-not (Test-Path $EnvFile)) {
    Write-Host "⚠️  No .env found in backend/. Copying from .env.example..." -ForegroundColor Yellow
    Copy-Item (Join-Path $Backend ".env.example") $EnvFile
    Write-Host "   → Edit backend\.env with your GCP project ID before proceeding." -ForegroundColor Yellow
    Write-Host ""
}

# ── Start backend ─────────────────────────────────────────────────────────────
Write-Host "🚀 Starting FastAPI backend on http://localhost:$BackendPort ..." -ForegroundColor Green
$BackendJob = Start-Job -ScriptBlock {
    param($dir, $port)
    Set-Location $dir
    python -m uvicorn main:app --host 0.0.0.0 --port $port --reload
} -ArgumentList $Backend, $BackendPort

# ── Start frontend ────────────────────────────────────────────────────────────
Write-Host "🌐 Starting frontend on http://localhost:$FrontendPort ..." -ForegroundColor Green
$FrontendJob = Start-Job -ScriptBlock {
    param($dir, $port)
    python -m http.server $port --directory $dir
} -ArgumentList $Frontend, $FrontendPort

Write-Host ""
Write-Host "┌─────────────────────────────────────────────┐" -ForegroundColor DarkCyan
Write-Host "│  Frontend  →  http://localhost:$FrontendPort         │" -ForegroundColor DarkCyan
Write-Host "│  Backend   →  http://localhost:$BackendPort         │" -ForegroundColor DarkCyan
Write-Host "│  API docs  →  http://localhost:$BackendPort/docs     │" -ForegroundColor DarkCyan
Write-Host "└─────────────────────────────────────────────┘" -ForegroundColor DarkCyan
Write-Host ""
Write-Host "Press Ctrl+C to stop both servers." -ForegroundColor Gray
Write-Host ""

# ── Stream logs from both jobs ────────────────────────────────────────────────
try {
    while ($true) {
        Receive-Job -Job $BackendJob  | ForEach-Object { Write-Host "[BACKEND]  $_" -ForegroundColor Blue }
        Receive-Job -Job $FrontendJob | ForEach-Object { Write-Host "[FRONTEND] $_" -ForegroundColor Magenta }
        Start-Sleep -Milliseconds 500
    }
}
finally {
    Write-Host ""
    Write-Host "Shutting down..." -ForegroundColor Red
    Stop-Job  -Job $BackendJob,  $FrontendJob
    Remove-Job -Job $BackendJob, $FrontendJob -Force
    Write-Host "Done." -ForegroundColor Green
}
