@echo off
REM ERP 구매요청서 등록 화면에서 고를 수 있는 값(설비구분, 용도, 유무상, 상세, 사유1, 사유2)을 CSV로 저장. 저장 버튼은 누르지 않음
cd /d "%~dp0"
python erp_auto_register.py --codes
