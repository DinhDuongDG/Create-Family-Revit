@echo off
chcp 65001 >nul
echo ========================================================
echo   ĐỒNG BỘ CODE TỪ TÁC GIẢ GỐC (UPSTREAM) CHO REPO NÀY
echo ========================================================
echo.

echo [1/3] Đang lấy cập nhật mới nhất từ tác giả gốc (upstream)...
git fetch upstream
if %errorlevel% neq 0 (
    echo [LỖI] Không thể kết nối hoặc tải từ upstream. Vui lòng kiểm tra lại mạng hoặc repo tác giả!
    pause
    exit /b %errorlevel%
)

echo.
echo [2/3] Đang gộp (merge) code mới vào nhánh main hiện tại...
git merge upstream/main
if %errorlevel% neq 0 (
    echo.
    echo [CẢNH BÁO] Có xung đột code (conflict) giữa code bạn sửa và code tác giả mới cập nhật!
    echo Vui lòng mở VS Code hoặc IDE để xử lý conflict, sau đó commit và push thủ công.
    pause
    exit /b %errorlevel%
)

echo.
echo [3/3] Đang đẩy (push) cập nhật mới lên GitHub của bạn (origin)...
git push origin main
if %errorlevel% neq 0 (
    echo [LỖI] Không thể push lên GitHub của bạn. Vui lòng kiểm tra quyền truy cập!
    pause
    exit /b %errorlevel%
)

echo.
echo ========================================================
echo   ĐỒNG BỘ THÀNH CÔNG! REPO ĐÃ CẬP NHẬT MỚI NHẤT.
echo ========================================================
pause
