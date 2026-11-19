@echo off
REM 자리에서 실행: 대기 중인 청구서(일반+긴급)를 모두 ERP에 등록하고 종료
cd /d "%~dp0"
python erp_auto_register.py
