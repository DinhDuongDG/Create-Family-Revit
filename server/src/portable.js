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

  // 3. Tạo file manifest FamilyAgent.addin dạng portable chỉ định dll trong thư mục này
  const manifestContent = `<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Command">
    <Name>Family Agent Portable Builder</Name>
    <Assembly>FamilyAgent.Addin.dll</Assembly>
    <AddInId>7a0e384e-2c11-4f5a-9a0e-6f1f4d1c2b88</AddInId>
    <FullClassName>FamilyAgent.Addin.PortableBuildCommand</FullClassName>
    <Text>Build ${spec.name || "Family"}</Text>
    <Description>Auto-build native parametric family</Description>
    <VisibilityMode>AlwaysVisible</VisibilityMode>
    <VendorId>FAMLYAGT</VendorId>
    <VendorDescription>Family Agent Studio</VendorDescription>
  </AddIn>
</RevitAddIns>`;
  fs.writeFileSync(path.join(packageDir, "FamilyAgent.addin"), manifestContent, "utf8");

  // 4. Tạo file kịch bản Revit Journal (Tự động chạy PortableBuildCommand và đóng Revit)
  const journalContent = `' Revit Journal Script - Tự động dựng Native Family bằng FamilyAgent Portable
Dim Jrn
Set Jrn = CrsJournalScript
Jrn.Command "Ribbon" , " , ExternalCommand:CustomCtrl_%CustomCtrl_%Family Agent Portable Builder%FamilyAgent.Addin.PortableBuildCommand"
`;
  fs.writeFileSync(path.join(packageDir, "run_build.txt"), journalContent, "utf8");

  // 5. Tạo file Chay_Tu_Dong.bat để người dùng click đúp
  const batContent = `@echo off
chcp 65001 >nul
title Dựng Family Revit Tự Động (Portable - Không cần cài Addin)
echo =====================================================================
echo  ĐANG KHỞI ĐỘNG BỘ DỰNG FAMILY REVT TỰ ĐỘNG (1-CLICK NATIVE BUILDER)
echo =====================================================================
echo Đang tìm kiếm phiên bản Autodesk Revit trên máy của bạn...

set "REVIT_EXE="

:: Tìm Revit 2024, 2025, 2026, 2023
if exist "C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe" set "REVIT_EXE=C:\\Program Files\\Autodesk\\Revit 2024\\Revit.exe"
if not defined REVIT_EXE (if exist "C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe" set "REVIT_EXE=C:\\Program Files\\Autodesk\\Revit 2025\\Revit.exe")
if not defined REVIT_EXE (if exist "C:\\Program Files\\Autodesk\\Revit 2026\\Revit.exe" set "REVIT_EXE=C:\\Program Files\\Autodesk\\Revit 2026\\Revit.exe")
if not defined REVIT_EXE (if exist "C:\\Program Files\\Autodesk\\Revit 2023\\Revit.exe" set "REVIT_EXE=C:\\Program Files\\Autodesk\\Revit 2023\\Revit.exe")

if not defined REVIT_EXE (
    echo [LỖI] Không tìm thấy Revit trên máy tại đường dẫn mặc định C:\\Program Files\\Autodesk!
    echo Vui lòng đảm bảo máy bạn đã cài đặt Revit.
    pause
    exit /b
)

echo Đã tìm thấy: %REVIT_EXE%
echo.
echo Đang chuẩn bị môi trường chạy Portable tạm thời...

set "TEMP_ADDIN_DIR=%APPDATA%\\Autodesk\\Revit\\Addins\\2024"
if not exist "%TEMP_ADDIN_DIR%" mkdir "%TEMP_ADDIN_DIR%"

:: Tạo file manifest tạm thời trỏ đến thư mục hiện tại
(
echo ^<?xml version="1.0" encoding="utf-8"?^>
echo ^<RevitAddIns^>
echo   ^<AddIn Type="Command"^>
echo     ^<Name^>Family Agent Portable^</Name^>
echo     ^<Assembly^>%~dp0FamilyAgent.Addin.dll^</Assembly^>
echo     ^<AddInId^>7a0e384e-2c11-4f5a-9a0e-6f1f4d1c2b88^</AddInId^>
echo     ^<FullClassName^>FamilyAgent.Addin.PortableBuildCommand^</FullClassName^>
echo     ^<Text^>Build Family^</Text^>
echo     ^<VendorId^>FAMLYAGT^</VendorId^>
echo   ^</AddIn^>
echo ^</RevitAddIns^>
) > "%TEMP_ADDIN_DIR%\\FamilyAgent_Portable_Temp.addin"

echo.
echo =====================================================================
echo [BƯỚC 1]: Nếu Revit đang mở, bạn chỉ cần vào Tab [Add-Ins] bấm [Build Family]
echo           (hoặc bấm [External Tools] -> [Build Family]).
echo.
echo [BƯỚC 2]: Nếu muốn tự động mở Revit để dựng ngay, bấm phím bất kỳ!
echo =====================================================================
pause

echo Đang gọi Revit dựng hình...
start "" "%REVIT_EXE%"

echo.
echo Đang theo dõi tiến trình tạo file .rfa...
:WAIT_LOOP
timeout /t 3 /nobreak >nul
if exist "%~dp0*.rfa" goto FINISHED
goto WAIT_LOOP

:FINISHED
echo.
echo =====================================================================
echo  THÀNH CÔNG! ĐÃ TẠO XONG FILE .RFA TẠI THƯ MỤC NÀY!
echo  (Từng khối Solid nguyên bản + Đầy đủ tham số biến thiên)
echo =====================================================================
:: Dọn dẹp manifest tạm thời
if exist "%TEMP_ADDIN_DIR%\\FamilyAgent_Portable_Temp.addin" del "%TEMP_ADDIN_DIR%\\FamilyAgent_Portable_Temp.addin"
pause
`;
  fs.writeFileSync(path.join(packageDir, "1-Click-Build.bat"), batContent, "utf8");

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
