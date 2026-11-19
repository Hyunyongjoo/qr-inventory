@echo off
REM ERP 전용 크롬에 지금 열려 있는 화면(메인, 팝업, 선택창)의 캡처와 구조를 debug 폴더에 저장
cd /d "%~dp0"
python erp_auto_register.py --dump
