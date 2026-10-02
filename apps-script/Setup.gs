/**
 * Setup.gs
 * Apps Script 편집기에서 setupSpreadsheet() 함수를 한 번 실행하면
 * 필요한 시트와 헤더를 자동으로 생성합니다.
 * (스크립트 편집기 상단 함수 선택 드롭다운에서 setupSpreadsheet 선택 후 ▶ 실행)
 *
 * 없는 시트는 새로 만들고, 이미 있는 시트는 헤더가 다를 때만 다시 확인합니다:
 * 데이터가 없으면(2행 이후가 비어있으면) 헤더를 새 구조로 교체하고, 데이터가 있으면
 * 절대 건드리지 않습니다. 여러 번 실행해도 안전합니다.
 *
 * 사이트(기흥/화성/평택)별로 구매발주및입고/출고/재고/사용자재/반납 시트가 각각 분리되어 생성됩니다.
 * SITES 상수는 Code.gs에 정의되어 있습니다 (Apps Script는 모든 .gs 파일을
 * 하나의 전역 스코프로 병합하므로 여기서 다시 선언하지 않습니다).
 */

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  createSheetIfMissing_(ss, 'Items', [
    'ItemID', 'ItemName', 'Spec', 'Unit', 'Category', 'CreatedAt', '신규여부'
  ], [6]); // CreatedAt

  createSheetIfMissing_(ss, 'Users', [
    'PIN', 'Name', 'Role'
  ], []);

  SITES.forEach(site => {
    createSheetIfMissing_(ss, site + '_구매발주및입고', [
      '구매요청번호', '요청일자', '신청자', '라인', 'BQMS', '자재코드',
      '자재명', '규격', '필요일자', '요청수량', '현재고수량', '재고사용(O,X)',
      '누적입고수량', '잔여수량', '입고여부', '최종입고일', '라인구매번호',
      '누적출고수량', '출고여부', '최종출고일', '비고', '특이사항1', '특이사항2'
    ], [2, 9, 16, 20]); // 요청일자, 필요일자, 최종입고일, 최종출고일

    createSheetIfMissing_(ss, site + '_출고', [
      '출고일자', '라인', '자재코드', '자재명', '규격', '단위',
      '출고수량', '담당자', '거래코드', '시간', 'S/N관리여부', 'BQMS', 'S/N', '수량', '라인', '층',
      '라인구매번호'
    ], [1]); // 출고일자

    // 현재고: 입출고/반납/이관 이벤트마다 직접 증감되는 실제 재고(유일한 기준값).
    // 월초재고: 재고 대사(검증)용 기준값으로만 쓰는 수동 관리 열 — 자동으로 덮어쓰지 않는다.
    // 매월 1일에는 오른쪽 끝에 "YY-MM-DD 재고"(생성일) 스냅샷 열이 자동으로 추가된다(기록/참고용).
    const stockSheet = createSheetIfMissing_(ss, site + '_재고', [
      '자재코드', '자재명', '규격', '월초재고', '현재고', '최종업데이트'
    ], [6]); // 최종업데이트
    if (stockSheet) formatStockSheetNumberColumns_(stockSheet);

    createSheetIfMissing_(ss, site + '_사용자재', [
      '자재코드', 'BQMS', '품명', '규격', '사용설비', '비고', '한글검색'
    ], []);

    createSheetIfMissing_(ss, site + '_반납', [
      '반납일자', '자재코드', '자재명', '규격', '반납수량', '담당자', '비고'
    ], [1]); // 반납일자

    // 세트(묶음) 자재 구성표: 구매요청 화면에서 "*** 세트명"을 선택하면 이 시트에서
    // 세트명이 일치하는 행들을 찾아 구매발주및입고 시트에 구성 자재별로 나눠 등록한다.
    createSheetIfMissing_(ss, site + '_묶음자재', [
      '세트명', '자재코드', 'BQMS', '품명', '규격', '수량'
    ], []);
  });

  // 사이트간 자재 이관(대여/반납) 원장. 사이트별로 분리하지 않고 한 시트에서 관리한다.
  //  - 이관번호 형식: TR26-0901-0001 (TR + 연도 끝 두자리 + '-' + 월일 4자리 + '-' + 당일 순번 4자리)
  //  - 상태값: 요청 / 승인 / 거절 / 반납
  //  - 재고 증감은 Code.gs의 approveTransfer_/returnTransfer_가 공급/요청 사이트 재고 시트에 직접 반영한다.
  createSheetIfMissing_(ss, TRANSFER_SHEET_NAME, [
    '이관번호', '요청일', '요청사이트', '공급사이트',
    '자재코드', '자재명', '규격', '단위', '출고수량',
    '반납예정일', '상태', '승인일', '반납일'
  ], [2, 10, 12, 13]); // 요청일, 반납예정일, 승인일, 반납일

  // 화성_묶음자재 기본 데이터 자동 입력 (세트 오링 TRITON(V1)/(V2), 시트가 비어있을 때만)
  seedHwaseongBundledMaterials_(ss);

  // 화성_사용자재 시트에 세트 항목(*** 세트 오링 TRITON(V1)/(V2)) 자동 등록 (이미 있으면 건너뜀)
  seedHwaseongSetUsedMaterials_(ss);

  // 평택_사용자재 시트에 세트 항목(*** TRITON PRE-WET BODY 부분MODULE) 자동 등록 (이미 있으면 건너뜀).
  // 평택_묶음자재 구성표 데이터는 스프레드시트에 직접 업로드해 관리한다.
  seedPyeongtaekSetUsedMaterials_(ss);

  // 매월 1일 00시에 현재고를 "YY-MM-DD 재고"(생성일) 열로 기록하는 스냅샷 트리거 (이전 롤오버 트리거는 제거됨)
  setupMonthlySnapshotTrigger();

  // 샘플 로그인 PIN (Users 시트가 비어있을 때만 채워 넣음)
  const userSheet = ss.getSheetByName('Users');
  if (userSheet.getLastRow() < 2) {
    userSheet.getRange(2, 1, 2, 3).setValues([
      ['1234', '관리자', '관리자'],
      ['0000', '홍길동', '작업자']
    ]);
  }

  // 기본 시트(Sheet1) 정리 (다른 시트가 이미 준비된 경우에만)
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  SpreadsheetApp.flush();
  Logger.log('설정 완료: Items, Users, 사이트별(기흥/화성/평택) 구매발주및입고·출고·재고·사용자재·반납·묶음자재 시트 + 사이트이관 시트가 준비되었습니다. (데이터가 있는 기존 시트는 변경하지 않았습니다)');
}

// 화성_묶음자재 시트에 "세트 오링 TRITON(V1)"/"(V2)" 구성표를 채워 넣는다.
// 시트에 이미 데이터가 있으면(2행 이후가 비어있지 않으면) 아무 것도 하지 않는다(중복 입력 방지).
function seedHwaseongBundledMaterials_(ss) {
  const sheet = ss.getSheetByName('화성_묶음자재');
  if (!sheet || sheet.getLastRow() >= 2) return;

  const rows = [
    // *** 세트 오링 TRITON(V1)
    ['*** 세트 오링 TRITON(V1)', '7234-100-050', 'K7002007-000686', 'VITON O-RING', 'VITON, NW50.!', 2],
    ['*** 세트 오링 TRITON(V1)', '7234-101-130', 'K7002007-000617', 'TRITON(Ver1) PRE WET SIDE PM#1 COVER O-RING', 'VITON, 153.5x227, Φ5', 1],
    ['*** 세트 오링 TRITON(V1)', '7234-101-140', 'K7002007-000618', 'TRITON(Ver1) PRE WET SIDE PM#2 COVER O-RING', 'VITON, 104.5x227, Φ5', 1],
    ['*** 세트 오링 TRITON(V1)', '7234-100-070', 'K7002007-000685', 'VITON O-RING', 'VITON, NW80.!', 3],
    ['*** 세트 오링 TRITON(V1)', '7237-101-590', 'K7002007-000664', 'O-RING', 'VITON, G200.!', 2],
    ['*** 세트 오링 TRITON(V1)', '7237-101-610', 'K7002007-000677', 'O-RING', 'VITON, G220.!', 2],
    ['*** 세트 오링 TRITON(V1)', '7237-101-460', 'K7002007-000671', 'O-RING', 'VITON, G135.!', 1],
    ['*** 세트 오링 TRITON(V1)', '7234-100-080', 'K7002007-000684', 'VITON O-RING', 'VITON, NW100.!', 7],
    ['*** 세트 오링 TRITON(V1)', '7234-100-090', 'K7002007-000683', 'VITON O-RING', 'VITON, NW160.!', 2],
    ['*** 세트 오링 TRITON(V1)', '7234-101-230', 'K7002007-000627', '투시창 COVER O-RING', 'VITON, 325.5x135.5, Φ5', 1],
    // *** 세트 오링 TRITON(V2)
    ['*** 세트 오링 TRITON(V2)', '7234-101-160', 'K7002007-000620', 'TRITON PRE WET FRONT NOZZLE COVER O-RING', 'VITON, 263x157, Φ5', 2],
    ['*** 세트 오링 TRITON(V2)', '7234-101-170', 'K7002007-000621', 'TRITON PRE WET SIDE PM COVER O-RING', 'VITON, 209x227, Φ5', 1],
    ['*** 세트 오링 TRITON(V2)', '7234-100-070', 'K7002007-000685', 'VITON O-RING', 'VITON, NW80.!', 3],
    ['*** 세트 오링 TRITON(V2)', '7237-101-590', 'K7002007-000664', 'O-RING', 'VITON, G200.!', 2],
    ['*** 세트 오링 TRITON(V2)', '7237-101-610', 'K7002007-000677', 'O-RING', 'VITON, G220.!', 2],
    ['*** 세트 오링 TRITON(V2)', '7237-101-460', 'K7002007-000671', 'O-RING', 'VITON, G135.!', 1],
    ['*** 세트 오링 TRITON(V2)', '7234-100-080', 'K7002007-000684', 'VITON O-RING', 'VITON, NW100.!', 7],
    ['*** 세트 오링 TRITON(V2)', '7234-100-090', 'K7002007-000683', 'VITON O-RING', 'VITON, NW160.!', 2],
    ['*** 세트 오링 TRITON(V2)', '7234-101-230', 'K7002007-000627', '투시창 COVER O-RING', 'VITON, 325.5x135.5, Φ5', 1]
  ];

  sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  Logger.log('화성_묶음자재: 세트 오링 TRITON(V1)/(V2) 구성 ' + rows.length + '건 입력 완료');
}

// 화성_사용자재 시트에 세트(*** 세트 오링 TRITON(V1)/(V2)) 항목을 등록해, 구매요청 화면의
// 자재 검색에서 세트를 선택할 수 있게 한다. 이미 같은 품명이 등록돼 있으면 다시 넣지 않는다.
function seedHwaseongSetUsedMaterials_(ss) {
  const sheet = ss.getSheetByName('화성_사용자재');
  if (!sheet) return;

  const setNames = ['*** 세트 오링 TRITON(V1)', '*** 세트 오링 TRITON(V2)'];
  const existingNames = readAll_(sheet).map(r => String(r['품명'] || '').trim());

  setNames.forEach(name => {
    if (existingNames.indexOf(name) !== -1) return;
    sheet.appendRow(['', '', name, 'SET', '화성 공용', '세트구성', '']);
  });
}

// 평택_사용자재 시트에 세트(*** TRITON DUAL/SINGLE PRE-WET BODY 부분MODULE) 항목을 등록해,
// 구매요청 화면의 자재 검색에서 세트를 선택할 수 있게 한다. 세트를 선택해 구매요청하면
// Code.gs의 submitPurchase_가 평택_묶음자재 시트에서 같은 세트명의 구성 자재를 찾아
// 하위 품목별로 나눠 구매발주및입고 시트에 자동 등록한다. 이미 같은 품명이 등록돼 있으면 건너뛴다.
function seedPyeongtaekSetUsedMaterials_(ss) {
  const sheet = ss.getSheetByName('평택_사용자재');
  if (!sheet) return;

  const setNames = [
    '*** TRITON DUAL PRE-WET BODY 부분MODULE#A',
    '*** TRITON DUAL PRE-WET BODY 부분MODULE#B',
    '*** TRITON SINGLE PRE-WET BODY 부분MODULE'
  ];
  const existingNames = readAll_(sheet).map(r => String(r['품명'] || '').trim());

  setNames.forEach(name => {
    if (existingNames.indexOf(name) !== -1) return;
    sheet.appendRow(['', '', name, 'SET', '평택 공용', '세트구성', '']);
  });
}

/**
 * 시트가 없으면 새로 만들고, 있으면 다음 규칙으로 처리한다:
 *  - 헤더가 이미 요청한 구조와 같으면 아무 것도 하지 않는다.
 *  - 헤더가 다르지만 데이터가 없으면(2행 이후가 비어있으면) 헤더만 새 구조로 교체한다.
 *  - 헤더가 다르고 데이터도 있으면 절대 건드리지 않고 경고만 로그로 남긴다.
 * 새로 만들거나 헤더를 교체할 때는 첫 행 고정 + 헤더 볼드/배경(#f1f3f4) 서식을 적용하고,
 * dateCols로 지정한 1-based 열에는 'yyyy-MM-dd' 날짜 서식을 적용한다.
 */
function createSheetIfMissing_(ss, name, headers, dateCols) {
  let sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
    writeSheetHeader_(sheet, headers, dateCols);
    return sheet;
  }

  const lastCol = sheet.getLastColumn();
  const currentHeader = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  if (arraysEqual_(currentHeader, headers)) return null; // 이미 최신 구조라 손댈 필요 없음

  if (sheet.getLastRow() <= 1) {
    // 헤더 행(또는 완전히 빈 시트)만 있고 실제 데이터는 없으므로 헤더를 새 구조로 교체해도 안전하다.
    sheet.clear();
    writeSheetHeader_(sheet, headers, dateCols);
    Logger.log('"' + name + '" 시트: 데이터가 없어 헤더를 새 구조로 교체했습니다.');
    return sheet;
  }

  Logger.log('경고: "' + name + '" 시트에 데이터가 있어 헤더가 달라도 그대로 두었습니다. 필요하면 수동으로 마이그레이션하세요.');
  return null;
}

function writeSheetHeader_(sheet, headers, dateCols) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f3f4');

  if (dateCols && dateCols.length) {
    const maxRows = sheet.getMaxRows();
    if (maxRows > 1) {
      dateCols.forEach(col => {
        sheet.getRange(2, col, maxRows - 1, 1).setNumberFormat('yyyy-MM-dd');
      });
    }
  }
}

function arraysEqual_(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// 재고 시트의 월초재고(4열, 대사 기준값)/현재고(5열) 컬럼을 숫자 서식으로 지정한다 (새로 만들어진 시트에만 호출됨).
function formatStockSheetNumberColumns_(sheet) {
  const maxRows = sheet.getMaxRows();
  if (maxRows < 2) return;
  sheet.getRange(2, 4, maxRows - 1, 1).setNumberFormat('#,##0'); // 월초재고
  sheet.getRange(2, 5, maxRows - 1, 1).setNumberFormat('#,##0'); // 현재고
}

// ------------------------- 월초 재고 스냅샷 -------------------------
// 현재고는 입고/출고/반납/이관 이벤트마다 직접 증감되는 "누적 실제값"이다(Code.gs setStockQuantity_ 참고).
// 매월 1일에는 그 시점 현재고를 각 사이트 _재고 시트 오른쪽 끝에 "YY-MM-DD 재고" 열로 새로 기록한다
// (날짜는 실제 생성일 — 자동 트리거면 보통 1일, 메뉴로 늦게 만들면 그 날짜). 한 달에 한 열만 만든다.
// 이 스냅샷은 순수 기록/참고용이라 재고 계산에 관여하지 않으며, 실패해도 현재고에는 영향이 없다.

// 트리거/keepAlive 안전망이 스냅샷을 자동으로 만들기 시작하는 달. 그 이전 달(2026-10)은 현재고를
// 버전 기록으로 복원한 뒤 "자재관리 > 이번 달 재고 스냅샷 생성" 메뉴로 수동 생성한다.
const SNAPSHOT_AUTO_START_MONTH = '2026-11';
const NOTIFY_LOG_SHEET_NAME = '알림로그';
const STOCK_RECONCILE_SHEET_NAME = '재고대사';
// 스크립트 속성 키: 스냅샷이 완료된 마지막 달 / 안전망의 마지막 시도 시각(ms).
const SNAPSHOT_DONE_PROP = 'STOCK_SNAPSHOT_DONE_MONTH';
const SNAPSHOT_ATTEMPT_PROP = 'STOCK_SNAPSHOT_LAST_ATTEMPT';
// 스크립트 속성에 NOTIFY_EMAIL을 지정하면 그 주소로, 없으면 실행 계정(트리거 소유자)에게 메일을 보낸다.
const NOTIFY_EMAIL_PROP = 'NOTIFY_EMAIL';

function currentMonth_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM');
}

// 새로 만드는 스냅샷 열 이름: 생성일 기준 "YY-MM-DD 재고" (예: 2026-11-01 생성 → "26-11-01 재고").
function snapshotLabel_(date) {
  return Utilities.formatDate(date, 'Asia/Seoul', 'yy-MM-dd') + ' 재고';
}

// 열 이름이 스냅샷 열이면 그 스냅샷의 연월('yyyy-MM')을, 아니면 null을 돌려준다.
// 새 형식("26-11-01 재고")과 이전 형식("2026-10 재고")을 모두 인식한다.
function snapshotMonthOfHeader_(header) {
  const text = String(header || '').trim();
  let m = text.match(/^(\d{2})-(\d{2})-(\d{2}) 재고$/);
  if (m) return '20' + m[1] + '-' + m[2];
  m = text.match(/^(\d{4})-(\d{2}) 재고$/);
  if (m) return m[1] + '-' + m[2];
  return null;
}

// 헤더 목록에서 해당 월(yyyy-MM)의 스냅샷 열 이름을 찾는다. 없으면 null.
// 열 이름에 생성일이 들어가 날짜마다 달라지므로, 중복 생성 여부는 열 이름이 아니라 "월"로 판단한다.
function findSnapshotHeaderForMonth_(heads, month) {
  const found = heads.find(h => snapshotMonthOfHeader_(h) === month);
  return found === undefined ? null : String(found);
}

/**
 * 매월 1일 00시에 monthlyStockSnapshot()을 호출하는 시간 트리거를 설치한다.
 * 이전 방식(monthlyStockRollover_, 월초재고 덮어쓰기) 트리거가 남아 있으면 함께 지운다.
 * setupSpreadsheet()에서도 호출되며, 편집기에서 setupMonthlySnapshotTrigger()를 직접 실행해도 된다.
 * (트리거는 이름이 _로 끝나는 비공개 함수를 호출하지 못하므로 핸들러는 공개 함수명을 쓴다.)
 */
function setupMonthlySnapshotTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    const handler = t.getHandlerFunction();
    if (handler === 'monthlyStockRollover_' || handler === 'monthlyStockSnapshot') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('monthlyStockSnapshot')
    .timeBased()
    .onMonthDay(1)
    .atHour(0)
    .create();
  Logger.log('월초 재고 스냅샷 트리거를 설치했습니다 (매월 1일 00시). 현재 트리거: ' +
    ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()).join(', '));
}

// 트리거가 매월 1일 00시에 호출한다.
function monthlyStockSnapshot() {
  const month = currentMonth_();
  if (month < SNAPSHOT_AUTO_START_MONTH) {
    Logger.log(month + ' 스냅샷은 자동 생성 대상이 아닙니다 (' + SNAPSHOT_AUTO_START_MONTH + '부터 자동).');
    return;
  }
  runStockSnapshotWithNotify_('자동(트리거)');
}

// keepAlive()(5분마다)가 호출하는 안전망: 이번 달 스냅샷이 아직 없으면 직접 만든다.
// 1일 01시 이전에는 정규 트리거에 맡기고, 실패가 반복돼도 1시간에 한 번만 다시 시도한다.
function ensureMonthlySnapshot_() {
  const month = currentMonth_();
  if (month < SNAPSHOT_AUTO_START_MONTH) return;
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty(SNAPSHOT_DONE_PROP) === month) return;

  const now = new Date();
  const day = Number(Utilities.formatDate(now, 'Asia/Seoul', 'd'));
  const hour = Number(Utilities.formatDate(now, 'Asia/Seoul', 'H'));
  if (day === 1 && hour < 1) return;

  const lastAttempt = Number(props.getProperty(SNAPSHOT_ATTEMPT_PROP)) || 0;
  if (now.getTime() - lastAttempt < 60 * 60 * 1000) return;
  props.setProperty(SNAPSHOT_ATTEMPT_PROP, String(now.getTime()));

  runStockSnapshotWithNotify_('안전망(정규 트리거 미실행 감지)');
}

// "자재관리 > 이번 달 재고 스냅샷 생성" 메뉴. 이미 모든 사이트에 생성돼 있으면 안내만 하고 다시 만들지 않는다.
function createStockSnapshotFromMenu() {
  const ui = SpreadsheetApp.getUi();
  const month = currentMonth_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const existing = [];
  const pending = SITES.filter(site => {
    const sheet = ss.getSheetByName(site + '_재고');
    if (!sheet) return false;
    const header = findSnapshotHeaderForMonth_(headers_(sheet), month);
    if (header) existing.push(site + ' "' + header + '"');
    return !header;
  });
  if (!pending.length) {
    ui.alert(month + ' 재고 스냅샷이 이미 모든 사이트에 있습니다. 다시 생성하지 않습니다.\n\n' + existing.join('\n'));
    return;
  }
  const outcome = runStockSnapshotWithNotify_('수동(메뉴)');
  ui.alert(outcome.status + '\n\n' + outcome.message);
}

// 스냅샷 생성 + 재고 대사 + 결과 알림(알림로그 시트 + 메일). 스냅샷과 대사는 서로 독립적으로 실패한다.
// 열 이름의 날짜는 이 함수가 실행된 시각(생성일)으로 정해진다.
function runStockSnapshotWithNotify_(source) {
  const now = new Date();
  let result;
  try {
    result = createStockSnapshot_(now);
  } catch (err) {
    result = { created: [], skipped: [], missing: [], errors: [{ site: '전체', message: String(err && err.message || err) }] };
  }

  const status = result.errors.length ? '실패' : (result.created.length ? '성공' : '이미 생성됨');
  const lines = [
    '대상 월: ' + Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM') + ' / 열 이름: "' + snapshotLabel_(now) + '" / 실행: ' + source,
    '생성: ' + (result.created.join(', ') || '없음'),
    '이미 있음(건너뜀): ' + (result.skipped.join(', ') || '없음')
  ];
  if (result.missing.length) lines.push('재고 시트 없음: ' + result.missing.join(', '));
  result.errors.forEach(e => lines.push('오류 [' + e.site + ']: ' + e.message));

  try {
    const summary = runStockReconciliation_();
    lines.push('재고 대사: ' + summary.text);
  } catch (err) {
    lines.push('재고 대사 실패: ' + String(err && err.message || err));
  }

  const message = lines.join('\n');
  notify_('월초 재고 스냅샷', status, message);
  return { status, message };
}

// 각 사이트 _재고 시트에 "YY-MM-DD 재고"(now 기준 생성일) 열을 추가하고 그 시점 현재고를 복사한다.
// 같은 달의 스냅샷 열(새/이전 형식 모두)이 이미 있으면 건너뛴다(월 단위 멱등). 값을 먼저 쓰고 헤더를
// 마지막에 써서, 중간에 실패해도 "헤더만 있고 값이 빈" 열이 완료로 간주되는 일이 없게 한다.
// 현재고 열은 읽기만 한다.
function createStockSnapshot_(now) {
  const month = Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM');
  const label = snapshotLabel_(now);
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const result = { created: [], skipped: [], missing: [], errors: [] };

  // 입출고 처리 도중의 값이 찍히지 않도록 입출고와 같은 스크립트 락을 잡는다.
  const lock = scriptLock_();
  lock.waitLock(60000);
  try {
    SITES.forEach(site => {
      try {
        const sheet = ss.getSheetByName(site + '_재고');
        if (!sheet) { result.missing.push(site); return; }
        const heads = headers_(sheet);
        const existingHeader = findSnapshotHeaderForMonth_(heads, month);
        if (existingHeader) { result.skipped.push(site + '("' + existingHeader + '")'); return; }
        const qtyIdx = heads.indexOf('현재고');
        if (qtyIdx === -1) throw new Error('현재고 열을 찾을 수 없습니다.');

        const col = sheet.getLastColumn() + 1;
        if (col > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), col - sheet.getMaxColumns());
        const lastRow = sheet.getLastRow();
        if (lastRow >= 2) {
          const values = sheet.getRange(2, qtyIdx + 1, lastRow - 1, 1).getValues()
            .map(r => [Number(r[0]) || 0]);
          sheet.getRange(2, col, values.length, 1).setValues(values).setNumberFormat('#,##0');
        }
        sheet.getRange(1, col).setNumberFormat('@').setValue(label)
          .setFontWeight('bold').setBackground('#f1f3f4');
        result.created.push(site);
      } catch (err) {
        result.errors.push({ site, message: String(err && err.message || err) });
      }
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  if (!result.errors.length) {
    PropertiesService.getScriptProperties().setProperty(SNAPSHOT_DONE_PROP, month);
  }
  return result;
}

// ------------------------- 재고 대사(검증) -------------------------

// 모든 사이트의 현재고를 이력 기준 이론 재고(Code.gs calculateExpectedStockMap_)와 비교해
// 재고대사 시트에 차이 목록을 새로 기록한다. 현재고 값은 절대 고치지 않는다.
function runStockReconciliation_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = [];
  const perSite = [];
  SITES.forEach(site => {
    if (!ss.getSheetByName(site + '_재고')) return;
    const mismatches = reconcileStock_(site);
    perSite.push(site + ' ' + mismatches.length + '건');
    mismatches.forEach(m => rows.push([site, m.itemId, m.actual, m.expected, m.diff]));
  });

  let sheet = ss.getSheetByName(STOCK_RECONCILE_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(STOCK_RECONCILE_SHEET_NAME);
  sheet.clear();
  const checkedAt = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  sheet.getRange(1, 1, 1, 6).setValues([['사이트', '자재코드', '현재고', '이력 기준 재고', '차이', '확인시각 ' + checkedAt]])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
  if (rows.length) sheet.getRange(2, 1, rows.length, 5).setValues(rows);

  const text = rows.length
    ? '차이 ' + rows.length + '건 (' + perSite.join(', ') + ') — "' + STOCK_RECONCILE_SHEET_NAME + '" 시트 확인'
    : '차이 없음';
  return { count: rows.length, text };
}

// "자재관리 > 재고 대사(검증)" 메뉴.
function runStockReconciliationFromMenu() {
  const summary = runStockReconciliation_();
  if (summary.count) notify_('재고 대사', '경고', summary.text);
  SpreadsheetApp.getUi().alert('재고 대사 결과: ' + summary.text +
    '\n\n이력 기준 재고는 참고값입니다(월초재고 기준값 + 전체 입고 − 출고 + 반납 ± 이관). 현재고는 변경하지 않았습니다.');
}

// ------------------------- 알림 -------------------------

// 알림로그 시트에 한 줄 남기고 메일을 보낸다. 둘 중 하나가 실패해도 다른 하나는 시도한다.
function notify_(task, status, message) {
  const at = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(NOTIFY_LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(NOTIFY_LOG_SHEET_NAME);
      sheet.getRange(1, 1, 1, 4).setValues([['일시', '작업', '결과', '내용']])
        .setFontWeight('bold').setBackground('#f1f3f4');
      sheet.setFrozenRows(1);
    }
    sheet.appendRow([at, task, status, message]);
  } catch (err) {
    Logger.log('알림로그 기록 실패: ' + (err && err.message || err));
  }
  try {
    const to = PropertiesService.getScriptProperties().getProperty(NOTIFY_EMAIL_PROP) ||
      Session.getEffectiveUser().getEmail();
    if (to) MailApp.sendEmail(to, '[QR 재고] ' + task + ' ' + status, at + '\n\n' + message);
  } catch (err) {
    Logger.log('알림 메일 발송 실패: ' + (err && err.message || err));
  }
  Logger.log('[' + task + '] ' + status + '\n' + message);
}

/**
 * 5분마다 keepAlive()(Code.gs)를 호출하는 시간 트리거를 설치한다.
 * 스크립트 편집기에서 한 번 수동으로 실행한다 (setupSpreadsheet()에서는 자동 호출하지 않음).
 * 기존에 설치된 keepAlive 트리거가 있으면 지우고 다시 만들어 중복 등록을 막는다.
 */
function setupTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'keepAlive') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('keepAlive')
    .timeBased()
    .everyMinutes(5)
    .create();
  Logger.log('트리거 설정 완료');
}

/**
 * 스프레드시트를 열 때마다 자동으로 실행되는 심플 트리거(함수명 고정, Apps Script가 직접 호출).
 * 상단에 "자재관리" 메뉴(자재 동기화 / 이번 달 재고 스냅샷 생성 / 재고 대사)를 추가한다.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('자재관리')
    .addItem('자재 동기화', 'syncMaterials_')
    .addSeparator()
    .addItem('이번 달 재고 스냅샷 생성', 'createStockSnapshotFromMenu')
    .addItem('재고 대사(검증)', 'runStockReconciliationFromMenu')
    .addToUi();
}

/**
 * "자재관리 > 자재 동기화" 메뉴가 호출하는 함수.
 * 사이트(기흥/화성/평택)별 구매발주및입고 시트를 전체 스캔해서 각 행의 자재코드가
 * Items 시트 / 그 사이트의 사용자재 시트에 없으면 자동으로 한 줄씩 추가한다(있으면 건너뜀 -
 * 기존 값은 절대 덮어쓰지 않는다). 구매발주및입고 시트에는 단위 컬럼이 없으므로 Unit은
 * 항상 기본값 'EA'로 채워진다.
 */
function syncMaterials_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const itemsSheet = ss.getSheetByName('Items');
  if (!itemsSheet) throw new Error('Items 시트를 찾을 수 없습니다. Setup.gs의 setupSpreadsheet()를 먼저 실행하세요.');

  const existingItemIds = new Set(
    readAll_(itemsSheet).map(r => String(r['ItemID'] || '').trim()).filter(Boolean)
  );
  const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

  let itemsAdded = 0;
  let usedMaterialsAdded = 0;

  SITES.forEach(site => {
    const poSheet = ss.getSheetByName(site + '_구매발주및입고');
    if (!poSheet) return;

    const usedSheet = ss.getSheetByName(site + '_사용자재');
    const existingUsedCodes = usedSheet
      ? new Set(readAll_(usedSheet).map(r => String(r['자재코드'] || '').trim()).filter(Boolean))
      : null;

    readAll_(poSheet).forEach(r => {
      const itemId = String(r['자재코드'] || '').trim();
      if (!itemId) return;
      const itemName = String(r['자재명'] || '').trim();
      const spec = String(r['규격'] || '').trim();
      const unit = String(r['단위'] || '').trim() || 'EA';

      if (!existingItemIds.has(itemId)) {
        itemsSheet.appendRow([itemId, itemName, spec, unit, '', today, '★신규']);
        existingItemIds.add(itemId);
        itemsAdded++;
      }

      if (usedSheet && !existingUsedCodes.has(itemId)) {
        usedSheet.appendRow([itemId, '', itemName, spec, '', '동기화추가', '']);
        existingUsedCodes.add(itemId);
        usedMaterialsAdded++;
      }
    });
  });

  const message = '동기화 완료: Items ' + itemsAdded + '개 추가, 사용자재 ' + usedMaterialsAdded + '개 추가';
  Logger.log(message);
  SpreadsheetApp.getUi().alert(message);
}
