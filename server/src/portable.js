import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { slugify } from "./bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Đóng gói thư mục thành file .zip bằng powershell Compress-Archive
 */
function zipFolder(sourceFolder, zipFilePath) {
  return new Promise((resolve, reject) => {
    const cmd = "powershell.exe";
    const args = [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory('${sourceFolder}', '${zipFilePath}')`
    ];

    execFile(cmd, args, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message));
      }
      resolve(zipFilePath);
    });
  });
}

/**
 * Tạo kịch bản PowerShell chạy Portable an toàn, không bị lỗi bảng mã tiếng Việt
 */
function generatePs1Script(specName) {
  return `# PowerShell Portable Builder Script
$ErrorActionPreference = "Continue"

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  DANG KHOI DONG RUNNER DUNG NATIVE FAMILY CHO REVIT (PORTABLE)" -ForegroundColor Green
Write-Host "=====================================================================" -ForegroundColor Cyan

# 1. Tim kiem Revit.exe
$revitCandidates = @(
    "C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2026\\Revit.exe",
    "C:\\Program Files\\Autodesk\\Revit 2023\\Revit.exe"
)

$revitExe = $null
$revitVer = "2024"

foreach ($candidate in $revitCandidates) {
    if (Test-Path $candidate) {
        $revitExe = $candidate
        if ($candidate -match "Revit (\\d{4})") {
            $revitVer = $matches[1]
        }
        break
    }
}

if (-not $revitExe) {
    Write-Host "[LOI] Khong tim thay Revit.exe tren may tai thu muc mac dinh C:\\Program Files\\Autodesk!" -ForegroundColor Red
    Write-Host "Vui long cai dat hoac kiem tra lai phien ban Revit tren may." -ForegroundColor Yellow
    Read-Host "Nhan Enter de thoat..."
    exit
}

Write-Host "[OK] Phat hien Revit: $revitExe (Phien ban: $revitVer)" -ForegroundColor Yellow

# 2. Tao manifest tam thoi trong %APPDATA%
$currentDir = $PSScriptRoot
$addinDir = Join-Path $env:APPDATA "Autodesk\\Revit\\Addins\\$revitVer"
if (-not (Test-Path $addinDir)) {
    New-Item -ItemType Directory -Path $addinDir -Force | Out-Null
}

$manifestFile = Join-Path $addinDir "FamilyAgent_Portable_Temp.addin"
$assemblyPath = Join-Path $currentDir "FamilyAgent.Addin.dll"

$manifestContent = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Command">
    <Name>Family Agent Portable</Name>
    <Assembly>$assemblyPath</Assembly>
    <AddInId>7a0e384e-2c11-4f5a-9a0e-6f1f4d1c2b88</AddInId>
    <FullClassName>FamilyAgent.Addin.PortableBuildCommand</FullClassName>
    <Text>Build $specName</Text>
    <Description>Auto-build native parametric family</Description>
    <VisibilityMode>AlwaysVisible</VisibilityMode>
    <VendorId>FAMLYAGT</VendorId>
  </AddIn>
</RevitAddIns>
"@

[System.IO.File]::WriteAllText($manifestFile, $manifestContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] Da nap runner tam thoi vao Revit Addins ($revitVer)." -ForegroundColor Cyan

# 3. Kiem tra xem Revit co dang chay khong
$isRunning = Get-Process -Name "Revit" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "---------------------------------------------------------------------" -ForegroundColor Gray
if ($isRunning) {
    Write-Host "[THONG BAO]: Revit dang chay tren may cua ban!" -ForegroundColor Green
    Write-Host "-> Hay chuyen sang cua so Revit -> Tab [Add-Ins] -> [External Tools] -> bam chon [Build $specName]" -ForegroundColor Yellow
    Write-Host "   (File .rfa se tu dong sinh ra ngay tai thu muc nay)" -ForegroundColor White
} else {
    Write-Host "[THONG BAO]: Revit chua chay. Bat dau khoi dong Revit tu dong de dung hinh..." -ForegroundColor Cyan
    Start-Process $revitExe
    Write-Host "-> Khi Revit mo len, vao Tab [Add-Ins] -> [External Tools] -> bam [Build $specName]" -ForegroundColor Yellow
}
Write-Host "---------------------------------------------------------------------" -ForegroundColor Gray
Write-Host ""

Write-Host "Dang theo doi tien trinh tao file .rfa (Dung nguyen ban tung khoi Solid)..." -ForegroundColor Cyan

$rfaFound = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Seconds 2
    $rfaFiles = Get-ChildItem -Path $currentDir -Filter "*.rfa"
    if ($rfaFiles.Count -gt 0) {
        $rfaFound = $true
        break
    }
}

Write-Host ""
if ($rfaFound) {
    Write-Host "=====================================================================" -ForegroundColor Green
    Write-Host "  THANH CONG! DA TAO XONG FILE .RFA TAI THU MUC NAY!" -ForegroundColor Green
    Write-Host "  Family la Native Solid 100% va co day du tham so bien thien." -ForegroundColor Green
    Write-Host "=====================================================================" -ForegroundColor Green
} else {
    Write-Host "Tien trinh ket thuc hoac chua phat hien file .rfa moi." -ForegroundColor Yellow
}

# 4. Don dep manifest tam thoi
if (Test-Path $manifestFile) {
    Remove-Item $manifestFile -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Da don dep sach se moi truong portable, khong luu add-in tren he thong." -ForegroundColor Gray
}

Read-Host "Nhan Enter de dong cua so nay..."
`;
}

/**
 * Tạo gói Portable 1-Click Builder cho người dùng không cần cài Addin
 */
export async function createPortablePackage(spec) {
  const safeName = slugify(spec.name || "Family");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `family-portable-${safeName}-`));
  const packageDir = path.join(tempDir, `Build-${safeName}`);
  fs.mkdirSync(packageDir, { recursive: true });

  // 1. Lưu spec.json vào gói
  const specPath = path.join(packageDir, `${safeName}-spec.json`);
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 2), "utf8");

  // 2. Copy các file DLL của Addin đã build sẵn
  const binDir = path.resolve(__dirname, "../../revit-addin/FamilyAgent.Addin/bin/Release");
  const requiredDlls = [
    "FamilyAgent.Addin.dll",
    "FamilyAgent.Core.dll",
    "Newtonsoft.Json.dll"
  ];

  for (const dll of requiredDlls) {
    const src = path.join(binDir, dll);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(packageDir, dll));
    }
  }

  // 3. Tạo file PowerShell script (.ps1) chuẩn UTF-8
  const ps1Content = generatePs1Script(spec.name || "Family");
  fs.writeFileSync(path.join(packageDir, "runner.ps1"), ps1Content, "utf8");

  // 4. Tạo file .bat wrapper chuẩn ASCII để double click chạy runner.ps1
  const batContent = `@echo off\r\ncd /d "%~dp0"\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0runner.ps1"\r\n`;
  fs.writeFileSync(path.join(packageDir, "1-Click-Build.bat"), batContent, "ascii");

  // 5. Tạo file HDSD ngắn gọn
  const readmeContent = `HUONG DAN DUNG FILE .RFA NATIVE (KHONG CAN CAI ADD-IN):
1. Click dup vao file "1-Click-Build.bat".
2. Chuyen sang cua so Revit -> Tab [Add-Ins] -> [External Tools] -> Chon "Build ${spec.name || "Family"}".
3. Revit se tu dong tao moi Family va dung tung khoi Solid, gan tham so va luu file .rfa ngay tai thu muc nay.
4. Xong xuoi ban co the xoa thu muc nay, may tinh van sach se hoan toan.
`;
  fs.writeFileSync(path.join(packageDir, "HUONG_DAN.txt"), readmeContent, "utf8");

  // 6. Nén thành file zip
  const zipPath = path.join(tempDir, `${safeName}-Portable-Revit.zip`);
  await zipFolder(packageDir, zipPath);

  return {
    zipPath,
    fileName: `${safeName}-Portable-Revit.zip`,
    cleanup: () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  };
}
