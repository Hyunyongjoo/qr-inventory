"""
ERP 구매요청서 자동등록 - 사무실 PC 자동등록 프로그램
==================================================

동작
----
1. 'ERP전용크롬.bat'으로 연 크롬(원격 제어 포트 9222)에 접속한다.
   -> 창 위치/크기/가려짐과 무관. 좌표를 쓰지 않고 화면 요소(텍스트/라벨)로 찾는다.
2. (부재 중 대기 모드) 1분마다 QR 프로그램 웹앱 API(action=pending, scope=urgent)를 호출한다.
   처리할 건이 없으면 Apps Script가 캐시만 보고 즉시 빈 목록을 돌려준다(가볍고 빠름).
3. 배치가 오면 unisem.kr 탭에서
      A/S 관리 -> 자재관리 -> 구매요청서 관리 -> 등록
      -> 설비구분/용도/명칭/유무상/유무상상세/사유1/사유2 입력
      -> 구매요청자재 액셀Upload -> 파일 첨부 -> Upload -> 저장
   을 진행하고, 결과(완료/실패)를 API(action=result)로 돌려준다.
4. 5분마다 heartbeat를 보내고, 로그인이 풀려 있으면 '로그인필요'를 보고한다
   (Apps Script가 담당자에게 메일 발송).

전부 무료: Python, Selenium(Selenium Manager가 크롬드라이버 자동 준비), 크롬.

실행 방식 2가지
  - ERP자동등록.exe            : 자리에서 1회 실행. 대기 중인 일반+긴급 청구서 전부 등록 후 종료
  - ERP자동등록.exe --watch    : 자리 비울 때 켜두기. 긴급 건만 1분마다 확인해서 등록
                                 (부재중_대기모드.bat)

설정: 같은 폴더의 config.json
"""

import base64
import json
import logging
import re
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import requests
# exe(PyInstaller)에서 빠지지 않도록 크롬 모듈을 직접 import
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.chrome.webdriver import WebDriver as ChromeDriver
from selenium.common.exceptions import (
    NoAlertPresentException,
    NoSuchElementException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import Select, WebDriverWait

# ---------------------------------------------------------------- 설정
VERSION = "2026-11-20 v30 (요청자: 서버 fields.요청자 우선, 없으면 line/명칭으로 찾기)"
BASE_DIR = Path(sys.executable if getattr(sys, "frozen", False) else __file__).resolve().parent
try:
    CFG = json.loads((BASE_DIR / "config.json").read_text(encoding="utf-8-sig"))
except FileNotFoundError:
    print(f"[안내] config.json 이 없습니다. exe와 같은 폴더({BASE_DIR})에 config.json 을 두세요.")
    input("Enter를 누르면 닫힙니다 >> ")
    sys.exit(1)
except json.JSONDecodeError as e:
    print(f"[안내] config.json 형식이 잘못되었습니다 ({e}). 쉼표·따옴표를 확인하세요.")
    input("Enter를 누르면 닫힙니다 >> ")
    sys.exit(1)

_SECRET = BASE_DIR / "접속정보.json"
if _SECRET.exists():
    try:
        CFG.update(json.loads(_SECRET.read_text(encoding="utf-8-sig")))
    except json.JSONDecodeError as e:
        print(f"[안내] 접속정보.json 형식이 잘못되었습니다 ({e}).")
API_URL = CFG["api_url"]
TOKEN = CFG["token"]
POLL_SEC = CFG.get("poll_seconds", 60)
HEARTBEAT_SEC = CFG.get("heartbeat_seconds", 300)
KEEPALIVE_SEC = CFG.get("keepalive_seconds", 600)
DEBUG_PORT = CFG.get("chrome_debug_port", 9222)
ERP_HOST = CFG.get("erp_host", "unisem.kr")
DRY_RUN = CFG.get("dry_run", True)          # True면 저장 직전까지만 하고 저장 안 함
MENU = CFG.get("menu_path", ["A/S 관리", "자재관리", "구매요청서 관리"])
LABELS = CFG["field_labels"]                # 필드키 -> 화면 라벨 텍스트
BTN = CFG["buttons"]                        # 버튼 텍스트
WAIT = CFG.get("wait_seconds", 10)
SITES = [s.strip() for s in CFG.get("sites", []) if s.strip()]   # 예: ["화성"]
VALID_SITES = CFG.get("valid_sites", ["화성", "평택", "기흥"])
_bad_sites = [s for s in SITES if s not in VALID_SITES]
if _bad_sites or not SITES:
    print("\n[설정 오류] config.json 의 \"sites\" 값이 올바르지 않습니다: "
          f"{SITES or '(비어 있음)'}")
    print(f"  이 PC가 맡을 사이트 하나를 적어 주세요. 예: \"sites\": [\"평택\"]   (가능한 값: {', '.join(VALID_SITES)})")
    print("  ('전체'는 쓸 수 없습니다. ERP 사이트는 로그인 계정으로 정해지므로 PC 한 대는 한 사이트만 맡습니다.)")
    input("\nEnter를 누르면 창이 닫힙니다 >> ")
    sys.exit(1)
PC_NAME = CFG.get("pc_name", "") or "_".join(SITES) or "ERP-PC"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(BASE_DIR / "erp_auto.log", encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("erp")


# ---------------------------------------------------------------- API
def api_get_pending(scope="urgent"):
    params = {"action": "pending", "token": TOKEN, "scope": scope,
              "sites": ",".join(SITES), "pc": PC_NAME}
    r = requests.get(API_URL, params=params, timeout=60)
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"API 오류: {data}")
    batches = data.get("batches", [])
    if SITES:   # 안전장치: 혹시 다른 사이트 건이 섞여 오면 처리하지 않음
        other = [b for b in batches if b.get("site") not in SITES]
        for b in other:
            log.warning("다른 사이트 건 무시: %s %s", b.get("batch_id"), b.get("site"))
        batches = [b for b in batches if b.get("site") in SITES]
    return batches


def api_post(payload):
    payload = {"token": TOKEN, "pc": PC_NAME, "sites": SITES, **payload}
    try:
        requests.post(API_URL, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      headers={"Content-Type": "application/json"}, timeout=60)
    except requests.RequestException as e:
        log.warning("API 전송 실패: %s", e)


# ---------------------------------------------------------------- 크롬 접속
def connect_chrome():
    opts = ChromeOptions()
    opts.add_experimental_option("debuggerAddress", f"127.0.0.1:{DEBUG_PORT}")
    drv = ChromeDriver(options=opts, service=ChromeService())
    drv.implicitly_wait(0)
    return drv


def switch_to_erp_tab(drv):
    """열려 있는 탭 중 ERP 메인(구매요청서 목록) 탭으로 전환. 없으면 ERP 아무 탭. 없으면 False."""
    main_part = CFG.get("register_page_url", "").strip().lower()
    popup_part = CFG.get("popup_url_part", "JAJE011W").lower()
    fallback = None
    for h in drv.window_handles:
        drv.switch_to.window(h)
        url = drv.current_url.lower()
        if ERP_HOST not in url:
            continue
        if main_part and main_part in url:
            return True
        if popup_part not in url and fallback is None:
            fallback = h
    if fallback:
        drv.switch_to.window(fallback)
        return True
    return False


def is_logged_in(drv):
    url = drv.current_url.lower()
    return ERP_HOST in url and "login" not in url


# ---------------------------------------------------------------- 프레임 탐색 헬퍼
def _search_frames(drv, by, value, depth=0, allow_hidden=False):
    """현재 문서와 하위 iframe을 재귀 탐색해 첫 요소 반환(찾은 프레임에 머문다).
    allow_hidden=False면 화면에 보이는 요소만, True면 숨겨진 요소도 반환."""
    for el in drv.find_elements(by, value):
        try:
            if allow_hidden or el.is_displayed():
                return el
        except WebDriverException:
            continue
    if depth > 4:
        return None
    frames = drv.find_elements(By.TAG_NAME, "iframe") + drv.find_elements(By.TAG_NAME, "frame")
    for i in range(len(frames)):
        try:
            drv.switch_to.frame(frames[i])
        except WebDriverException:
            continue
        el = _search_frames(drv, by, value, depth + 1, allow_hidden)
        if el is not None:
            return el
        drv.switch_to.parent_frame()
        frames = drv.find_elements(By.TAG_NAME, "iframe") + drv.find_elements(By.TAG_NAME, "frame")
    return None


def find(drv, by, value, timeout=WAIT, allow_hidden=False):
    end = time.time() + timeout
    while True:
        drv.switch_to.default_content()
        el = _search_frames(drv, by, value, allow_hidden=allow_hidden)
        if el is not None:
            return el
        if time.time() >= end:
            raise NoSuchElementException(value)
        time.sleep(0.3)


def _norm_text(text):
    return text.replace(" ", "").replace("\u00a0", "").replace(":", "").replace("'", "")


_NORM = "translate(normalize-space({x}),' \u00a0:','')"


def xp_text(text):
    """클릭용: 글자가 정확히 같은 가장 안쪽 요소 (띄어쓰기·콜론 무시, 아이콘 등 안쪽 태그가 있어도 찾음)."""
    t = _norm_text(text)
    same = f"{_NORM.format(x='.')}='{t}'"
    return ("//*[not(self::script or self::style or self::option or self::html or self::body)]"
            f"[({same} and not(*[{same}])) or {_NORM.format(x='@value')}='{t}' or {_NORM.format(x='@title')}='{t}']")


def xp_label(text):
    """라벨용: 화면에 적힌 글자 조각(text node) 기준. '사이트 :'처럼 칸 안의 맨 글자도 찾음."""
    t = _norm_text(text)
    return f"//text()[{_NORM.format(x='.')}='{t}']"


def click_text(drv, text, timeout=WAIT):
    try:
        el = find(drv, By.XPATH, xp_text(text), timeout)
        hidden = False
    except NoSuchElementException:
        # 접힌 메뉴처럼 화면에 안 보이는 요소면 스크립트로 클릭
        el = find(drv, By.XPATH, xp_text(text), 1, allow_hidden=True)
        hidden = True
    if hidden:
        drv.execute_script("arguments[0].click();", el)
        return
    drv.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
    try:
        el.click()
    except WebDriverException:
        drv.execute_script("arguments[0].click();", el)


def exists_text(drv, text, timeout=2):
    try:
        find(drv, By.XPATH, xp_text(text), timeout)
        return True
    except NoSuchElementException:
        return False


def _dump_frames(drv, d, prefix, path, depth):
    """현재 프레임 안의 하위 프레임을 재귀로 저장 (예: frame1, frame1_1 ...)."""
    if depth > 4:
        return
    n = len(drv.find_elements(By.TAG_NAME, "iframe") + drv.find_elements(By.TAG_NAME, "frame"))
    for i in range(n):
        try:
            drv.switch_to.default_content()
            for idx in path:
                fr = drv.find_elements(By.TAG_NAME, "iframe") + drv.find_elements(By.TAG_NAME, "frame")
                drv.switch_to.frame(fr[idx])
            fr = drv.find_elements(By.TAG_NAME, "iframe") + drv.find_elements(By.TAG_NAME, "frame")
            drv.switch_to.frame(fr[i])
            name = "_".join(str(x + 1) for x in path + [i])
            src = drv.execute_script("return location.href;")
            (d / f"{prefix}_frame{name}.html").write_text(f"<!-- {src} -->\n" + drv.page_source, encoding="utf-8")
            _dump_frames(drv, d, prefix, path + [i], depth + 1)
        except WebDriverException:
            continue


def _dump_window(drv, d, prefix):
    drv.switch_to.default_content()
    drv.save_screenshot(str(d / f"{prefix}_screen.png"))
    (d / f"{prefix}_url.txt").write_text(drv.current_url, encoding="utf-8")
    (d / f"{prefix}_page.html").write_text(drv.page_source, encoding="utf-8")
    _dump_frames(drv, d, prefix, [], 0)
    drv.switch_to.default_content()


def dump_debug(drv, name):
    """실패 시 열려 있는 ERP 창 전부(메인·팝업)의 화면 캡처와 화면 구조(HTML)를 debug 폴더에 저장."""
    try:
        d = BASE_DIR / "debug" / f"{datetime.now():%Y%m%d_%H%M%S}_{name}"
        d.mkdir(parents=True, exist_ok=True)
        cur = drv.current_window_handle
        for i, h in enumerate(drv.window_handles, 1):
            try:
                drv.switch_to.window(h)
                u = drv.current_url.lower()
                # ERP 창 + ERP에서 띄운 다른 주소의 창(전자결재 등)도 저장. 크롬 내부 화면은 제외
                if u.startswith("http") and ("--dump" in sys.argv or ERP_HOST in u or CFG.get("groupware_host", "ekp.unisem.co.kr") in u
                                           or CFG.get("dump_all_windows", False)):
                    _dump_window(drv, d, f"win{i}")
            except WebDriverException:
                continue
        try:
            drv.switch_to.window(cur)
        except WebDriverException:
            pass
        log.info("진단 자료 저장: %s", d)
        return d
    except Exception as e:  # noqa: BLE001
        log.warning("진단 자료 저장 실패: %s", e)
        return None


_LABEL_TO_KEY = {v: k for k, v in LABELS.items()}


# 등록 팝업(JAJE011W)의 실제 칸 id (화면 구조 확인 결과). config의 field_ids로 바꿀 수 있음
FIELD_IDS = {
    "사이트": "sMainContent_SITE_NAME",
    "설비구분": "sMainContent_C1ComboBox3",
    "용도": "sMainContent_SETX_NAME",
    "명칭": "sMainContent_RQST_NAME",
    "유무상": "sMainContent_PAYX_GUBN",
    "유무상상세": "sMainContent_PAYD_NAME",
    "원인부서": "sMainContent_RESN_DEPT2",
    "사유1": "sMainContent_C1ComboBox1",
    "사유2": "sMainContent_C1ComboBox2",
    "기타요청사유": "sMainContent_CAUS_TEXT",
}
FIELD_IDS.update(CFG.get("field_ids", {}))


def field_by_label(drv, label, timeout=WAIT):
    """칸 찾기: 화면 id가 알려진 칸은 id로, 아니면 라벨 뒤의 '보이는' 첫 입력칸."""
    key = _LABEL_TO_KEY.get(label, label)
    if key in FIELD_IDS:
        return find(drv, By.ID, FIELD_IDS[key], timeout, allow_hidden=True)
    xp = (f"({xp_label(label)})[1]/following::*"
          f"[self::select or self::textarea or (self::input and not(@type='hidden') "
          f"and not(@type='button') and not(@type='submit'))]")
    return find(drv, By.XPATH, xp, timeout)


def is_shown(drv, label):
    try:
        return field_by_label(drv, label, 2).is_displayed()
    except (NoSuchElementException, WebDriverException):
        return False


def get_field_value(drv, label):
    el = field_by_label(drv, label)
    if el.tag_name.lower() == "select":
        return Select(el).first_selected_option.text.strip()
    return (el.get_attribute("value") or "").strip()


DROPDOWN_KEYS = set(CFG.get("dropdown_fields", ["설비구분", "사유1", "사유2"]))


def _pick_from_list(drv, label, value):
    """직접 만든 드롭다운(목록이 따로 펼쳐지는 방식): 칸을 눌러 목록을 열고 해당 값을 클릭."""
    el = field_by_label(drv, label)
    drv.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
    try:
        el.click()
    except WebDriverException:
        drv.execute_script("arguments[0].click();", el)
    time.sleep(0.5)
    t = _norm_text(value)
    same = f"{_NORM.format(x='.')}='{t}'"
    # 라벨 뒤쪽에 나타난 같은 글자의 항목 (목록이 화면 맨 아래에 붙는 경우도 포함)
    opt_xp = (f"(({xp_label(label)})[1]/following::*[not(self::script or self::style)]"
              f"[{same} and not(*[{same}])])")
    try:
        opt = find(drv, By.XPATH, opt_xp, 3)
    except NoSuchElementException:
        # 목록이 안 열렸으면 글자를 입력하고 Enter (입력형 콤보박스)
        from selenium.webdriver.common.keys import Keys
        el.send_keys(value)
        time.sleep(0.3)
        el.send_keys(Keys.ENTER)
        return
    try:
        opt.click()
    except WebDriverException:
        drv.execute_script("arguments[0].click();", opt)
    _close_dropdowns(drv)


def _close_dropdowns(drv):
    """펼쳐진 드롭다운 목록을 닫음 (아래 칸을 가리지 않도록)."""
    time.sleep(0.3)
    try:
        from selenium.webdriver.common.keys import Keys
        drv.switch_to.active_element.send_keys(Keys.ESCAPE)
    except WebDriverException:
        pass
    try:
        # 빈 곳(화면 맨 위 제목 영역) 클릭 + 열린 wijmo 목록 강제로 숨김
        drv.execute_script(
            "document.querySelectorAll('.wijmo-wijcombobox-list, .wijmo-wijlist').forEach(function(e){"
            "  if (e.offsetParent !== null) { e.style.display='none'; } });")
    except WebDriverException:
        pass
    time.sleep(0.2)


def _type_text(drv, el, value):
    """글자 칸 입력: 일반 입력 -> 안 되면(가려짐 등) 스크립트로 값 넣기."""
    drv.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
    try:
        el.clear()
        el.send_keys(value)
    except WebDriverException as e:
        log.info("글자 입력이 막혀 스크립트로 입력 (%s)", str(e).splitlines()[0][:80])
        drv.execute_script(
            "arguments[0].value = arguments[1];"
            "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));"
            "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));", el, value)


POPUP_KEYS = set(CFG.get("popup_fields", ["용도", "유무상", "유무상상세"])) | {"원인부서"}
POPUP_SELECT_BTN = CFG.get("popup_select_button", "선택")


def _search_in_popup(drv, label, value, cell_xp):
    """검색칸이 있는 선택 팝업(예: 부서조회): 검색어 입력 -> '조회' -> 목록에서 다시 찾기. 못 찾으면 None.
    검색어는 찾을 값 자체(예: SP단지, Foundry팀). 못 찾으면 앞 2글자로 한 번 더 검색."""
    keywords = [value]
    if len(value) > 2:
        keywords.append(value[:2])
    for keyword in keywords:
        try:
            find(drv, By.XPATH, xp_text(POPUP_SELECT_BTN), 3)      # 팝업 목록이 있는 프레임으로 이동
        except NoSuchElementException:
            return None
        boxes = [b for b in drv.find_elements(By.XPATH, "//input[@type='text' or not(@type)]") if b.is_displayed()]
        if not boxes:
            return None
        box = boxes[0]
        box.clear()
        box.send_keys(keyword)
        btns = [b for b in drv.find_elements(By.XPATH, xp_text(CFG.get("popup_search_button", "조회"))) if b.is_displayed()]
        if btns:
            drv.execute_script("arguments[0].click();", btns[0])
        else:
            from selenium.webdriver.common.keys import Keys
            box.send_keys(Keys.ENTER)
        time.sleep(1.0)
        try:
            return find(drv, By.XPATH, cell_xp, 5)
        except NoSuchElementException:
            log.info("'%s' 검색어 '%s'로 '%s'를 못 찾음", label, keyword, value)
    return None


def _pick_from_popup(drv, label, value):
    """코드 선택 팝업(용도조회 / 유무상 선택 / 상세정보): 칸 클릭 -> 표에서 코드명이 같은 줄 클릭 -> '선택'."""
    el = field_by_label(drv, label)
    drv.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", el)
    time.sleep(1.0)   # 선택 팝업 안의 목록(iframe)이 새로 불러와질 시간
    # 팝업의 '선택' 버튼이 보일 때까지 대기
    btn = find(drv, By.XPATH, xp_text(POPUP_SELECT_BTN), WAIT)
    time.sleep(0.4)
    t = _norm_text(value)
    same = f"{_NORM.format(x='.')}='{t}'"
    # '선택' 버튼 뒤쪽(=팝업 표)에서 코드명이 같은 칸. 띄어쓰기 차이는 무시 (A/S 자재 = A/S자재)
    cell_xp = (f"({xp_text(POPUP_SELECT_BTN)})/following::*"
               f"[not(self::input or self::textarea or self::script or self::style)][{same} and not(*[{same}])]")
    try:
        cell = find(drv, By.XPATH, cell_xp, 3)
    except NoSuchElementException:
        cell = _search_in_popup(drv, label, value, cell_xp)
    if cell is None:
        # 목록에 없으면 팝업을 닫고 실패 처리
        try:
            click_text(drv, CFG.get("popup_cancel_button", "취소"), 2)
        except NoSuchElementException:
            pass
        raise RuntimeError(f"'{label}' 선택 팝업에 '{value}' 항목이 없습니다. 구매유형 조건표 값과 ERP 코드명을 확인하세요.")
    drv.execute_script("arguments[0].scrollIntoView({block:'center'});", cell)
    try:
        cell.click()
    except WebDriverException:
        drv.execute_script("arguments[0].click();", cell)
    time.sleep(0.3)
    # 팝업이 아직 열려 있으면 '선택' 클릭 (더블클릭처럼 바로 닫히는 경우는 생략)
    try:
        btn = find(drv, By.XPATH, xp_text(POPUP_SELECT_BTN), 1)
        try:
            btn.click()
        except WebDriverException:
            drv.execute_script("arguments[0].click();", btn)
    except NoSuchElementException:
        pass
    accept_alerts(drv, 1)
    time.sleep(0.5)


def set_field(drv, label, value):
    if value in (None, ""):
        log.warning("'%s' 값이 비어 있어 건너뜀 (구매유형 조건표 확인)", label)
        return
    el = field_by_label(drv, label)
    tag = el.tag_name.lower()
    if tag == "select":
        sel = Select(el)
        norm = value.replace(" ", "")
        try:
            sel.select_by_visible_text(value)
        except NoSuchElementException:
            for opt in sel.options:
                if opt.text.replace(" ", "") == norm:
                    sel.select_by_visible_text(opt.text)
                    break
            else:
                opts = ", ".join(o.text.strip() for o in sel.options if o.text.strip())
                raise RuntimeError(f"'{label}' 목록에 '{value}' 없음 (목록: {opts[:200]})")
    elif _LABEL_TO_KEY.get(label, label) in POPUP_KEYS:
        _pick_from_popup(drv, label, value)
    elif _LABEL_TO_KEY.get(label, label) in DROPDOWN_KEYS or el.get_attribute("readonly") is not None:
        _pick_from_list(drv, label, value)
    else:
        _close_dropdowns(drv)
        _type_text(drv, el, value)
    # 상위 선택에 따라 하위 목록(예: 유무상 -> 상세, 사유1 -> 사유2)이 바뀌는 경우 대기
    time.sleep(0.6)
    # 원인부서는 코드칸(RESN_DEPT2) 옆 이름칸(RESN_NAME)에 부서명이 표시됨
    verify_id = {"원인부서": "sMainContent_RESN_NAME"}.get(_LABEL_TO_KEY.get(label, label))
    if verify_id:
        shown = (find(drv, By.ID, verify_id, 3, allow_hidden=True).get_attribute("value") or "").strip()
    else:
        shown = get_field_value(drv, label)
    if shown.replace(" ", "") != value.replace(" ", ""):
        raise RuntimeError(f"'{label}' 입력 실패: 넣으려던 값 '{value}' / 화면 값 '{shown}'")


def accept_alerts(drv, timeout=3):
    """확인창(alert/confirm)을 모두 수락하고 마지막 메시지 반환."""
    msg = ""
    end = time.time() + timeout
    while time.time() < end:
        try:
            a = drv.switch_to.alert
            msg = a.text
            a.accept()
            end = time.time() + 1.5
        except NoAlertPresentException:
            time.sleep(0.2)
        except WebDriverException:
            break          # 보고 있던 창이 닫힘(저장 후 팝업 자동 종료 등)
    return msg


# ---------------------------------------------------------------- 등록 절차
def go_main_page(drv):
    """자재관리 화면으로 이동 -> 왼쪽 메뉴 '구매요청서 등록' 탭이 없으면 열기 -> '등록' 버튼이 보일 때까지 대기."""
    go_page(drv, CFG.get("register_page_url", ""), CFG.get("register_menu_button_id", "btn1"),
            CFG.get("register_tab_url", "/WARRJAJE/JAJE010"), CFG.get("register_menu_text", "구매요청서 등록"))


def go_page(drv, page_url, menu_id, tab_url, tab_title):
    """ERP 화면(page_url)으로 이동 -> 왼쪽 메뉴 탭이 없으면 열기 -> '등록' 버튼이 보일 때까지 대기."""
    drv.switch_to.default_content()
    url = (page_url or "").strip()
    if url:
        if url.startswith("/"):
            base = drv.execute_script("return location.origin;")
            url = base + url
        if url.lower() not in drv.current_url.lower():
            drv.get(url)
            accept_alerts(drv, 1)
    if exists_text(drv, BTN["register"], 2):
        return
    # 탭이 닫혀 있음(새로고침 등) -> 왼쪽 메뉴 클릭
    drv.switch_to.default_content()
    try:
        btn = drv.find_element(By.ID, menu_id)
        try:
            btn.click()
        except WebDriverException:
            drv.execute_script("arguments[0].click();", btn)
        log.info("왼쪽 메뉴 '%s' 클릭", tab_title)
    except NoSuchElementException:
        log.warning("왼쪽 메뉴 버튼(id=%s)을 찾지 못함", menu_id)
    # 탭(iframe)이 생겼는지 확인, 없으면 화면의 탭 열기 기능을 직접 실행
    time.sleep(2)
    drv.switch_to.default_content()
    has_tab = drv.execute_script(
        "return !!document.querySelector(\"#tt iframe[src*='\" + arguments[0] + \"']\");", tab_url.split("/")[-1])
    if not has_tab:
        log.info("탭이 열리지 않아 탭 열기 기능을 직접 실행")
        drv.execute_script("addTab(arguments[0], arguments[1]);", tab_title, tab_url)
    if not exists_text(drv, BTN["register"], CFG.get("tab_load_seconds", 25)):
        raise RuntimeError(f"'{tab_title}' 탭을 열었지만 '등록' 버튼을 찾지 못했습니다.")
    log.info("'%s' 탭 준비 완료", tab_title)


LIST_GRID_ID = CFG.get("list_grid_id", "ctl00_sMainContent_C1GridView1")   # 구매요청서 목록 표
LIST_SEARCH_ID = CFG.get("list_search_id", "sMainContent_LinkSer")          # 목록 '조회' 버튼
LIST_FROM_ID = CFG.get("list_from_date_id", "sMainContent_FROM_DATE")       # 조회 시작일
PR_RE = re.compile(r"PR\d{2}-\d{4}-\d{4}")


def _read_list_numbers(drv, title):
    """구매요청서 목록에서 명칭이 title과 같은 줄의 구매요청번호 목록."""
    grid = find(drv, By.ID, LIST_GRID_ID, 5, allow_hidden=True)
    rows = drv.execute_script("""
        var g = arguments[0];
        var w = document.getElementById(g.id + '_div') || g;
        var out = [];
        w.querySelectorAll('tr').forEach(function(tr){
            var c = Array.from(tr.querySelectorAll('td')).map(function(td){
                return (td.innerText || td.textContent || '').trim(); });
            var i = c.findIndex(function(x){ return /^PR\\d{2}-\\d{4}-\\d{4}$/.test(x); });
            if (i >= 0) out.push([c[i], c[i+1] || '']);   // 구매요청번호 바로 다음 칸이 명칭
        });
        return out;""", grid)
    want = _norm_text(title)
    return [n for n, t in rows if PR_RE.fullmatch(n) and _norm_text(t) == want]


def refresh_list(drv, today_only=True):
    """목록 '조회'를 눌러 새로 읽음 (조회 시작일을 오늘로 맞춰 목록을 짧게)."""
    btn = find(drv, By.ID, LIST_SEARCH_ID, WAIT, allow_hidden=True)
    if today_only:
        try:
            drv.execute_script("var e=document.getElementById(arguments[0]); if(e){e.value=arguments[1];}",
                               LIST_FROM_ID, datetime.now().strftime("%Y-%m-%d"))
        except WebDriverException:
            pass
    try:
        old = drv.find_element(By.ID, LIST_GRID_ID)
    except WebDriverException:
        old = None
    drv.execute_script("arguments[0].click();", btn)
    accept_alerts(drv, 1)
    if old is not None:
        try:
            WebDriverWait(drv, 15).until(EC.staleness_of(old))
        except TimeoutException:
            pass
    time.sleep(1.0)


def list_snapshot(drv, title):
    """등록 전: 같은 명칭으로 이미 있는 구매요청번호 (저장 후 새 번호를 가려내기 위함)."""
    try:
        go_main_page(drv)
        refresh_list(drv)
        nums = set(_read_list_numbers(drv, title))
        log.info("등록 전 같은 명칭 구매요청: %s건", len(nums))
        return nums
    except Exception as e:  # noqa: BLE001
        log.warning("등록 전 목록 확인 실패(계속 진행): %s", str(e).splitlines()[0][:150] if str(e) else e)
        return None


def capture_pr_number(drv, title, before):
    """저장 후: 목록을 다시 조회해 새로 생긴 구매요청번호를 찾음. 못 찾으면 빈 문자열."""
    today = datetime.now().strftime("%m%d")
    for attempt in range(CFG.get("pr_capture_tries", 4)):
        try:
            switch_to_erp_tab(drv)
            go_main_page(drv)
            refresh_list(drv)
            nums = _read_list_numbers(drv, title)
            new = [n for n in nums if before is None or n not in before]
            new = [n for n in new if n[5:9] == today] or new
            if new:
                pr = max(new)
                if len(new) > 1:
                    log.warning("같은 명칭의 새 구매요청이 %s건: %s -> %s 사용", len(new), new, pr)
                return pr
        except Exception as e:  # noqa: BLE001
            log.warning("구매요청번호 확인 %s회차 실패: %s", attempt + 1, str(e).splitlines()[0][:150] if str(e) else e)
        time.sleep(2)
    return ""


def close_stale_popups(drv):
    """앞 건에서 남은 등록 팝업 창을 모두 닫음 (남아 있으면 새 팝업이 뜨지 않음)."""
    part = CFG.get("popup_url_part", "JAJE011W").lower()
    keep = None
    closed = 0
    for h in list(drv.window_handles):
        try:
            drv.switch_to.window(h)
            if part in drv.current_url.lower():
                accept_alerts(drv, 0.5)
                drv.close()
                closed += 1
            elif keep is None:
                keep = h
        except WebDriverException:
            continue
    if keep:
        drv.switch_to.window(keep)
    switch_to_erp_tab(drv)
    if closed:
        log.info("남아 있던 등록 팝업 %s개를 닫음", closed)


def open_register_form(drv):
    """메인 화면 우측 상단 '등록' -> 새 창(자재 구매요청서 등록 팝업)으로 전환. 메인 창 핸들 반환."""
    close_stale_popups(drv)
    go_main_page(drv)
    main = drv.current_window_handle
    before = set(drv.window_handles)
    click_text(drv, BTN["register"])
    try:
        WebDriverWait(drv, WAIT).until(lambda d: len(set(d.window_handles) - before) > 0)
        drv.switch_to.window((set(drv.window_handles) - before).pop())
    except TimeoutException:
        # ERP는 같은 이름의 창을 다시 쓰므로, 등록 창이 이미 있으면 새 창 대신 그 창이 새로 열림 -> 그 창으로 이동
        part = CFG.get("popup_url_part", "JAJE011W").lower()
        found = False
        for h in drv.window_handles:
            if h == main:
                continue
            try:
                drv.switch_to.window(h)
                if part in drv.current_url.lower():
                    found = True
                    log.info("기존 등록 창이 다시 열림 - 그 창에서 진행")
                    break
            except WebDriverException:
                continue
        if not found:
            drv.switch_to.window(main)
            log.warning("등록 팝업 창이 뜨지 않음 - 같은 화면에서 계속 진행")
    find(drv, By.XPATH, f"({xp_label(LABELS['용도'])})[1]/..")
    return main


def close_popup(drv, main):
    """등록 팝업이 남아 있으면 닫고 메인 창으로 복귀."""
    try:
        if drv.current_window_handle != main and drv.current_window_handle in drv.window_handles:
            drv.close()
    except WebDriverException:
        pass
    try:
        drv.switch_to.window(main)
    except WebDriverException:
        switch_to_erp_tab(drv)


UPLOAD_FILE_ID = CFG.get("upload_file_id", "FileUpload2")      # 엑셀 업로드 창의 파일 선택칸
UPLOAD_BUTTON_ID = CFG.get("upload_button_id", "UpldButton")   # 'Excel업로드' 버튼
UPLOAD_GRID_ID = CFG.get("upload_grid_id", "GridView2")         # 업로드 후 자재 목록


def upload_excel(drv, file_path, expected_rows=None, button_text=None, kind="구매"):
    """'구매요청자재 액셀Upload'(출고는 '액셀Upload') -> 파일 첨부 -> 'Excel업로드' -> 목록 전체 체크 -> 등록 화면으로 반영."""
    # 진단용: 올린 엑셀 사본을 남겨 둠 (ERP에 직접 올려서 형식 문제인지 확인 가능)
    try:
        keep = BASE_DIR / "debug" / "업로드파일"
        keep.mkdir(parents=True, exist_ok=True)
        import shutil
        shutil.copy(file_path, keep / Path(file_path).name)
        log.info("업로드 파일 사본: %s", keep / Path(file_path).name)
    except OSError as e:
        log.warning("업로드 파일 사본 저장 실패: %s", e)

    click_text(drv, button_text or BTN["excel_upload"])
    row_xp = f"//table[@id='{UPLOAD_GRID_ID}']//tr[td//input[@type='checkbox']]"
    msg = ""
    rows = []
    for attempt in (1, 2):                     # 파일이 안 넘어가면 한 번 더 시도
        # 업로드 창이 다 불러와지고 안정될 때까지 대기 (창이 열리며 한 번 더 새로고침되는 경우 대비)
        find(drv, By.ID, UPLOAD_FILE_ID, WAIT, allow_hidden=True)
        end_ready = time.time() + 10
        while time.time() < end_ready and drv.execute_script("return document.readyState") != "complete":
            time.sleep(0.2)
        time.sleep(CFG.get("upload_settle_seconds", 2.0))
        file_input = find(drv, By.ID, UPLOAD_FILE_ID, WAIT, allow_hidden=True)
        file_input.send_keys(str(file_path))   # OS 파일 선택창 없이 경로 직접 입력
        # 파일이 들어가면 화면이 'Excel업로드' 버튼을 보여줌 -> 그때까지 대기
        try:
            WebDriverWait(drv, 5).until(
                lambda d: (d.find_element(By.ID, UPLOAD_FILE_ID).get_attribute("value") or "")
                and d.find_element(By.ID, UPLOAD_BUTTON_ID).is_displayed())
        except (TimeoutException, WebDriverException):
            log.warning("[%s회차] 파일 선택 후 'Excel업로드' 버튼이 나타나지 않음", attempt)
            continue
        log.info("[%s회차] 파일 선택됨: %s", attempt, drv.find_element(By.ID, UPLOAD_FILE_ID).get_attribute("value"))
        btn = drv.find_element(By.ID, UPLOAD_BUTTON_ID)
        try:
            btn.click()                        # 사람이 누르는 것과 같은 실제 클릭
        except WebDriverException:
            drv.execute_script("arguments[0].click();", btn)
        try:
            WebDriverWait(drv, 20).until(EC.staleness_of(btn))
        except TimeoutException:
            log.warning("[%s회차] 업로드 버튼을 눌렀지만 화면이 새로고침되지 않음", attempt)

        # 결과 목록 대기
        end = time.time() + CFG.get("upload_wait_seconds", 40)
        while time.time() < end:
            msg = accept_alerts(drv, 1) or msg
            try:
                find(drv, By.ID, UPLOAD_GRID_ID, 2, allow_hidden=True)
                rows = drv.find_elements(By.XPATH, row_xp)
                if rows:
                    break
                if "Upload해" in (drv.find_element(By.ID, UPLOAD_GRID_ID).text or ""):
                    break                      # 빈 결과(파일 안 넘어감) -> 재시도
            except (NoSuchElementException, WebDriverException):
                pass
            time.sleep(0.5)
        if rows:
            break
        log.warning("[%s회차] 업로드 결과 목록이 비어 있음 - 다시 시도", attempt)

    if not rows:
        grid_text = ""
        try:
            grid_text = find(drv, By.ID, UPLOAD_GRID_ID, 2, allow_hidden=True).text.replace("\n", " ")[:200]
        except (NoSuchElementException, WebDriverException):
            pass
        raise RuntimeError(f"엑셀 업로드 후 자재 목록이 나타나지 않았습니다. 알림: {msg or '없음'} / 목록 내용: {grid_text or '없음'}")
    log.info("업로드 목록 %s건 확인", len(rows))

    # 확인사항 '없음' 또는 조달구분 '자작'인 자재는 ERP가 자동으로 빼고 넘김 -> 미리 확인
    skipped = []
    for r in rows:
        cells = [c.text.strip() for c in r.find_elements(By.TAG_NAME, "td")]
        if kind == "출고":
            if len(cells) > 7 and cells[7] in ("없음", "자작"):       # 출고 업로드 창: 확인사항 = 8번째 칸
                skipped.append(f"{cells[2]}({cells[7]})")
        elif len(cells) > 9 and (cells[9] == "없음" or cells[8] == "자작"):
            skipped.append(f"{cells[2]}({cells[9] or cells[8]})")
    if skipped and not CFG.get("allow_partial_upload", False):
        raise RuntimeError(f"ERP에서 받지 않는 자재가 있습니다: {', '.join(skipped)} "
                           f"(확인사항 '없음' 또는 조달 '자작'). 자재코드를 확인하세요.")
    if expected_rows and len(rows) != int(expected_rows):
        log.warning("업로드 자재 수 확인: 보낸 %s건 / ERP 목록 %s건", expected_rows, len(rows))

    # 전체 체크(머리글 체크박스 클릭) -> '선택' 버튼 클릭  (사람이 하는 순서 그대로)
    find(drv, By.ID, UPLOAD_GRID_ID, 3, allow_hidden=True)
    chk_all = drv.find_element(By.ID, f"{UPLOAD_GRID_ID}_chkAll")
    if not chk_all.is_selected():
        try:
            chk_all.click()
        except WebDriverException:
            drv.execute_script("arguments[0].click();", chk_all)
    time.sleep(0.3)
    unchecked = [r for r in drv.find_elements(By.XPATH, row_xp + "//input[@type='checkbox']") if not r.is_selected()]
    for cb in unchecked:                       # 혹시 빠진 줄은 하나씩 체크
        drv.execute_script("arguments[0].click();", cb)
    log.info("자재 %s건 체크 완료", len(rows))
    sel_btns = [b for b in drv.find_elements(By.XPATH, xp_text(POPUP_SELECT_BTN)) if b.is_displayed()]
    if sel_btns:
        try:
            sel_btns[0].click()
        except WebDriverException:
            drv.execute_script("arguments[0].click();", sel_btns[0])
    else:
        drv.execute_script("SelectionJaje();")  # 버튼을 못 찾으면 화면의 선택 기능을 직접 실행
    time.sleep(1.0)
    msg = accept_alerts(drv, 2) or msg
    drv.switch_to.default_content()
    if kind == "출고":
        # 출고 등록 화면은 탭 안의 iframe(asmMainF) 안에 있음 -> 표가 있는 프레임으로 이동해서 줄 수 확인
        find(drv, By.ID, "testTable", 5, allow_hidden=True)
        added = drv.execute_script("return document.querySelectorAll('#testTable>tbody tr').length;")
    else:
        # 등록 화면의 '구매요청자재' 표에 들어간 줄 수 확인
        added = drv.execute_script("return document.querySelectorAll('#testTable tr input[name=\\'t1\\']').length;")
    if not added:
        raise RuntimeError("업로드한 자재가 등록 화면 표에 들어가지 않았습니다.")
    log.info("구매요청자재 표: %s건 (업로드 목록 %s건)", added, len(rows))
    return f"자재 {added}건 반영" + (f" / 메시지: {msg}" if msg else "")

def wait_enabled(drv, label, timeout=WAIT):
    """해당 칸이 입력 가능한 상태(disabled/readonly 해제, 드롭다운이면 목록 채워짐)가 될 때까지 대기."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            el = field_by_label(drv, label)
            disabled = el.get_attribute("disabled") is not None
            if el.tag_name.lower() == "select":
                ready = not disabled and len([o for o in Select(el).options if o.text.strip()]) > 0
            else:
                ready = not disabled
            if ready:
                return True
        except (NoSuchElementException, WebDriverException):
            pass
        time.sleep(0.3)
    log.warning("'%s' 칸이 %s초 안에 입력 가능 상태가 되지 않음", label, timeout)
    return False


# 화성: 라인별 요청자 (구매요청서 '요청자' = 부서 및 사원조회 창에서 이름 검색 후 선택)
REQUESTER_BY_LINE = {"화성": {
    "NRD": "고재현", "11LINE": "고재현", "15LINE": "허영근", "16LINE": "김주빈", "17LINE": "정승현",
    # 안전용품 구매 건: QR이 요청자의 세부 사이트(USERS 시트 H1~H4)를 라인 값으로 넘김
    "H1": "고재현", "H2": "허영근", "H3": "김주빈", "H4": "정승현",
}}
for _site, _m in CFG.get("requester_by_line", {}).items():
    REQUESTER_BY_LINE.setdefault(_site, {}).update(_m)


def _line_key(v):
    """'16LINE' / '16 line' / '16L' -> '16LINE', 'h1' -> 'H1'."""
    v = re.sub(r"\s+", "", str(v or "")).upper()
    if re.fullmatch(r"\d+L", v):
        v = v[:-1] + "LINE"
    return v


def _batch_lines(b, table):
    """배치의 라인 값 목록. 서버가 line 값을 안 보내면 명칭(title)에서 표에 있는 라인 이름을 찾음."""
    raw = b.get("line") or b.get("lines") or (b.get("fields") or {}).get("라인") or ""
    if isinstance(raw, (list, tuple)):
        raw = ",".join(str(x) for x in raw)
    lines = [_line_key(x) for x in re.split(r"[,/]", str(raw)) if x.strip()]
    if lines:
        return lines, "line 값"
    title = str(b.get("title", "")).upper()
    found = [k for k in sorted(table, key=len, reverse=True) if re.search(rf"(?<![0-9A-Z]){re.escape(k)}(?![0-9A-Z])", title.replace(" LINE", "LINE"))]
    if not found:   # '16L' 처럼 줄여 쓴 명칭
        for m in re.finditer(r"(?<![0-9A-Z])(\d+)L(?!INE)(?![0-9A-Z])", title):
            if _line_key(m.group(0)) in table:
                found.append(_line_key(m.group(0)))
    return found, "명칭"


def requester_for(b):
    """배치의 사이트·라인으로 요청자 이름을 정함. 정할 수 없으면 '' (ERP 기본값 = 등록자 그대로)."""
    site = str(b.get("site", "")).strip()
    given = str((b.get("fields") or {}).get("요청자") or b.get("requester") or "").strip()
    if given:   # 서버(구매라인 시트)가 정해 준 요청자가 있으면 그대로 사용
        log.info("요청자 결정: %s (서버 구매라인 시트, 라인 %s)", given, b.get("line"))
        return given
    table ={_line_key(k): v for k, v in REQUESTER_BY_LINE.get(site, {}).items()}
    if not table:
        log.info("요청자: 사이트 '%s'는 라인별 요청자 표가 없어 등록자 그대로 둠", site)
        return ""
    lines, src = _batch_lines(b, table)
    names = {table.get(x, "") for x in lines}
    if len(names) == 1 and "" not in names:
        log.info("요청자 결정: %s (라인 %s, %s에서 찾음)", next(iter(names)), ",".join(lines), src)
        return names.pop()
    log.info("요청자: 라인을 한 사람으로 정할 수 없어 등록자 그대로 둠 (line=%r, 찾은 라인=%s, 명칭=%s)",
             b.get("line"), lines, b.get("title"))
    return ""


def set_requester(drv, name):
    """'요청자' 칸 클릭 -> 부서 및 사원조회 창 -> 이름 입력 -> 조회 -> 그 이름 줄 선택 -> '선택'."""
    el = find(drv, By.ID, CFG.get("requester_field_id", "sMainContent_EMPL_NAME"), WAIT, allow_hidden=True)
    if _norm_text(el.get_attribute("value") or "") == _norm_text(name):
        return
    drv.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", el)
    time.sleep(1.0)
    cell = _search_in_popup(drv, "요청자", name,
                            f"({xp_text(POPUP_SELECT_BTN)})/following::td[{_NORM.format(x='.')}='{_norm_text(name)}']")
    if cell is None:
        _close_popup_dialog(drv)
        raise RuntimeError(f"사원조회에서 '{name}'을(를) 찾지 못함")
    try:
        cell.click()
    except WebDriverException:
        drv.execute_script("arguments[0].click();", cell)
    time.sleep(0.3)
    try:
        btn = find(drv, By.XPATH, xp_text(POPUP_SELECT_BTN), 2)
        drv.execute_script("arguments[0].click();", btn)
    except NoSuchElementException:
        pass
    accept_alerts(drv, 1)
    time.sleep(0.6)
    shown = find(drv, By.ID, CFG.get("requester_field_id", "sMainContent_EMPL_NAME"), 5, allow_hidden=True).get_attribute("value") or ""
    if _norm_text(shown) != _norm_text(name):
        raise RuntimeError(f"요청자 입력 실패: 넣으려던 값 '{name}' / 화면 값 '{shown}'")


def _close_popup_dialog(drv):
    try:
        btn = find(drv, By.XPATH, xp_text(CFG.get("popup_cancel_button", "취소")), 2)
        drv.execute_script("arguments[0].click();", btn)
    except NoSuchElementException:
        pass


def register_batch(drv, batch):
    f = batch["fields"]
    with tempfile.TemporaryDirectory() as td:
        xlsx = Path(td) / batch.get("file_name", f"{batch['batch_id']}.xlsx")
        xlsx.write_bytes(base64.b64decode(batch["file_b64"]))

        before_pr = None if DRY_RUN else list_snapshot(drv, batch["title"])
        main = open_register_form(drv)

        # 안전장치: 팝업의 사이트가 이 청구서의 사이트와 같은지 확인 (다르면 등록하지 않음)
        try:
            erp_site = get_field_value(drv, LABELS.get("사이트", "사이트"))
        except NoSuchElementException:
            erp_site = ""
        if erp_site and batch["site"] not in erp_site:
            close_popup(drv, main)
            raise RuntimeError(f"ERP 화면 사이트가 '{erp_site}'입니다. '{batch['site']}' 청구서라 등록하지 않았습니다. "
                               f"ERP 메인 화면에서 사이트를 '{batch['site']}'(으)로 바꿔 주세요.")

        problems = []

        def put(key, value, required=True):
            label = LABELS.get(key, key)
            if key in ("유무상", "유무상상세") and not is_shown(drv, label):
                log.info("'%s' 칸이 숨겨져 있어 건너뜀 (이 용도는 유/무상 입력 없음)", label)
                return
            if value in (None, ""):
                if required:
                    problems.append(f"{label}: 넣을 값이 없음")
                log.warning("'%s' 값이 비어 있어 건너뜀", label)
                return
            try:
                for attempt in range(3):     # 창이 막 열려 준비 중이면 입력이 안 먹을 수 있어 2번 더 시도
                    try:
                        wait_enabled(drv, label)
                        set_field(drv, label, value)
                        break
                    except Exception as e1:  # noqa: BLE001
                        if attempt == 2:
                            raise
                        log.info("'%s' 입력 재시도 %s회 (%s)", label, attempt + 1, str(e1).splitlines()[0][:80])
                        _close_dropdowns(drv)
                        time.sleep(2)
                log.info("입력 완료: %s = %s", label, value)
            except Exception as e:  # noqa: BLE001
                msg = f"{label}: {str(e).splitlines()[0][:200]}"
                if not DRY_RUN:
                    raise RuntimeError(msg) from e
                problems.append(msg)
                log.warning("입력 실패(테스트 모드라 계속 진행): %s", msg)

        reason = (f.get("기타요청사유")
                  or CFG.get("request_reason_by_type", {}).get(batch["type_code"])
                  or CFG.get("default_request_reason", "고객사 AS간 필요한 파트 구매 요청 건 입니다."))
        site_cfg = CFG.get("sites_config", {}).get(batch["site"], {})

        # 설비구분을 먼저 골라야 나머지 칸이 열림
        put("설비구분", f.get("설비구분"))
        put("용도", f.get("용도"))
        put("명칭", batch["title"])
        put("유무상", f.get("유무상"))
        put("유무상상세", f.get("유무상상세"))
        put("원인부서", f.get("원인부서") or site_cfg.get("원인부서") or CFG.get("default_cause_dept", "CS센터"))
        who = requester_for(batch)
        if who:
            for attempt in range(3):
                try:
                    set_requester(drv, who)
                    log.info("입력 완료: 요청자 = %s", who)
                    break
                except Exception as e:  # noqa: BLE001
                    if attempt == 2:
                        if DRY_RUN:
                            problems.append(f"요청자: {str(e).splitlines()[0][:150]}")
                        else:
                            raise RuntimeError(f"요청자: {str(e).splitlines()[0][:200]}") from e
                    else:
                        log.info("요청자 입력 재시도 %s회", attempt + 1)
                        _close_popup_dialog(drv)
                        time.sleep(2)
        put("사유1", f.get("사유1"))
        put("사유2", f.get("사유2"))
        put("기타요청사유", reason)

        try:
            up_msg = upload_excel(drv, xlsx, batch.get('row_count'))
            log.info("업로드: %s", up_msg or "(메시지 없음)")
        except Exception as e:  # noqa: BLE001
            if not DRY_RUN:
                raise
            problems.append(f"엑셀 업로드: {str(e).splitlines()[0][:200]}")
            log.warning("엑셀 업로드 실패(테스트 모드): %s", e)
            dump_debug(drv, batch["batch_id"] + "_upload")

    if DRY_RUN:
        # 테스트 모드: 팝업을 열어 둔 채로 두어 입력값을 눈으로 확인 (확인 후 '취소'로 닫으세요)
        drv.switch_to.window(main)
        if problems:
            raise RuntimeError("테스트 결과 확인 필요 -> " + " / ".join(problems))
        return "DRY_RUN: 저장 생략(입력/업로드까지 완료, 팝업 창에서 확인)"

    popup = drv.current_window_handle
    batch["_stage"] = "saving"
    REJECT_WORDS = CFG.get("save_reject_words", ["확인하세요", "확인 하세요", "입력하세요", "입력해주세요",
                                                  "선택하세요", "선택해주세요", "필수", "오류", "실패",
                                                  "미사용", "사용불가", "사용 불가", "없는 자재", "존재하지"])
    click_text(drv, BTN["save"])
    # 저장 확인창("저장하시겠습니까?") 수락 -> ERP가 저장 후 등록 팝업을 스스로 닫으면 성공
    msg = ""
    closed = False
    end = time.time() + CFG.get("save_wait_seconds", 30)
    while time.time() < end:
        if popup not in drv.window_handles:
            closed = True
            break
        try:
            drv.switch_to.window(popup)
            a = drv.switch_to.alert
            msg = a.text
            a.accept()
            log.info("저장 확인창: %s", msg)
            if any(w in msg for w in REJECT_WORDS):
                # ERP가 입력값 검사에서 저장을 거부함 -> 등록되지 않음 (팝업은 실패 처리에서 닫음)
                batch["_stage"] = "rejected"
                drv.switch_to.window(main) if main in drv.window_handles else switch_to_erp_tab(drv)
                raise RuntimeError(f"ERP가 저장을 거부함(등록 안 됨): {msg}")
        except NoAlertPresentException:
            time.sleep(0.3)
        except WebDriverException:
            if popup not in drv.window_handles:
                closed = True
                break
            time.sleep(0.3)
    drv.switch_to.window(main) if main in drv.window_handles else switch_to_erp_tab(drv)
    accept_alerts(drv, 2)   # 메인 화면 쪽 완료 알림이 있으면 닫기
    for word in CFG.get("fail_words", ["오류", "실패", "필수", "입력하세요", "선택해주세요"]):
        if word in msg:
            raise RuntimeError(f"저장 실패 메시지: {msg}")
    if not closed:
        # 팝업이 닫히지 않음 = 저장이 끝나지 않았을 수 있음 -> 화면 메시지를 남기고 실패 처리
        detail = ""
        try:
            drv.switch_to.window(popup)
            for mid in ("sMainContent_Label1", "sMainContent_lmsg"):
                els = drv.find_elements(By.ID, mid)
                if els and els[0].text.strip():
                    detail += els[0].text.strip() + " "
        except WebDriverException:
            pass
        dump_debug(drv, batch["batch_id"] + "_save")
        drv.switch_to.window(main) if main in drv.window_handles else switch_to_erp_tab(drv)
        raise RuntimeError(f"저장 후 등록 창이 닫히지 않았습니다. ERP 목록에서 등록 여부를 확인하세요. {detail}{msg}".strip())
    log.info("저장 완료 (등록 창 자동 종료 확인)")
    pr = capture_pr_number(drv, batch["title"], before_pr)
    batch["_pr"] = pr
    if pr:
        log.info("구매요청번호: %s", pr)
        return f"저장 완료 ({pr})"
    log.warning("저장은 됐지만 구매요청번호를 목록에서 찾지 못함 - ERP 목록에서 확인 필요")
    return "저장 완료 (구매요청번호 확인 필요: ERP 목록에서 확인)"


# ---------------------------------------------------------------- ERP 코드 목록 추출 (조건표 확인용, 읽기만 함)
def _read_combo_items(drv, field_id):
    """wijmo 드롭다운: 펼쳐서 목록 글자를 읽고 닫음."""
    el = find(drv, By.ID, field_id, WAIT, allow_hidden=True)
    try:
        trig = el.find_element(By.XPATH, "./ancestor::div[@role='combobox'][1]//div[@role='button']")
        drv.execute_script("arguments[0].click();", trig)
    except WebDriverException:
        drv.execute_script("arguments[0].click();", el)
    time.sleep(0.8)
    items = drv.execute_script(
        "var out=[]; document.querySelectorAll('.wijmo-wijlist').forEach(function(l){"
        " if (l.offsetParent!==null){ l.querySelectorAll('li').forEach(function(li){"
        "  var t=(li.innerText||'').trim(); if(t) out.push(t); }); } }); return out;")
    _close_dropdowns(drv)
    return items


def _fetch_table(drv, url):
    """선택 팝업 페이지(용도조회 등)를 화면에 띄우지 않고 내려받아 표의 줄을 읽음."""
    return drv.execute_script("""
        var x = new XMLHttpRequest(); x.open('GET', arguments[0], false); x.send();
        var doc = new DOMParser().parseFromString(x.responseText, 'text/html');
        var rows = [];
        doc.querySelectorAll('table tr').forEach(function(tr){
            var c = Array.from(tr.querySelectorAll('td')).map(function(td){ return (td.textContent||'').trim(); });
            if (c.length >= 2 && c.join('') !== '') rows.push(c);
        });
        return rows;""", url)


def extract_codes(drv):
    """구매요청서 등록 팝업에서 선택 가능한 값 전부를 CSV로 저장 (저장 버튼은 누르지 않음)."""
    import csv
    rows = []
    main = open_register_form(drv)
    try:
        for label, fid in (("설비구분", FIELD_IDS["설비구분"]), ("사유1", FIELD_IDS["사유1"])):
            for t in _read_combo_items(drv, fid):
                rows.append(("구매", label, "", "", t))
        for t in _fetch_table(drv, "/Setxselect2"):
            rows.append(("구매", "용도", "", t[0], t[1]))
        yumu = _fetch_table(drv, "/Yumuselect")
        for t in yumu:
            rows.append(("구매", "유무상", "", t[0], t[1]))
        for t in yumu:
            for d in _fetch_table(drv, "/Payxselect?val=" + t[1]):
                rows.append(("구매", "유무상상세", t[1], d[0], d[1]))
        # 사유1별 사유2: 사유1을 하나씩 골라 보고 사유2 목록을 읽음
        first_eq = next((r[4] for r in rows if r[1] == "설비구분"), None)
        if first_eq:
            try:
                set_field(drv, LABELS["설비구분"], first_eq)
            except Exception:  # noqa: BLE001
                pass
        for r1 in [r[4] for r in rows if r[1] == "사유1"]:
            try:
                _pick_from_list(drv, LABELS["사유1"], r1)
                time.sleep(1.2)
                for t in _read_combo_items(drv, FIELD_IDS["사유2"]):
                    rows.append(("구매", "사유2", r1, "", t))
            except Exception as e:  # noqa: BLE001
                rows.append(("구매", "사유2", r1, "", f"(읽기 실패: {str(e).splitlines()[0][:60]})"))
    finally:
        # 등록 팝업은 저장하지 않고 닫음
        try:
            click_text(drv, CFG.get("popup_cancel_button", "취소"), 3)
            accept_alerts(drv, 2)
        except Exception:  # noqa: BLE001
            pass
        close_popup(drv, main)
    out = BASE_DIR / f"ERP_코드목록_{datetime.now():%Y%m%d_%H%M}.csv"
    with open(out, "w", encoding="utf-8-sig", newline="") as fp:
        w = csv.writer(fp)
        w.writerow(["화면", "항목", "상위값", "코드", "값(화면 글자)"])
        w.writerows(rows)
    return out, len(rows)


# ================================================================ 긴급 건 결재상신 (구매요청서 등록 목록 -> 그룹웨어 결재창)
APPROVAL_ON = CFG.get("approval_enabled", True)            # 긴급 건 결재상신 사용
APPROVAL_TEST = CFG.get("approval_test_mode", True)        # True: 결재상신 버튼 직전에서 멈춤 (결재창을 열어 둠)
APPROVAL_LINES = {"화성": "[개인] [SCR]화성-구매", "평택": "[개인] 구매", "기흥": "[개인] 구매"}
APPROVAL_LINES.update(CFG.get("approval_lines", {}))
GW_HOST = CFG.get("groupware_host", "ekp.unisem.co.kr")


def _wait_new_window(drv, before, part, timeout=25):
    end = time.time() + timeout
    while time.time() < end:
        accept_alerts(drv, 0.3)
        for h in drv.window_handles:
            if h in before:
                continue
            try:
                drv.switch_to.window(h)
                if part.lower() in drv.current_url.lower():
                    return h
            except WebDriverException:
                continue
        time.sleep(0.5)
    return None


def submit_approval(drv, b):
    """긴급 건: 목록에서 방금 등록한 건 선택 -> 결재상신 -> 결재라인 불러오기 -> 사이트 결재라인 선택 -> 상신."""
    pr = b.get("_pr", "")
    line_name = APPROVAL_LINES.get(b["site"], "")
    if not pr:
        raise RuntimeError("구매요청번호를 확인하지 못해 결재상신하지 않음")
    if not line_name:
        raise RuntimeError(f"{b['site']} 결재라인 이름이 설정에 없음 (approval_lines)")

    # 1) 목록에서 그 건의 줄을 클릭 -> 숨은 칸(RQST_NUMB)에 번호가 들어갔는지 확인
    switch_to_erp_tab(drv)
    go_main_page(drv)
    refresh_list(drv)
    cell_xp = (f"//*[@id='{LIST_GRID_ID}_div' or @id='{LIST_GRID_ID}']"
               f"//td[normalize-space(translate(.,' ',' '))='{pr}']")
    chosen = ""
    for attempt in range(3):
        cell = find(drv, By.XPATH, cell_xp, WAIT)
        drv.execute_script("arguments[0].scrollIntoView({block:'center'});", cell)
        try:
            cell.click()
        except WebDriverException:
            drv.execute_script("arguments[0].click();", cell)
        time.sleep(0.8)
        chosen = (find(drv, By.ID, "sMainContent_RQST_NUMB", 3, allow_hidden=True).get_attribute("value") or "").strip()
        if chosen == pr:
            break
    if chosen != pr:
        raise RuntimeError(f"목록에서 {pr}을 선택하지 못함 (선택된 번호: {chosen or '없음'})")
    log.info("결재상신 대상 선택: %s", pr)

    # 2) '결재상신' -> 그룹웨어 결재창
    erp_win = drv.current_window_handle
    before = set(drv.window_handles)
    btn = find(drv, By.ID, CFG.get("approval_button_id", "sMainContent_LinkButtonS"), WAIT, allow_hidden=True)
    try:
        btn.click()
    except WebDriverException:
        drv.execute_script("arguments[0].click();", btn)
    msg = accept_alerts(drv, 2)
    if msg:
        log.info("결재상신 알림: %s", msg)
    gw = _wait_new_window(drv, before, GW_HOST, 30)
    if not gw:
        raise RuntimeError(f"결재창이 뜨지 않음 - ERP 전용 크롬의 팝업 차단을 확인하세요 {('(' + msg + ')') if msg else ''}".strip())
    time.sleep(2)

    # 3) '결재라인불러오기' -> 결재라인 창
    before = set(drv.window_handles)
    load = find(drv, By.XPATH, xp_text("결재라인불러오기"), 20)
    # 실제 클릭(사람이 누른 것과 같음)이어야 크롬 팝업 차단에 걸리지 않음
    drv.execute_script("arguments[0].scrollIntoView({block:'center'});", load)
    try:
        load.click()
    except WebDriverException:
        drv.execute_script("arguments[0].click();", load)
    lw = _wait_new_window(drv, before, "LineR2", 20)
    if not lw:
        raise RuntimeError("결재라인 창이 뜨지 않음 - ERP 전용 크롬의 팝업 차단을 확인하세요 "
                           "(새 ERP전용크롬.bat 으로 다시 열기)")
    time.sleep(1.5)

    # 4) 결재라인명이 정확히 같은 줄 클릭 -> '결재라인 사용'
    want = _norm_text(line_name)
    find(drv, By.ID, "lineData", 15, allow_hidden=True)          # 결재라인 목록이 있는 프레임으로 이동
    info = drv.execute_script("""
        var want = arguments[0], hits = [];
        document.querySelectorAll('#lineData tr[id^="lineviewTr"]').forEach(function(tr){
            var tds = tr.querySelectorAll('td');
            if (tds.length < 2) return;
            var nm = (tds[1].textContent || '').replace(/[\\s\\u00a0]/g, '');
            if (nm === want) hits.push([tr.id, (tds[0].textContent||'').trim(), (tds[1].textContent||'').trim()]);
        });
        return hits;""", want)
    if len(info) != 1:
        raise RuntimeError(f"결재라인 '{line_name}' 줄이 {len(info)}개라 상신하지 않음")
    row_id, line_no, shown = info[0]
    drv.execute_script("document.getElementById(arguments[0]).click();", row_id)
    log.info("결재라인 선택: %s (%s)", shown, line_no)
    time.sleep(2.0)                                              # 아래쪽 결재자 목록이 새로 불러와질 시간
    drv.switch_to.window(lw)
    use = find(drv, By.XPATH, xp_text("결재라인 사용"), 10)
    drv.execute_script("arguments[0].click();", use)
    msg = accept_alerts(drv, 2)
    end = time.time() + 10
    while time.time() < end and lw in drv.window_handles:
        time.sleep(0.3)
    if lw in drv.window_handles:
        raise RuntimeError(f"결재라인 사용 후 창이 닫히지 않음 {msg}".strip())

    # 5) 결재창에서 결재자가 들어갔는지 확인 후 '결재상신'
    drv.switch_to.window(gw)
    find(drv, By.XPATH, xp_text("결재상신"), 10)
    sign = drv.execute_script("return (document.d_form && document.d_form.SignList) ? document.d_form.SignList.value : '';") or ""
    if not sign.strip():
        raise RuntimeError("결재라인을 적용했지만 결재자가 비어 있음")
    if APPROVAL_TEST:
        log.info("[결재 테스트 모드] 결재상신 버튼 직전에서 멈춤 - 결재창을 확인한 뒤 '창닫기'로 닫으세요")
        drv.switch_to.window(erp_win)
        return "결재상신 직전까지 진행(테스트 모드)"
    up = find(drv, By.XPATH, xp_text("결재상신"), 5)
    drv.execute_script("arguments[0].click();", up)
    msgs = []
    end = time.time() + CFG.get("approval_wait_seconds", 40)
    while time.time() < end:
        if gw not in drv.window_handles:
            break
        try:
            drv.switch_to.window(gw)
            a = drv.switch_to.alert
            t = a.text
            msgs.append(t)
            a.accept()
            log.info("결재 확인창: %s", t)
            if "지정하지 않았거나" in t or "입력하셔야" in t:
                raise RuntimeError(f"결재상신 거부: {t}")
        except NoAlertPresentException:
            time.sleep(0.4)
        except WebDriverException:
            time.sleep(0.4)
    if not any("상신" in m for m in msgs):
        raise RuntimeError("결재상신 확인창이 뜨지 않음 - 그룹웨어에서 상신 여부 확인 필요")
    try:
        drv.switch_to.window(erp_win)
    except WebDriverException:
        switch_to_erp_tab(drv)
    log.info("결재상신 완료: %s (%s)", pr, line_name)
    return "결재상신 완료"


# ================================================================ 자재 출고등록 (출고등록.bat / --out)
OUT_PAGE_URL = CFG.get("out_page_url", "/WARRSERV/WARRSERV")      # 서비스창고관리
OUT_MENU_ID = CFG.get("out_menu_button_id", "btn2")              # 왼쪽 메뉴 '자재 출고등록'
OUT_TAB_URL = CFG.get("out_tab_url", "/WARRSERV/SERV020")
OUT_TAB_TITLE = CFG.get("out_menu_text", "자재 출고등록")
OUT_IDS = {                                                      # 출고 등록 화면(SERV021) 칸 id
    "출고일자": "sMainContent_RQST_DATE",
    "출고창고": "sMainContent_C1ComboBox1",
    "출고명칭": "sMainContent_ASIO_NAME",
    "용도": "sMainContent_C1ComboBox3",
    "유무상": "sMainContent_C1ComboBox4",
    "출고장소": "sMainContent_LINE_CODE",
    "설비종류": "sMainContent_C1ComboBox2",
    "출고사유": "sMainContent_C1ComboBox5",
    "사이트": "sMainContent_SITE_NAME",
}
OUT_IDS.update(CFG.get("out_field_ids", {}))
OUT_LIST_GRID_ID = CFG.get("out_list_grid_id", "ctl00_C1GridView1")
OUT_NO_RE = re.compile(r"\d{4}-\d{4}-\d{4}")


def out_api_get():
    params = {"action": "out_pending", "token": TOKEN, "sites": ",".join(SITES), "pc": PC_NAME}
    r = requests.get(API_URL, params=params, timeout=90)
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"API 오류: {data}")
    return [b for b in data.get("batches", []) if b.get("site") in SITES]


def out_api_post(payload):
    payload = {"token": TOKEN, "pc": PC_NAME, "sites": SITES, **payload}
    r = requests.post(API_URL, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                      headers={"Content-Type": "application/json"}, timeout=60)
    r.raise_for_status()
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"API 오류: {data}")
    return data


def go_out_page(drv):
    go_page(drv, OUT_PAGE_URL, OUT_MENU_ID, OUT_TAB_URL, OUT_TAB_TITLE)


def _out_el(drv, key, timeout=WAIT):
    return find(drv, By.ID, OUT_IDS[key], timeout, allow_hidden=True)


def _out_value(drv, key):
    return (_out_el(drv, key, 3).get_attribute("value") or "").strip()


def _out_combo(drv, key, value):
    """출고 화면 드롭다운(wijmo): 펼쳐서 같은 글자의 항목 클릭 -> 값 확인."""
    el = _out_el(drv, key)
    try:
        trig = el.find_element(By.XPATH, "./ancestor::div[@role='combobox'][1]//div[@role='button']")
        drv.execute_script("arguments[0].click();", trig)
    except WebDriverException:
        drv.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", el)
    time.sleep(0.6)
    t = _norm_text(value)
    same = f"{_NORM.format(x='.')}='{t}'"
    try:
        item = find(drv, By.XPATH, f"//li[ancestor::*[contains(@class,'wijmo-wijlist')]][{same}]", 3)
        try:
            item.click()
        except WebDriverException:
            drv.execute_script("arguments[0].click();", item)
    except NoSuchElementException:
        from selenium.webdriver.common.keys import Keys          # 목록이 안 열리면 입력 후 Enter
        el = _out_el(drv, key)
        el.send_keys(value)
        time.sleep(0.3)
        el.send_keys(Keys.ENTER)
    _close_dropdowns(drv)
    time.sleep(0.4)
    shown = _out_value(drv, key)
    if _norm_text(shown) != t:
        raise RuntimeError(f"'{key}' 입력 실패: 넣으려던 값 '{value}' / 화면 값 '{shown}'")


def _out_text(drv, key, value):
    el = _out_el(drv, key)
    _close_dropdowns(drv)
    if el.get_attribute("readonly") is not None or el.get_attribute("class") and "hasDatepicker" in el.get_attribute("class"):
        drv.execute_script(
            "arguments[0].value = arguments[1];"
            "arguments[0].dispatchEvent(new Event('input', {bubbles:true}));"
            "arguments[0].dispatchEvent(new Event('change', {bubbles:true}));", el, value)
    else:
        _type_text(drv, el, value)
    time.sleep(0.3)
    shown = _out_value(drv, key)
    if shown.replace(" ", "") != value.replace(" ", ""):
        raise RuntimeError(f"'{key}' 입력 실패: 넣으려던 값 '{value}' / 화면 값 '{shown}'")


def _out_location(drv, name, code=""):
    """출고장소: 칸 클릭 -> '출고장소 선택' 창에서 라인명 줄 클릭 -> '선택'. 안 되면 화면 기능으로 직접 지정."""
    el = _out_el(drv, "출고장소")
    drv.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", el)
    time.sleep(1.0)
    picked = False
    try:
        btn = find(drv, By.XPATH, xp_text(POPUP_SELECT_BTN), WAIT)
        time.sleep(0.4)
        t = _norm_text(name)
        same = f"{_NORM.format(x='.')}='{t}'"
        cell = find(drv, By.XPATH, f"({xp_text(POPUP_SELECT_BTN)})/following::td[{same}]", 3)
        try:
            cell.click()
        except WebDriverException:
            drv.execute_script("arguments[0].click();", cell)
        time.sleep(0.3)
        try:
            btn = find(drv, By.XPATH, xp_text(POPUP_SELECT_BTN), 1)
            drv.execute_script("arguments[0].click();", btn)
        except NoSuchElementException:
            pass
        picked = True
    except NoSuchElementException:
        log.info("출고장소 선택 창에서 '%s'를 못 찾음", name)
    time.sleep(0.6)
    shown = _out_value(drv, "출고장소")
    if not shown and code:
        # 선택 창이 안 될 때: 화면의 선택 완료 기능(closeDialog_line)을 직접 실행
        _out_el(drv, "출고장소")
        drv.execute_script("if (typeof closeDialog_line==='function') { closeDialog_line(arguments[0], arguments[1]); }",
                           code, name)
        time.sleep(0.5)
        shown = _out_value(drv, "출고장소")
    if not shown:
        raise RuntimeError(f"출고장소 '{name}' 지정 실패 (선택 창 {'처리됨' if picked else '못 찾음'})")
    return shown


def _read_out_numbers(drv, title):
    grid = find(drv, By.ID, OUT_LIST_GRID_ID, 5, allow_hidden=True)
    rows = drv.execute_script("""
        var g = arguments[0];
        var w = document.getElementById(g.id + '_div') || g;
        var out = [];
        w.querySelectorAll('tr').forEach(function(tr){
            var c = Array.from(tr.querySelectorAll('td')).map(function(td){
                return (td.innerText || td.textContent || '').trim(); });
            var i = c.findIndex(function(x){ return /^\\d{4}-\\d{4}-\\d{4}$/.test(x); });
            if (i >= 0) out.push([c[i], c[i+1] || '']);   // 출고번호 바로 다음 칸이 출고명칭
        });
        return out;""", grid)
    want = _norm_text(title)
    return [n for n, t in rows if OUT_NO_RE.fullmatch(n) and _norm_text(t) == want]


def _out_refresh_list(drv, from_date):
    btn = find(drv, By.ID, LIST_SEARCH_ID, WAIT, allow_hidden=True)     # 출고 목록도 '조회' = sMainContent_LinkSer
    drv.execute_script("var e=document.getElementById(arguments[0]); if(e){e.value=arguments[1];}",
                       LIST_FROM_ID, from_date)
    try:
        old = drv.find_element(By.ID, OUT_LIST_GRID_ID)
    except WebDriverException:
        old = None
    drv.execute_script("arguments[0].click();", btn)
    accept_alerts(drv, 1)
    if old is not None:
        try:
            WebDriverWait(drv, 15).until(EC.staleness_of(old))
        except TimeoutException:
            pass
    time.sleep(1.0)


def register_out_batch(drv, b):
    f = b.get("fields", {})
    from_date = min(b["date"], datetime.now().strftime("%Y-%m-%d"))
    with tempfile.TemporaryDirectory() as td:
        xlsx = Path(td) / b.get("file_name", f"{b['batch_id']}.xlsx")
        xlsx.write_bytes(base64.b64decode(b["file_b64"]))

        go_out_page(drv)
        before = None
        try:
            _out_refresh_list(drv, from_date)
            before = set(_read_out_numbers(drv, b["title"]))
        except Exception as e:  # noqa: BLE001
            log.warning("등록 전 출고 목록 확인 실패(계속 진행): %s", str(e).splitlines()[0][:120])

        # '등록' -> 탭 안에 출고 등록 화면(asmMainF)이 열림
        click_text(drv, BTN["register"])
        _out_el(drv, "출고명칭", 20)
        time.sleep(1.5)                       # 드롭다운들이 준비될 시간

        site_shown = ""
        try:
            site_shown = _out_value(drv, "사이트")
        except NoSuchElementException:
            pass
        if site_shown and b["site"] not in site_shown:
            raise RuntimeError(f"ERP 출고 화면 사이트가 '{site_shown}'입니다. '{b['site']}' 출고라 등록하지 않았습니다.")

        def put(key, fn, *args):
            for attempt in range(3):
                try:
                    fn(drv, key, *args) if fn is not _out_location else fn(drv, *args)
                    log.info("입력 완료: %s = %s", key, args[0])
                    return
                except Exception as e:  # noqa: BLE001
                    if attempt == 2:
                        raise RuntimeError(f"{key}: {str(e).splitlines()[0][:200]}") from e
                    log.info("'%s' 입력 재시도 %s회 (%s)", key, attempt + 1, str(e).splitlines()[0][:80])
                    _close_dropdowns(drv)
                    time.sleep(2)

        put("출고일자", _out_text, b["date"])
        put("출고창고", _out_combo, f.get("출고창고", "사이트창고"))
        put("출고명칭", _out_text, b["title"])
        put("용도", _out_combo, f.get("용도", "A/S자재"))
        put("유무상", _out_combo, b["paid"])            # 엑셀 업로드 전에 먼저 골라야 함
        put("출고장소", _out_location, b["location"], b.get("location_code", ""))
        put("설비종류", _out_combo, f.get("설비종류", "SCRUBBER"))
        put("출고사유", _out_combo, f.get("출고사유", "A/S"))

        up = upload_excel(drv, xlsx, b.get("row_count"), button_text=CFG.get("out_upload_button", "액셀Upload"), kind="출고")
        log.info("업로드: %s", up)

    if DRY_RUN:
        return "DRY_RUN: 저장 생략(입력/업로드까지 완료, 화면에서 확인 후 '취소')"

    b["_stage"] = "saving"
    reject = CFG.get("save_reject_words", ["확인하세요", "입력해주세요", "입력하지 않았습니다", "선택해주세요",
                                           "필수", "오류", "실패", "미사용", "사용불가", "재고"])
    save = find(drv, By.ID, CFG.get("out_save_button_id", "sMainContent_LinkSerch"), WAIT, allow_hidden=True)
    drv.execute_script("arguments[0].click();", save)
    msg, done = "", False
    end = time.time() + CFG.get("save_wait_seconds", 30)
    while time.time() < end:
        try:
            a = drv.switch_to.alert
            msg = a.text
            a.accept()
            log.info("저장 확인창: %s", msg)
            if any(w in msg for w in reject):
                b["_stage"] = "rejected"
                try:
                    find(drv, By.ID, "sMainContent_LinkButton1", 3, allow_hidden=True)   # '취소'로 등록 화면 닫기
                    drv.execute_script("closeFrame('N');")
                except Exception:  # noqa: BLE001
                    pass
                raise RuntimeError(f"ERP가 저장을 거부함(등록 안 됨): {msg}")
            continue
        except NoAlertPresentException:
            pass
        except WebDriverException:
            pass
        # 저장되면 ERP가 등록 화면(asmMainF)을 숨기고 목록을 다시 조회함
        try:
            drv.switch_to.default_content()
            fr = find(drv, By.ID, "asmMainF", 2, allow_hidden=True)
            if not fr.is_displayed():
                done = True
                break
        except (NoSuchElementException, WebDriverException):
            pass
        time.sleep(0.5)
    if not done:
        dump_debug(drv, b["batch_id"] + "_save")
        raise RuntimeError(f"저장 후 출고 등록 화면이 닫히지 않았습니다. ERP 출고 목록에서 확인하세요. {msg}".strip())
    log.info("저장 완료 (출고 등록 화면 닫힘)")

    number = ""
    for attempt in range(4):
        try:
            time.sleep(1.5)
            _out_refresh_list(drv, from_date)
            new = [n for n in _read_out_numbers(drv, b["title"]) if before is None or n not in before]
            if new:
                number = max(new)
                break
        except Exception as e:  # noqa: BLE001
            log.warning("출고번호 확인 %s회차 실패: %s", attempt + 1, str(e).splitlines()[0][:120])
    b["_no"] = number
    if number:
        log.info("출고번호: %s", number)
        return f"저장 완료 ({number})"
    log.warning("저장은 됐지만 출고번호를 목록에서 찾지 못함")
    return "저장 완료 (출고번호 확인 필요: ERP 출고 목록에서 확인)"


def process_out(drv, b):
    tag = f"{b['batch_id']} {b['site']} {b['date']} {b['line']} {b['paid']}"
    log.info("출고 처리 시작: %s (%s품목) %s", tag, b.get("row_count"), b["title"])
    try:
        msg = register_out_batch(drv, b)
        status = "실패" if DRY_RUN else "완료"
        out_api_post({"action": "out_result", "batch_id": b["batch_id"], "status": status,
                      "out_number": b.get("_no", ""), "message": msg})
        log.info("출고 처리 결과: %s -> %s (%s)", tag, status, msg)
        return True
    except Exception as e:  # noqa: BLE001
        reason = f"{str(e).splitlines()[0][:300] if str(e) else type(e).__name__}"
        if b.get("_stage") == "saving":
            reason = "[저장 버튼 이후 실패 - ERP 출고 목록 확인 후 재등록] " + reason
        log.error("출고 처리 실패: %s -> %s", tag, reason)
        try:
            out_api_post({"action": "out_result", "batch_id": b["batch_id"], "status": "실패",
                          "out_number": "", "message": reason})
        except Exception as e2:  # noqa: BLE001
            log.error("결과 전송 실패: %s", e2)
        try:
            accept_alerts(drv, 1)
            dump_debug(drv, b["batch_id"])
            drv.switch_to.default_content()
            find(drv, By.ID, "asmMainF", 2, allow_hidden=True)
            drv.execute_script("var f=document.getElementById('asmMainF'); if(f){f.style.display='none';}")
        except Exception:  # noqa: BLE001
            pass
        return False


def run_out():
    """출고등록.bat: 이 사이트 출고 시트에서 등록할 출고를 보여 주고, Enter를 누르면 차례로 등록."""
    print(f"ERP 자동등록 프로그램 버전: {VERSION}  [출고 등록 / 사이트: {', '.join(SITES)}]")
    try:
        drv = connect_chrome()
    except WebDriverException:
        print("\n[안내] ERP 전용 크롬에 연결하지 못했습니다. ERP전용크롬.bat 으로 크롬을 열고 로그인해 주세요.")
        return
    if not (switch_to_erp_tab(drv) and is_logged_in(drv)):
        input("ERP 전용 크롬에서 ERP에 로그인한 뒤 Enter >> ")
        if not (switch_to_erp_tab(drv) and is_logged_in(drv)):
            print("ERP 로그인 상태를 확인할 수 없어 종료합니다.")
            return
    batches = out_api_get()
    if not batches:
        print("등록할 출고가 없습니다.")
        return
    print("\n등록할 출고:")
    for b in batches:
        print(f"  {b['date']} {b['line']:<6} {b['paid']}  {b.get('row_count')}품목  -> {b['title']}")
    if DRY_RUN:
        print("\n[테스트 모드] 저장 직전까지만 진행합니다. 한 건씩 확인 후 ERP 화면에서 '취소'를 눌러 주세요.")
    ans = input(f"\n출고 {len(batches)}건을 등록합니다. 진행하려면 Enter, 그만두려면 n 입력 >> ").strip().lower()
    if ans == "n":
        print("취소했습니다.")
        return
    res = out_api_post({"action": "out_start", "batch_ids": [b["batch_id"] for b in batches]})
    accepted = set(res.get("accepted", []))
    todo = [b for b in batches if b["batch_id"] in accepted]
    if len(todo) < len(batches):
        print(f"다른 곳에서 이미 처리 중이거나 바뀐 {len(batches) - len(todo)}건은 건너뜁니다.")
    ok = sum(1 for b in todo if process_out(drv, b))
    print(f"\n출고 {len(todo)}건 중 성공 {ok}건, 실패 {len(todo) - ok}건")
    if ok < len(todo):
        print("실패 내용은 출고 시트 출고번호 칸과 debug 폴더에 남았습니다.")


# ---------------------------------------------------------------- 1회 실행 (자리에서 일반+긴급 등록)
def process(drv, b):
    tag = f"{b['batch_id']} {b['site']} {b['type_code']}{' [긴급]' if b.get('urgent') else ''}"
    log.info("처리 시작: %s (%s건) %s", tag, b.get("row_count"), b["title"])
    try:
        msg = register_batch(drv, b)
        status = "실패" if DRY_RUN else "완료"   # DRY_RUN은 시트를 '실패'로 남겨 재처리 가능하게
        if b.get("urgent") and APPROVAL_ON and not DRY_RUN:
            # 긴급 건: 결재상신까지. 실패해도 등록은 완료로 두고 메시지에 남김 (다시 등록하면 중복)
            try:
                msg += " / " + submit_approval(drv, b)
            except Exception as ea:  # noqa: BLE001
                reason_a = str(ea).splitlines()[0][:200] if str(ea) else type(ea).__name__
                log.error("결재상신 실패: %s -> %s", b["batch_id"], reason_a)
                msg += f" / 결재상신 필요: {reason_a}"
                try:
                    dump_debug(drv, b["batch_id"] + "_결재")
                    for h in list(drv.window_handles):        # 남은 결재 창 닫기
                        drv.switch_to.window(h)
                        if GW_HOST in drv.current_url and not APPROVAL_TEST:
                            drv.close()
                    switch_to_erp_tab(drv)
                except Exception:  # noqa: BLE001
                    switch_to_erp_tab(drv)
        api_post({"action": "result", "batch_id": b["batch_id"], "status": status,
                  "erp_title": b["title"], "erp_number": b.get("_pr", ""), "message": msg})
        log.info("처리 결과: %s -> %s (%s)", tag, status, msg)
        return True
    except Exception as e:  # noqa: BLE001
        reason = f"{type(e).__name__}: {str(e).splitlines()[0][:300] if str(e) else ''}"
        if b.get("_stage") == "saving":
            reason = "[저장 버튼 이후 실패 - ERP에 등록됐을 수 있으니 목록 확인 후 재등록] " + reason
        log.error("처리 실패: %s -> %s", tag, reason)
        # 결과 전송을 가장 먼저 (뒤 정리 작업에서 오류가 나도 시트가 '등록중'에 멈추지 않게)
        api_post({"action": "result", "batch_id": b["batch_id"], "status": "실패",
                  "erp_title": b["title"], "message": reason})
        try:
            log.debug("상세", exc_info=True)
            try:
                if drv.current_window_handle not in drv.window_handles:
                    switch_to_erp_tab(drv)
            except WebDriverException:
                switch_to_erp_tab(drv)
            accept_alerts(drv, 1)
            dump_debug(drv, b["batch_id"])
            close_stale_popups(drv)      # 다음 건을 위해 남은 등록 창 닫기
        except Exception as e2:  # noqa: BLE001
            log.warning("실패 후 정리 중 오류(무시): %s", str(e2).splitlines()[0][:200] if str(e2) else e2)
        return False


def run_once():
    """관리자가 자리에서 실행: 대기 중인 일반+긴급 청구서를 모두 등록하고 종료."""
    print(f"ERP 자동등록 프로그램 버전: {VERSION}")
    try:
        drv = connect_chrome()
    except WebDriverException:
        print("\n[안내] ERP 전용 크롬에 연결하지 못했습니다.")
        print("  1) ERP전용크롬.bat 을 먼저 실행해서 ERP에 로그인해 주세요.")
        print("  2) 평소 쓰는 크롬이 아니라 ERP전용크롬.bat 으로 연 창이어야 합니다.")
        print("  3) 그래도 안 되면 그 크롬에서 http://127.0.0.1:9222/json/version 이 열리는지 확인해 주세요.")
        log.warning("전용 크롬 연결 실패 (포트 %s)", DEBUG_PORT)
        return
    if not (switch_to_erp_tab(drv) and is_logged_in(drv)):
        input("ERP 전용 크롬에서 ERP에 로그인한 뒤 Enter >> ")
        if not (switch_to_erp_tab(drv) and is_logged_in(drv)):
            print("ERP 로그인 상태를 확인할 수 없어 종료합니다.")
            return
    # 서버가 한 번에 몇 건씩만 넘겨줄 수 있으므로, 더 없을 때까지 반복해서 받음
    batches, seen = [], set()
    for _ in range(CFG.get("max_fetch_rounds", 20)):
        got = [b for b in api_get_pending("all") if b["batch_id"] not in seen]
        if not got:
            break
        for b in got:
            seen.add(b["batch_id"])
            batches.append(b)
            process(drv, b) and b.setdefault("_ok", True)
    if not batches:
        print("등록할 청구서가 없습니다.")
    ok = sum(1 for b in batches if b.get("_ok"))
    if batches:
        print(f"\n청구서 {len(batches)}건 중 성공 {ok}건, 실패 {len(batches) - ok}건")
        if ok < len(batches):
            print("실패 원인 자료가 debug 폴더에 저장되었습니다. 폴더를 압축해서 보내주세요.")


# ---------------------------------------------------------------- 부재 중 대기 모드 (부재 시 긴급 건만)
def main():
    log.info("버전: %s", VERSION)
    log.info("ERP 자동등록 시작 [%s / 사이트: %s] (DRY_RUN=%s, poll=%ss)", PC_NAME, ",".join(SITES) or "전체", DRY_RUN, POLL_SEC)
    drv = None
    last_hb = last_keep = 0.0
    login_state = "정상"

    while True:
        try:
            if drv is None:
                drv = connect_chrome()
                log.info("ERP 전용 크롬에 접속")

            now = time.time()
            ok_tab = switch_to_erp_tab(drv)
            state = "정상" if ok_tab and is_logged_in(drv) else "로그인필요"

            if now - last_hb >= HEARTBEAT_SEC or state != login_state:
                api_post({"action": "heartbeat", "state": state,
                          "message": "" if ok_tab else "ERP 탭이 열려 있지 않음"})
                last_hb, login_state = now, state

            if state != "정상":
                time.sleep(POLL_SEC)
                continue

            # 세션 유지: 주기적으로 현재 화면 새로고침
            if now - last_keep >= KEEPALIVE_SEC:
                drv.refresh()
                accept_alerts(drv, 1)
                last_keep = now

            batches = api_get_pending("urgent")
            for b in batches:
                process(drv, b)

            time.sleep(1 if batches else POLL_SEC)

        except WebDriverException as e:
            log.warning("크롬 연결 문제(전용 크롬이 닫혔을 수 있음): %s", str(e).splitlines()[0])
            drv = None
            api_post({"action": "heartbeat", "state": "로그인필요", "message": "ERP 전용 크롬 연결 끊김"})
            time.sleep(POLL_SEC)
        except requests.RequestException as e:
            log.warning("API 통신 실패: %s", e)
            time.sleep(POLL_SEC)
        except KeyboardInterrupt:
            log.info("종료")
            break


if __name__ == "__main__":
    try:
        if "--codes" in sys.argv:
            drv0 = connect_chrome()
            if not (switch_to_erp_tab(drv0) and is_logged_in(drv0)):
                print("ERP 전용 크롬에서 ERP에 로그인한 뒤 다시 실행하세요.")
            else:
                f, n = extract_codes(drv0)
                print(f"ERP 코드 {n}건 저장: {f}")
        elif "--dump" in sys.argv:
            # 화면 구조 저장: 전용 크롬에 열린 ERP 창(메인·팝업·선택창)을 debug 폴더에 저장
            d = dump_debug(connect_chrome(), "화면저장")
            print(f"저장 완료: {d}")
        elif "--out" in sys.argv:
            run_out()       # 출고등록.bat: 출고 시트의 출고를 ERP 자재 출고등록으로 등록
        elif "--watch" in sys.argv:
            main()          # 부재 시: 긴급 건만 1분마다 확인
        else:
            run_once()      # 기본(더블클릭): 자리에서 대기 중인 청구서 전부 등록 후 종료
    except Exception:  # noqa: BLE001
        log.exception("예상하지 못한 오류")
        print("\n[오류] 위 내용을 캡처하거나 erp_auto.log 를 보내주세요.")
    finally:
        try:
            input("\nEnter를 누르면 창이 닫힙니다 >> ")
        except EOFError:
            pass
