@echo off
REM 자리 비울 때 실행: 외부에서 긴급 등록한 건만 1분마다 확인해서 ERP에 자동 등록
REM (exe 없이 같은 폴더의 erp_auto_register.py 를 실행)
cd /d "%~dp0"
python erp_auto_register.py --watch
if errorlevel 1 pause
