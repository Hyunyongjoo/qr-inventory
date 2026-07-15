/**
 * Setup.gs
 * Apps Script 편집기에서 setupSpreadsheet() 함수를 한 번 실행하면
 * 필요한 시트와 헤더, 샘플 데이터를 자동으로 생성합니다.
 * (스크립트 편집기 상단 함수 선택 드롭다운에서 setupSpreadsheet 선택 후 ▶ 실행)
 *
 * 사이트(기흥/화성/평택)별로 재고/구매발주및입고/출고 시트가 각각 분리되어 생성됩니다.
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
    // 예전 "_구매발주"/"_입고" 시트가 남아있다면 새 통합 시트 이름으로 정리한다 (한 번만 실행되면 충분, 안전하게 반복 실행 가능).
    migrateToIntegratedPoSheet_(ss, site);

    createSheetIfMissing_(ss, site + '_재고', [
      'ItemID', 'ItemName', 'Spec', 'Quantity', 'UpdatedAt'
    ]);
    // 구매발주 + 입고이력 통합 시트: 한 행이 발주 1건을 나타내며,
    // FIFO 입고 처리 시 누적입고수량/잔여수량/입고여부/최종입고일이 그 자리에서 갱신된다.
    // (발주와 매칭되지 않는 입고는 새 행으로 별도 추가된다 - Code.gs의 appendAdhocReceiptRow_)
    createSheetIfMissing_(ss, site + '_구매발주및입고', [
      '구매요청번호', '신청자', '자재코드', '자재명', '규격', '조달구분', '단위',
      '필요일자', '요청수량', '누적입고수량', '잔여수량', '입고여부', '최종입고일', '비고'
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
  Logger.log('설정 완료: Items, Users, 사이트별(기흥/화성/평택) 구매발주및입고·출고·재고 시트가 준비되었습니다.');
}

/**
 * 예전 시트 구조("_구매발주" + "_입고" 두 시트)를 새 통합 시트 "_구매발주및입고" 하나로 정리한다.
 * setupSpreadsheet() 안에서 사이트마다 자동으로 호출되므로 직접 실행할 필요는 없다.
 *
 * 우선순위:
 *  1. "_구매발주및입고"가 이미 있으면 아무 것도 하지 않는다 (이미 정리됨, 반복 실행해도 안전).
 *  2. "_구매발주"가 있으면 그 시트를 "_구매발주및입고"로 이름을 바꾼다 (실제 발주 데이터를 보존).
 *     - "_구매발주"는 13개 컬럼(비고 없음)이라, 리네임 후 마지막 "비고" 컬럼은 데이터가 있는 시트라
 *       자동으로 추가되지 않는다. 필요하면 시트에 "비고" 헤더 한 칸을 수동으로 추가하세요.
 *  3. "_구매발주"가 없고 "_입고"만 있으면(즉, 이미 통합 스키마로 쓰고 있던 경우) 그 시트를 그대로 승격시킨다.
 *  4. 위 과정 후에도 "_입고"가 남아있다면: 비어있으면 삭제하고, 데이터가 있으면 안전하게 남겨두고 경고만 남긴다.
 */
function migrateToIntegratedPoSheet_(ss, site) {
  const newName = site + '_구매발주및입고';
  if (ss.getSheetByName(newName)) return;

  const oldPo = ss.getSheetByName(site + '_구매발주');
  let oldIn = ss.getSheetByName(site + '_입고');

  if (oldPo) {
    oldPo.setName(newName);
  } else if (oldIn) {
    oldIn.setName(newName);
    oldIn = null;
  }

  if (oldIn) {
    if (oldIn.getLastRow() <= 1) {
      ss.deleteSheet(oldIn);
    } else {
      Logger.log('경고: "' + site + '_입고" 시트에 데이터가 남아 있어 자동 삭제하지 않았습니다. 확인 후 수동으로 정리하세요.');
    }
  }
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
