@echo off
REM 관리자 PC에서 실행 (erp_auto_register.py 를 바꿀 때마다 다시 실행)
cd /d "%~dp0"
tasklist /FI "IMAGENAME eq ERP자동등록.exe" | find /I "ERP자동등록.exe" >nul
if not errorlevel 1 (
  echo [안내] ERP자동등록.exe 가 실행 중입니다. 그 창을 닫은 뒤 다시 실행하세요.
  pause
  exit /b 1
)
python -m pip install selenium requests pyinstaller
if errorlevel 1 (
  echo.
  echo [오류] 패키지 설치에 실패했습니다. 위 메시지를 확인하세요.
  pause
  exit /b 1
)
python -m PyInstaller --onefile --clean --collect-all selenium --name ERP자동등록 erp_auto_register.py
if errorlevel 1 (
  echo.
  echo [오류] exe 빌드에 실패했습니다. 위 메시지를 확인하세요.
  pause
  exit /b 1
)
copy /Y "dist\ERP자동등록.exe" "%~dp0" >nul
if errorlevel 1 (
  echo [오류] 새 exe를 폴더로 복사하지 못했습니다. ERP자동등록.exe 창이 열려 있으면 닫고 다시 실행하세요.
  pause
  exit /b 1
)
echo.
echo 완료: ERP자동등록.exe 가 이 폴더에 복사되었습니다. (config.json 과 같은 폴더)
pause
