/**
 * Setup.gs
 * Apps Script 편집기에서 setupSpreadsheet() 함수를 한 번 실행하면
 * 필요한 시트와 헤더, 샘플 데이터를 자동으로 생성합니다.
 * (스크립트 편집기 상단 함수 선택 드롭다운에서 setupSpreadsheet 선택 후 ▶ 실행)
 *
 * 사이트(기흥/화성/평택)별로 재고/입고/출고 시트가 각각 분리되어 생성됩니다.
 * SITES 상수는 Code.gs에 정의되어 있습니다 (Apps Script는 모든 .gs 파일을
 * 하나의 전역 스코프로 병합하므로 여기서 다시 선언하지 않습니다).
 */

function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  createSheetIfMissing_(ss, 'Items', [
    'ItemID', 'ItemName', 'Spec', 'Unit', 'Category', 'CreatedAt'
  ]);

  createSheetIfMissing_(ss, 'Users', [
    'PIN', 'Name', 'Role'
  ]);

  SITES.forEach(site => {
    createSheetIfMissing_(ss, site + '_재고', [
      'ItemID', 'Quantity', 'UpdatedAt'
    ]);
    createSheetIfMissing_(ss, site + '_입고', [
      'TransactionID', 'Timestamp', 'ItemID', 'ItemName', 'Quantity', 'BalanceAfter', 'Worker', 'Note'
    ]);
    createSheetIfMissing_(ss, site + '_출고', [
      'TransactionID', 'Timestamp', 'ItemID', 'ItemName', 'Zone', 'Quantity', 'BalanceAfter', 'Worker', 'Note'
    ]);
  });

  // 샘플 데이터 (이미 데이터가 있으면 건너뜀)
  const userSheet = ss.getSheetByName('Users');
  if (userSheet.getLastRow() < 2) {
    userSheet.getRange(2, 1, 2, 3).setValues([
      ['1234', '관리자', '관리자'],
      ['0000', '홍길동', '작업자']
    ]);
  }

  // 기본 시트(Sheet1) 정리
  const defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && ss.getSheets().length > 1) {
    ss.deleteSheet(defaultSheet);
  }

  SpreadsheetApp.flush();
  Logger.log('설정 완료: Items, Users, 사이트별(기흥/화성/평택) 입고·출고·재고 시트가 준비되었습니다.');
}

function createSheetIfMissing_(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  const range = sheet.getRange(1, 1, 1, headers.length);
  const existing = range.getValues()[0];
  const needsHeader = headers.some((h, i) => existing[i] !== h);
  if (needsHeader) {
    range.setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f3f4');
  }
  return sheet;
}
