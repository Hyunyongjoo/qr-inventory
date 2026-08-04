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
      '출고완료', '출고완료일시'
    ], [2, 9, 16, 19]); // 요청일자, 필요일자, 최종입고일, 출고완료일시

    createSheetIfMissing_(ss, site + '_출고', [
      '출고일자', '라인', '자재코드', '자재명', '규격', '단위',
      '출고수량', '담당자', '거래코드', '시간', 'S/N관리여부', 'BQMS', 'S/N', '수량', '라인', '층',
      '라인구매번호'
    ], [1]); // 출고일자

    const stockSheet = createSheetIfMissing_(ss, site + '_재고', [
      '자재코드', '자재명', '규격', '월초재고', '현재고', '최종업데이트'
    ], [6]); // 최종업데이트
    if (stockSheet) formatStockSheetNumberColumns_(stockSheet);

    createSheetIfMissing_(ss, site + '_사용자재', [
      '자재코드', 'BQMS', '품명', '규격', '사용설비', '비고'
    ], []);

    createSheetIfMissing_(ss, site + '_반납', [
      '반납일자', '자재코드', '자재명', '규격', '반납수량', '담당자', '비고'
    ], [1]); // 반납일자
  });

  // 매월 1일 00시에 현재고 값을 월초재고로 복사하는 트리거 (이미 설치되어 있으면 건너뜀)
  ensureMonthlyStockRolloverTrigger_();

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
  Logger.log('설정 완료: Items, Users, 사이트별(기흥/화성/평택) 구매발주및입고·출고·재고·사용자재·반납 시트가 준비되었습니다. (데이터가 있는 기존 시트는 변경하지 않았습니다)');
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

// 재고 시트의 월초재고(4열)/현재고(5열) 컬럼을 숫자 서식으로 지정한다 (새로 만들어진 시트에만 호출됨).
function formatStockSheetNumberColumns_(sheet) {
  const maxRows = sheet.getMaxRows();
  if (maxRows < 2) return;
  sheet.getRange(2, 4, maxRows - 1, 1).setNumberFormat('#,##0'); // 월초재고
  sheet.getRange(2, 5, maxRows - 1, 1).setNumberFormat('#,##0'); // 현재고
}

/**
 * 매월 1일 00시, 그 시점의 현재고 값을 월초재고로 복사하는 시간 트리거를 설치한다.
 * 이미 설치되어 있으면 다시 만들지 않는다 (setupSpreadsheet()에서 매번 호출해도 안전).
 */
function ensureMonthlyStockRolloverTrigger_() {
  const already = ScriptApp.getProjectTriggers()
    .some(t => t.getHandlerFunction() === 'monthlyStockRollover_');
  if (already) return;

  ScriptApp.newTrigger('monthlyStockRollover_')
    .timeBased()
    .onMonthDay(1)
    .atHour(0)
    .create();
  Logger.log('월초재고 자동 롤오버 트리거를 설치했습니다 (매월 1일 00시).');
}

// 트리거가 매월 1일 00시에 실제로 호출하는 함수: 그 시점의 현재고를 월초재고에 복사한다.
function monthlyStockRollover_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  SITES.forEach(site => {
    const sheet = ss.getSheetByName(site + '_재고');
    if (!sheet) return;
    const rows = readAll_(sheet);
    rows.forEach(r => {
      updateRow_(sheet, r._row, { '월초재고': Number(r['현재고']) || 0 });
    });
    Logger.log(site + '_재고: ' + rows.length + '건 월초재고 롤오버 완료');
  });
}
