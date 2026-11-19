@echo off
REM 자리에서 실행: 이 사이트 출고 시트의 출고(오늘까지, 출고번호 빈 행)를 ERP 자재 출고등록으로 등록
cd /d "%~dp0"
python erp_auto_register.py --out
