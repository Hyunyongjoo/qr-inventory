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
      'ItemID', 'ItemName', 'Spec', 'Quantity', 'UpdatedAt'
    ]);
    createSheetIfMissing_(ss, site + '_구매발주', [
      '구매요청번호', '신청자', '자재코드', '자재명', '규격', '조달구분', '단위',
      '필요일자', '요청수량', '누적입고수량', '잔여수량', '입고여부', '최종입고일'
    ]);
    createSheetIfMissing_(ss, site + '_입고', [
      '입고일시', '구매요청번호', '자재코드', '자재명', '규격', '단위', '입고수량', '신청자', '담당자', '비고'
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
    // 이미 데이터가 있는 시트는 헤더가 달라도 자동으로 덮어쓰지 않는다.
    // (컬럼 구조가 바뀌면 기존 행의 값과 새 헤더가 어긋나 데이터가 깨질 수 있음)
    if (sheet.getLastRow() > 1) {
      Logger.log('경고: "' + name + '" 시트에 이미 데이터가 있어 헤더를 자동 변경하지 않았습니다. 필요하면 수동으로 마이그레이션하세요.');
      return sheet;
    }
    range.setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f3f4');
  }
  return sheet;
}
