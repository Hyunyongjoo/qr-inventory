@echo off
REM ERP 전용 크롬 (원격 제어 포트 9222, 별도 프로필)
REM 이 크롬으로 ERP에 로그인해 두면 자동등록 프로그램이 접속해서 사용합니다.
REM 결재창(그룹웨어) 팝업이 막히지 않도록 이 전용 크롬은 팝업 차단을 끈 채로 실행합니다.
set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo [오류] 크롬을 찾지 못했습니다.
  echo 크롬 바로가기 우클릭 - 속성 - 대상 에 나오는 chrome.exe 경로를 알려주세요.
  pause
  exit /b 1
)
start "" "%CHROME%" --remote-debugging-port=9222 --disable-popup-blocking --user-data-dir="%LOCALAPPDATA%\ERP_Chrome_Profile" https://www.unisem.kr/Account/login
