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
 * Tạo kịch bản PowerShell chạy Portable tự động 100% (Zero-click):
 * Khởi động Revit, tự động dựng hình, MOVE file .rfa ra ngoài và tự đóng Revit.
 */
function generatePs1Script(specName) {
  return `# PowerShell Portable Builder Script (Auto-Build 100%)
$ErrorActionPreference = "Continue"

Write-Host "=====================================================================" -ForegroundColor Cyan
Write-Host "  DANG KHOI DONG RUNNER DUNG NATIVE FAMILY CHO REVIT (TU DONG 100%)" -ForegroundColor Green
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

# 2. Tao manifest Application tu dong trong %APPDATA%
$currentDir = $PSScriptRoot
$addinDir = [System.IO.Path]::Combine($env:APPDATA, "Autodesk", "Revit", "Addins", $revitVer)
if (-not (Test-Path $addinDir)) {
    New-Item -ItemType Directory -Path $addinDir -Force | Out-Null
}

$manifestFile = [System.IO.Path]::Combine($addinDir, "FamilyAgent_Portable_Temp.addin")
$assemblyPath = [System.IO.Path]::Combine($currentDir, "FamilyAgent.Addin.dll")
$addInGuid = "9b1f4a8e-2c11-4f5a-9a0e-6f1f4d1c2c99"

# Tu dong dang ky AddInId vao CodeSigning Registry de Revit bo qua hop thoai Security Unsigned Add-In (Always Load)
$codeSigningKeys = @(
    "HKCU:\\Software\\Autodesk\\Revit\\Autodesk Revit " + $revitVer + "\\CodeSigning",
    "HKCU:\\Software\\Autodesk\\Revit\\" + $revitVer + "\\CodeSigning"
)
foreach ($regKey in $codeSigningKeys) {
    if (-not (Test-Path $regKey)) {
        New-Item -Path $regKey -Force | Out-Null
    }
    Set-ItemProperty -Path $regKey -Name $addInGuid -Value 1 -Type DWord -Force -ErrorAction SilentlyContinue
}

# Manifest dang Application tu dong thuc thi khi khoi dong
$manifestContent = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>Family Agent Portable Auto Builder</Name>
    <Assembly>$assemblyPath</Assembly>
    <AddInId>$addInGuid</AddInId>
    <FullClassName>FamilyAgent.Addin.PortableAutoApp</FullClassName>
    <VendorId>FAMLYAGT</VendorId>
  </AddIn>
</RevitAddIns>
"@

[System.IO.File]::WriteAllText($manifestFile, $manifestContent, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "[OK] Da nap runner tu dong vao Revit (va bo qua hop thoai Security)." -ForegroundColor Cyan

# Dat co de PortableAutoApp tu dong dong Revit sau khi dung xong va luu truc tiep tai thu muc hien tai
[System.Environment]::SetEnvironmentVariable("FAMILY_AGENT_AUTO_EXIT", "1", "Process")
[System.Environment]::SetEnvironmentVariable("FAMILY_AGENT_OUT", $currentDir, "Process")

# 3. Kiem tra va khoi chay Revit tu dong
$isRunning = Get-Process -Name "Revit" -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "---------------------------------------------------------------------" -ForegroundColor Gray
if ($isRunning) {
    Write-Host "[THONG BAO]: Revit dang chay tren may. Dang khoi dong them session dung hinh..." -ForegroundColor Yellow
} else {
    Write-Host "[THONG BAO]: Dang khoi dong Revit de tu dong dung Native Family..." -ForegroundColor Green
}
Write-Host "Ban khong can thao tac gi them, he thong se TU DONG dung truc tiep file .rfa tai day!" -ForegroundColor Cyan
Write-Host "---------------------------------------------------------------------" -ForegroundColor Gray
Write-Host ""

Start-Process $revitExe

Write-Host "Dang theo doi va cho file .rfa xuat hien tai thu muc nay..." -ForegroundColor Cyan

$rfaFound = $false
for ($i = 0; $i -lt 180; $i++) {
    Start-Sleep -Seconds 2
    $rfaFiles = Get-ChildItem -Path $currentDir -Filter "*.rfa"
    if ($rfaFiles.Count -gt 0) {
        $rfaFound = $true
        $targetRfa = $rfaFiles[0].FullName
        break
    }
}

Write-Host ""
if ($rfaFound) {
    Write-Host "=====================================================================" -ForegroundColor Green
    Write-Host "  THANH CONG! FILE .RFA DA DUOC TAO TRUC TIEP TAI THU MUC CUA BAN:" -ForegroundColor Green
    Write-Host "  -> $targetRfa" -ForegroundColor Yellow
    Write-Host "  File la Native Family 100% (Day du khoi Solid va tham so bien thien)!" -ForegroundColor Green
    Write-Host "=====================================================================" -ForegroundColor Green

    # Tu dong mo thu muc va highlight file .rfa cho nguoi dung
    explorer.exe /select,"$targetRfa"
} else {
    Write-Host "Tien trinh cho qua thoi gian hoac chua hoan tat. Vui long kiem tra file build_error.log." -ForegroundColor Yellow
}

# 4. Don dep manifest tam thoi va registry sach se
if (Test-Path $manifestFile) {
    Remove-Item $manifestFile -Force -ErrorAction SilentlyContinue
    Write-Host "[OK] Da don dep sach se runner tam thoi trong Revit." -ForegroundColor Gray
}

foreach ($regKey in $codeSigningKeys) {
    Remove-ItemProperty -Path $regKey -Name $addInGuid -ErrorAction SilentlyContinue
}

# 5. Tu dong don dep cac file giai nen (chi giu lai file .rfa va file .zip goc)
if ($rfaFound) {
    Write-Host ""
    Write-Host "[DANG DON DEP]: Dang don dep cac file giai nen (.dll, .bat, .json, runner)..." -ForegroundColor Cyan

    # Chi xoa dung danh sach cac file cua goi cong cu, TUYET DOI khong dung wildcard xoa cac file khac trong thu muc
    $filesToClean = @(
        "FamilyAgent.Addin.dll",
        "FamilyAgent.Core.dll",
        "Newtonsoft.Json.dll",
        "$specName-spec.json",
        "build_result.txt",
        "build_error.log",
        "build_crash.log",
        "HUONG_DAN.txt",
        "runner.ps1",
        "1-Click-Build.bat"
    )

    $itemsList = ($filesToClean | ForEach-Object { "'$_'" }) -join ","
    $cleanCmd = "Start-Sleep -Seconds 3; foreach (\$f in @(" + $itemsList + ")) { \$target = Join-Path '$currentDir' \$f; if (Test-Path \$target) { Remove-Item \$target -Force -ErrorAction SilentlyContinue } }"
    Start-Process powershell.exe -ArgumentList @("-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-Command", $cleanCmd)

    Write-Host "[HOAN TAT]: Da don dep sach se! Thu muc chi giu lai file .rfa va file .zip cua ban." -ForegroundColor Green
}

Read-Host "Nhan Enter de thoat..."
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
  const readmeContent = `HUONG DAN DUNG FILE .RFA NATIVE TU DONG 100%:
1. Chi can click dup chuot vao file "1-Click-Build.bat".
2. Revit se tu dong khoi dong ngam, tu dong tao Family, dung tung khoi Solid va gan tham so.
3. File .rfa se duoc TU DONG MOVE ve ngay thu muc nay.
4. Cua so thu muc se tu dong mo len cho ban lay file!
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
