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

  // 출고 시트 마이그레이션 시 자재코드로 규격/단위를 채워 넣기 위해 Items 시트를 미리 읽어둔다.
  const itemsSheet = ss.getSheetByName('Items');
  const itemMap = {};
  if (itemsSheet) {
    readAll_(itemsSheet).forEach(it => { itemMap[String(it.ItemID)] = it; });
  }

  SITES.forEach(site => {
    // 예전 "_구매발주"/"_입고" 시트가 남아있다면 새 통합 시트 이름으로 정리한다 (한 번만 실행되면 충분, 안전하게 반복 실행 가능).
    migrateToIntegratedPoSheet_(ss, site);
    // 예전 영문 컬럼 구조의 출고/재고 시트를 새 한글 컬럼 순서로 데이터 보존하며 변환한다 (한 번만 실행되면 충분).
    migrateOutSheetColumns_(ss, site, itemMap);
    migrateStockSheetColumns_(ss, site);

    createSheetIfMissing_(ss, site + '_재고', [
      '자재코드', '자재명', '규격', '월초재고', '현재고', '최종업데이트'
    ]);
    // 구매발주 + 입고이력 통합 시트: 한 행이 발주 1건을 나타내며,
    // FIFO 입고 처리 시 누적입고수량/잔여수량/입고여부/최종입고일이 그 자리에서 갱신된다.
    // (발주와 매칭되지 않는 입고는 새 행으로 별도 추가된다 - Code.gs의 appendAdhocReceiptRow_)
    createSheetIfMissing_(ss, site + '_구매발주및입고', [
      '구매요청번호', '신청자', '자재코드', '자재명', '규격', '조달구분', '단위',
      '필요일자', '요청수량', '누적입고수량', '잔여수량', '입고여부', '최종입고일', '비고'
    ]);
    createSheetIfMissing_(ss, site + '_출고', [
      '거래코드', '시간', '자재코드', '자재명', '규격', '단위', '출고수량', '잔여재고', '담당자', '라인'
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

function arraysEqual_(a, b) {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// 헤더를 다시 쓰고 데이터 행을 그 아래에 채운다 (컬럼 구조 마이그레이션 공통 로직).
function rewriteSheet_(sheet, headers, rows) {
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f3f4');
  if (rows.length) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
}

// 맨 처음 영문 스키마 (2번째로 오래된 버전)
const ENGLISH_OUT_HEADERS_ = ['TransactionID', 'Timestamp', 'ItemID', 'ItemName', 'Zone', 'Quantity', 'BalanceAfter', 'Worker', 'Note'];
// 그 다음 한글 스키마 (거래코드/시간을 맨 뒤로, 출고일자/시간 분리, 잔여재고 제외했던 버전)
const PREV_KOREAN_OUT_HEADERS_ = ['출고일자', '라인', '자재코드', '자재명', '규격', '단위', '출고수량', '담당자', '거래코드', '시간'];
// 현재 최종 스키마
const NEW_OUT_HEADERS_ = ['거래코드', '시간', '자재코드', '자재명', '규격', '단위', '출고수량', '잔여재고', '담당자', '라인'];

/**
 * "_출고" 시트를 최종 한글 컬럼 순서(거래코드/시간/자재코드/자재명/규격/단위/출고수량/잔여재고/담당자/라인)로
 * 데이터를 유지하며 재구성한다. 그동안 시트가 거쳐온 두 가지 예전 구조(영문 원본, 직전 한글 구조)를
 * 모두 인식해서 변환하며, 이미 최종 구조이거나 알아볼 수 없는 헤더면 안전하게 건너뛴다.
 * 규격/단위(영문 스키마 마이그레이션 시)와 잔여재고(직전 한글 스키마 마이그레이션 시)는
 * 과거 로그에 없던 값이라 빈 값으로 채워진다.
 */
function migrateOutSheetColumns_(ss, site, itemMap) {
  const name = site + '_출고';
  const sheet = ss.getSheetByName(name);
  if (!sheet) return;

  const lastCol = sheet.getLastColumn();
  const currentHeader = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  const lastRow = sheet.getLastRow();

  if (arraysEqual_(currentHeader, NEW_OUT_HEADERS_)) return; // 이미 최신 구조

  if (arraysEqual_(currentHeader.slice(0, PREV_KOREAN_OUT_HEADERS_.length), PREV_KOREAN_OUT_HEADERS_)) {
    const oldRows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, PREV_KOREAN_OUT_HEADERS_.length).getValues() : [];
    const newRows = oldRows.map(r => {
      const obj = {};
      PREV_KOREAN_OUT_HEADERS_.forEach((h, i) => (obj[h] = r[i]));
      const combinedTime = obj['출고일자'] ? `${obj['출고일자']}T${obj['시간'] || '00:00:00'}` : (obj['시간'] || '');
      return [
        obj['거래코드'] || '',
        combinedTime,
        obj['자재코드'] || '',
        obj['자재명'] || '',
        obj['규격'] || '',
        obj['단위'] || '',
        obj['출고수량'] || 0,
        '', // 잔여재고 - 직전 스키마엔 없던 값
        obj['담당자'] || '',
        obj['라인'] || ''
      ];
    });
    rewriteSheet_(sheet, NEW_OUT_HEADERS_, newRows);
    Logger.log(name + ': ' + newRows.length + '행 컬럼 구조 마이그레이션 완료 (직전 한글 구조 → 최종, 잔여재고는 빈 값)');
    return;
  }

  if (arraysEqual_(currentHeader.slice(0, ENGLISH_OUT_HEADERS_.length), ENGLISH_OUT_HEADERS_)) {
    const oldRows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, ENGLISH_OUT_HEADERS_.length).getValues() : [];
    const newRows = oldRows.map(r => {
      const obj = {};
      ENGLISH_OUT_HEADERS_.forEach((h, i) => (obj[h] = r[i]));
      const item = itemMap[String(obj.ItemID)] || {};
      return [
        obj.TransactionID || '',
        obj.Timestamp || '',
        obj.ItemID || '',
        obj.ItemName || '',
        item.Spec || '',
        item.Unit || '',
        obj.Quantity || 0,
        obj.BalanceAfter || '',
        obj.Worker || '',
        obj.Zone || ''
      ];
    });
    rewriteSheet_(sheet, NEW_OUT_HEADERS_, newRows);
    Logger.log(name + ': ' + newRows.length + '행 컬럼 구조 마이그레이션 완료 (영문 구조 → 최종)');
    return;
  }

  Logger.log('경고: "' + name + '" 시트 헤더가 예상과 달라 자동 마이그레이션을 건너뛰었습니다. 수동으로 확인하세요.');
}

const OLD_STOCK_HEADERS_ = ['ItemID', 'ItemName', 'Spec', 'Quantity', 'UpdatedAt'];
const NEW_STOCK_HEADERS_ = ['자재코드', '자재명', '규격', '월초재고', '현재고', '최종업데이트'];

/**
 * 예전 영문 컬럼의 "_재고" 시트를 새 한글 컬럼 순서로 데이터를 유지하며 재구성한다.
 * 월초재고는 과거에 없던 값이라 빈 값으로 추가되며, 필요하면 수동으로 채워 넣어야 한다.
 */
function migrateStockSheetColumns_(ss, site) {
  const name = site + '_재고';
  const sheet = ss.getSheetByName(name);
  if (!sheet) return;

  const lastCol = sheet.getLastColumn();
  const currentHeader = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];

  if (arraysEqual_(currentHeader, NEW_STOCK_HEADERS_)) return;
  if (!arraysEqual_(currentHeader.slice(0, OLD_STOCK_HEADERS_.length), OLD_STOCK_HEADERS_)) {
    Logger.log('경고: "' + name + '" 시트 헤더가 예상과 달라 자동 마이그레이션을 건너뛰었습니다. 수동으로 확인하세요.');
    return;
  }

  const lastRow = sheet.getLastRow();
  const oldRows = lastRow > 1 ? sheet.getRange(2, 1, lastRow - 1, OLD_STOCK_HEADERS_.length).getValues() : [];

  const newRows = oldRows.map(r => {
    const obj = {};
    OLD_STOCK_HEADERS_.forEach((h, i) => (obj[h] = r[i]));
    return [
      obj.ItemID || '',
      obj.ItemName || '',
      obj.Spec || '',
      '',
      obj.Quantity || 0,
      obj.UpdatedAt || ''
    ];
  });

  rewriteSheet_(sheet, NEW_STOCK_HEADERS_, newRows);
  Logger.log(name + ': ' + newRows.length + '행 컬럼 구조 마이그레이션 완료 (월초재고는 빈 값으로 추가됨)');
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
