/**
 * Code.gs — QR 자재 입출고 관리 시스템 백엔드 API
 *
 * 배포 방법: 배포 > 새 배포 > 유형: 웹 앱
 *   - 실행 계정: 나
 *   - 액세스 권한: 모든 사용자 (익명 포함)
 * 배포 후 발급되는 웹 앱 URL을 pwa/js/api.js 의 API_BASE_URL 에 붙여넣으세요.
 *
 * 프런트엔드(PWA)에서의 CORS 프리플라이트를 피하기 위해
 * 모든 쓰기 요청(POST)은 Content-Type: text/plain 으로 전송되고,
 * 본문(body)은 JSON 문자열입니다. (Apps Script는 doOptions를 지원하지 않음)
 *
 * 재고/입출고는 사이트(기흥/화성/평택) 단위로 완전히 분리되어 있으며,
 * 각 사이트는 자신만의 재고/구매발주및입고/출고 시트를 가집니다. (Setup.gs 참고)
 */

const SITES = ['기흥', '화성', '평택'];
const MATERIAL_PHOTO_FOLDER_ID = '1bZBjpGMHNvBNgls0AaS0zdigURqXfZI0';
const ZONES = {
  '기흥': ['S1', '6LINE', 'S3', 'S4', 'Display'],
  '화성': ['11LINE', '15LINE', '16LINE', '17LINE', 'NRDLINE'],
  '평택': ['P1', 'P2', 'P3', 'P4', 'S5']
};
// 라인구매번호(예: GH26-0728-0001) 접두사로 쓰는 사이트 코드.
const SITE_CODES = { '기흥': 'GH', '화성': 'HS', '평택': 'PT' };
// 입고확인 화면의 재고사용/구매필요/입고/출고완료 버튼을 사용할 수 있는 Role (Users 시트 Role 컬럼 값).
const MANAGER_ROLES = ['자재담당자', '관리자'];
// 구매요청번호가 등록되어(구매완료 계열) 이후로 넘어간 상태에서는 재고사용/구매필요/구매보류
// 3개 버튼을 모두 잠근다 — 입고확인 화면 버튼 활성화 조건과 동일한 목록(js/app.js의
// STOCK_USAGE_LOCKED_STATUSES와 대응).
const STOCK_USAGE_LOCKED_STATUSES = ['구매완료', '부분입고', '입고완료', '부분출고', '출고완료'];
// 입고확인 화면에서 이름/날짜/라인 조건 없이(=전체 라인) 검색할 때 돌려주는 최대 건수.
const INBOUND_CHECK_MAX_ROWS = 100;
// sheet_()가 실행 중 같은 시트에 대해 매번 컬럼 마이그레이션을 반복하지 않도록 하는 캐시 (실행마다 초기화됨).
const ensuredColumnsCache_ = {};

// ------------------------- 라우터 -------------------------

function doGet(e) {
  try {
    const action = e.parameter.action || 'ping';
    let result;
    switch (action) {
      case 'ping':
        result = pingDiagnostics_();
        break;
      case 'login':
        result = handleLogin_(e.parameter.pin);
        break;
      case 'items':
        result = listItems_(e.parameter.q || '');
        break;
      case 'item':
        result = getItemDetail_(e.parameter.id);
        break;
      case 'itemByCode':
        result = getItemByCode_(e.parameter.code);
        break;
      case 'poMatch':
        result = listOpenPurchaseOrders_(e.parameter.site || '', e.parameter.itemId || '');
        break;
      case 'scanLookup':
        result = scanLookupForStockIn_(e.parameter.site || '', e.parameter.code || '');
        break;
      case 'scanLookupOut':
        result = scanLookupForStockOut_(e.parameter.site || '', e.parameter.code || '');
        break;
      case 'checkInbound':
        result = checkInbound_(e.parameter.site || '', e.parameter.name || '', e.parameter.startDate || '', e.parameter.endDate || '', e.parameter.zone || '', e.parameter.materialQuery || '');
        break;
      case 'searchMaterials':
        result = searchMaterials_(e.parameter.site || '', e.parameter.query || '', e.parameter.specQuery || '');
        break;
      case 'getPhotoUrl':
        result = getPhotoUrl_(e.parameter.itemId || '');
        break;
      case 'sites':
        result = SITES;
        break;
      case 'stock':
        result = listStock_(e.parameter.site || '', e.parameter.q || '');
        break;
      case 'transactions':
        result = listTransactions_({
          site: e.parameter.site || '',
          itemId: e.parameter.itemId || '',
          type: e.parameter.type || '',
          limit: Number(e.parameter.limit || 50)
        });
        break;
      case 'getByLineOrderNo':
        result = getPurchaseByLineOrderNo_(e.parameter.site || '', e.parameter.orderNo || '');
        break;
      case 'getPurchaseDownload':
        result = getPurchaseDownload_(e.parameter.site || '', e.parameter.startDate || '', e.parameter.endDate || '', e.parameter.zone || '');
        break;
      case 'getOutboundDownload':
        result = getOutboundDownload_(e.parameter.site || '', e.parameter.startDate || '', e.parameter.endDate || '', e.parameter.zone || '');
        break;
      case 'getTransactionDownload':
        result = getTransactionDownload_(e.parameter.site || '', e.parameter.startDate || '', e.parameter.endDate || '', e.parameter.zone || '');
        break;
      default:
        throw new Error('알 수 없는 action: ' + action);
    }
    return jsonResponse_({ success: true, data: result });
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || '{}');
    const action = body.action;
    let result;
    switch (action) {
      case 'verifyPin':
        result = handleLogin_(body.pin);
        break;
      case 'addItem':
        result = addItem_(body);
        break;
      case 'stockIn':
        result = stockIn_(body);
        break;
      case 'stockOut':
        result = stockOut_(body);
        break;
      case 'submitPurchase':
        result = submitPurchase_(body);
        break;
      case 'stockReturn':
        result = stockReturn_(body);
        break;
      case 'cancelPurchase':
        result = cancelPurchase_(body);
        break;
      case 'updateRequestedQty':
        result = updateRequestedQty_(body);
        break;
      case 'stockOutByOrder':
        result = stockOutByOrder_(body);
        break;
      case 'updateStockUsage':
        result = updateStockUsage_(body);
        break;
      case 'inboundByManager':
        result = inboundByManager_(body);
        break;
      case 'outboundComplete':
        result = outboundComplete_(body);
        break;
      case 'editInboundQty':
        result = editInboundQty_(body);
        break;
      default:
        throw new Error('알 수 없는 action: ' + action);
    }
    return jsonResponse_({ success: true, data: result });
  } catch (err) {
    return jsonResponse_({ success: false, error: String(err.message || err) });
  }
}

// action=ping 진단: Apps Script 배포가 살아있는지 + Items 시트에 실제 데이터가 있는지 함께 확인
function pingDiagnostics_() {
  const result = { ok: true, time: new Date().toISOString() };
  try {
    const items = readAll_(sheet_('Items'));
    result.itemsSheetOk = true;
    result.itemCount = items.length;
  } catch (err) {
    result.itemsSheetOk = false;
    result.itemCount = 0;
    result.itemsError = String(err.message || err);
  }
  return result;
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ------------------------- 시트 유틸 -------------------------

function sheet_(name) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('시트를 찾을 수 없습니다: ' + name + ' (Setup.gs의 setupSpreadsheet()를 먼저 실행하세요)');
  // 기존 스프레드시트에 이미 데이터가 있어 Setup.gs가 헤더를 새로 쓰지 못하는 경우를 위해,
  // 입고확인 화면 개편(재고사용/입고/출고완료 버튼)에 필요한 컬럼이 없으면 여기서 안전하게 추가한다.
  if (name.slice(-8) === '_구매발주및입고') {
    ensureColumnsOnce_(sheet, name, ['누적출고수량', '출고여부', '최종출고일', '비고', '특이사항1', '특이사항2']);
  } else if (name.slice(-3) === '_출고') {
    ensureColumnsOnce_(sheet, name, ['라인구매번호']);
  }
  return sheet;
}

// 같은 시트에 대해 한 번의 doGet/doPost 실행 중 컬럼 존재 여부를 반복해서 확인하지 않도록 캐시한다.
function ensureColumnsOnce_(sheet, cacheKey, columnNames) {
  if (ensuredColumnsCache_[cacheKey]) return;
  ensureColumns_(sheet, columnNames);
  ensuredColumnsCache_[cacheKey] = true;
}

// 시트에 없는 컬럼만 마지막 열 뒤에 추가한다. 기존 데이터/컬럼 순서는 건드리지 않는다.
function ensureColumns_(sheet, columnNames) {
  const lastCol = sheet.getLastColumn();
  const header = lastCol ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
  columnNames.forEach((name) => {
    if (header.indexOf(name) === -1) {
      const newCol = sheet.getLastColumn() + 1;
      sheet.getRange(1, newCol, 1, 1).setValue(name).setFontWeight('bold').setBackground('#f1f3f4');
      header.push(name);
    }
  });
}

// 입고확인 화면의 재고사용/구매필요/입고/출고완료 버튼은 Users 시트 Role이 MANAGER_ROLES에
// 포함된 사용자만 실행할 수 있다 (프런트엔드는 버튼 자체를 숨기고, 여기서 한 번 더 검증한다).
function assertManagerRole_(pin) {
  const user = handleLogin_(pin);
  if (MANAGER_ROLES.indexOf(user.role) === -1) {
    throw new Error('이 작업을 수행할 권한이 없습니다.');
  }
  return user;
}

function assertSite_(site) {
  if (!SITES.includes(site)) throw new Error('올바르지 않은 사이트입니다: ' + site);
  return site;
}

function assertZone_(site, zone) {
  const zones = ZONES[site] || [];
  if (!zones.includes(zone)) throw new Error('올바르지 않은 라인입니다: ' + zone);
  return zone;
}

function stockSheetName_(site) {
  return site + '_재고';
}

// 출고 이력 시트 (입고는 구매발주및입고 시트로 통합되어 여기서 다루지 않는다)
function txSheetName_(site) {
  return site + '_출고';
}

// 구매발주 + 입고 통합 시트 (발주 1건 = 1행, FIFO 입고 시 그 자리에서 갱신)
function poInSheetName_(site) {
  return site + '_구매발주및입고';
}

// 사용자재 시트 (자재담당자가 수동으로 채워 넣는 참고용 마스터 - 구매요청 화면의 자재 검색 대상)
function usedMaterialsSheetName_(site) {
  return site + '_사용자재';
}

// 반납 시트 (출고되었던 자재를 재고로 되돌릴 때 한 줄씩 기록)
function returnSheetName_(site) {
  return site + '_반납';
}

// 묶음자재(세트) 구성표 시트 (구매요청에서 "*** 세트명"을 선택하면 여기서 구성 자재를 찾는다)
function bundledMaterialsSheetName_(site) {
  return site + '_묶음자재';
}

// 품명이 "***"로 시작하면 세트(묶음자재)로 인식한다.
function isSetItemName_(itemName) {
  return String(itemName || '').trim().indexOf('***') === 0;
}

// 세트명으로 그 사이트의 묶음자재 시트에서 구성 자재 행들을 모두 찾는다.
function findBundleComponents_(site, setName) {
  const rows = readAll_(sheet_(bundledMaterialsSheetName_(site)));
  const name = String(setName).trim();
  return rows.filter(r => String(r['세트명'] || '').trim() === name);
}

function headers_(sheet) {
  const lastCol = sheet.getLastColumn();
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0];
}

function readAll_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const lastCol = sheet.getLastColumn();
  const heads = headers_(sheet);
  const values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values.map((row, idx) => {
    const obj = { _row: idx + 2 };
    heads.forEach((h, i) => (obj[h] = row[i]));
    return obj;
  });
}

function appendRow_(sheet, obj) {
  const heads = headers_(sheet);
  const row = heads.map(h => (obj[h] !== undefined ? obj[h] : ''));
  sheet.appendRow(row);
}

function updateRow_(sheet, rowIndex, obj) {
  const heads = headers_(sheet);
  heads.forEach((h, i) => {
    if (obj[h] !== undefined) {
      sheet.getRange(rowIndex, i + 1).setValue(obj[h]);
    }
  });
}

function nextSequentialId_(sheet, idColumn, prefix) {
  const rows = readAll_(sheet);
  let max = 0;
  rows.forEach(r => {
    const val = String(r[idColumn] || '');
    const m = val.match(/(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  const next = max + 1;
  return prefix + '-' + ('000000' + next).slice(-6);
}

// 구매 요청 1건(=제출 1회)마다 부여하는 라인구매번호를 생성한다.
// 형식: {사이트코드}{연도 끝 두자리}-{월일 4자리}-{당일 순번 4자리} (예: GH26-0728-0001)
// 순번은 같은 사이트의 구매발주및입고 시트에서 오늘 날짜 접두사를 가진 값 중 최댓값 + 1이다.
function generateLineOrderNo_(site) {
  const siteCode = SITE_CODES[site];
  if (!siteCode) throw new Error('올바르지 않은 사이트입니다: ' + site);
  const now = new Date();
  const prefix = siteCode + Utilities.formatDate(now, 'Asia/Seoul', 'yy') +
    '-' + Utilities.formatDate(now, 'Asia/Seoul', 'MMdd') + '-';

  const rows = readAll_(sheet_(poInSheetName_(site)));
  let max = 0;
  rows.forEach(r => {
    const val = String(r['라인구매번호'] || '');
    if (val.indexOf(prefix) === 0) {
      const seq = parseInt(val.slice(prefix.length), 10);
      if (!isNaN(seq)) max = Math.max(max, seq);
    }
  });
  const next = max + 1;
  return prefix + ('0000' + next).slice(-4);
}

// ------------------------- 사용자 / 로그인 -------------------------

function handleLogin_(pin) {
  if (!pin) throw new Error('사번을 입력하세요.');
  const users = readAll_(sheet_('Users'));
  const user = users.find(u => String(u.PIN) === String(pin));
  if (!user) throw new Error('사번이 올바르지 않습니다.');
  return { name: user.Name, role: user.Role, pin: String(user.PIN) };
}

// ------------------------- 자재(Items) -------------------------

function listItems_(query) {
  const items = readAll_(sheet_('Items'));
  const q = (query || '').toString().trim().toLowerCase();
  const filtered = q
    ? items.filter(it =>
        String(it.ItemName).toLowerCase().includes(q) ||
        String(it.ItemID).toLowerCase().includes(q) ||
        String(it.Spec).toLowerCase().includes(q) ||
        String(it.Category).toLowerCase().includes(q))
    : items;
  return filtered.map(stripRow_);
}

function getItemByCode_(code) {
  if (!code) throw new Error('QR 코드 값이 없습니다.');
  const items = readAll_(sheet_('Items'));
  if (!items.length) {
    throw new Error('Items 시트에 등록된 자재가 없습니다. 자재 데이터를 먼저 업로드하세요.');
  }
  const normalized = String(code).trim();
  const item = items.find(it => String(it.ItemID).trim() === normalized);
  if (!item) throw new Error('코드 불일치: "' + normalized + '"는 Items 시트의 ItemID와 일치하지 않습니다.');
  return getItemDetail_(item.ItemID);
}

function getItemDetail_(itemId) {
  if (!itemId) throw new Error('ItemID가 필요합니다.');
  const items = readAll_(sheet_('Items'));
  const item = items.find(it => String(it.ItemID) === String(itemId));
  if (!item) throw new Error('자재를 찾을 수 없습니다: ' + itemId);

  const stockBySite = SITES.map(site => {
    const stockRows = readAll_(sheet_(stockSheetName_(site)));
    const row = stockRows.find(s => String(s['자재코드']) === String(itemId));
    return { Site: site, Quantity: row ? Number(row['현재고']) || 0 : 0 };
  });
  const total = stockBySite.reduce((sum, s) => sum + s.Quantity, 0);

  return Object.assign(stripRow_(item), { stockBySite, totalQuantity: total });
}

function addItem_(body) {
  const sheet = sheet_('Items');
  const itemId = (body.itemId && String(body.itemId).trim()) || nextSequentialId_(sheet, 'ItemID', 'IT');
  const existing = readAll_(sheet).find(it => String(it.ItemID) === String(itemId));
  if (existing) throw new Error('이미 존재하는 자재코드입니다: ' + itemId);

  appendRow_(sheet, {
    ItemID: itemId,
    ItemName: body.itemName || '',
    Spec: body.spec || '',
    Unit: body.unit || '',
    Category: body.category || '',
    CreatedAt: new Date()
  });
  return { itemId };
}

function stripRow_(obj) {
  const clone = Object.assign({}, obj);
  delete clone._row;
  return clone;
}

// ------------------------- 재고(Stock) -------------------------

function listStock_(site, query) {
  assertSite_(site);
  const items = readAll_(sheet_('Items'));
  const stockRows = readAll_(sheet_(stockSheetName_(site)));
  const q = (query || '').toString().trim().toLowerCase();

  const itemMap = {};
  items.forEach(it => (itemMap[String(it.ItemID)] = it));

  let rows = stockRows
    .filter(s => Number(s['현재고']) !== 0)
    .filter(s => !!itemMap[String(s['자재코드'])]) // Items 시트에 없는(삭제된) 자재는 목록에서 제외. 재고 시트 데이터 자체는 건드리지 않음.
    .map(s => {
      const item = itemMap[String(s['자재코드'])];
      return {
        ItemID: s['자재코드'],
        ItemName: item.ItemName || '',
        Spec: item.Spec || '',
        Unit: item.Unit || '',
        Quantity: Number(s['현재고']) || 0,
        UpdatedAt: s['최종업데이트']
      };
    });

  if (q) {
    rows = rows.filter(r =>
      String(r.ItemName).toLowerCase().includes(q) ||
      String(r.ItemID).toLowerCase().includes(q));
  }

  rows.sort((a, b) => String(a.ItemName).localeCompare(String(b.ItemName)));
  return rows;
}

// item을 넘기면 재고 시트에 자재명/규격도 함께 저장한다. 월초재고는 건드리지 않는다(수동 관리 컬럼).
function setStockQuantity_(site, itemId, newQuantity, item) {
  const sheet = sheet_(stockSheetName_(site));
  const rows = readAll_(sheet);
  const existing = rows.find(s => String(s['자재코드']) === String(itemId));
  const payload = { '현재고': newQuantity, '최종업데이트': Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd') };
  if (item) {
    payload['자재명'] = item.ItemName || '';
    payload['규격'] = item.Spec || '';
  }
  if (existing) {
    updateRow_(sheet, existing._row, payload);
  } else {
    payload['자재코드'] = itemId;
    appendRow_(sheet, payload);
  }
}

// 현재고 = 월초재고 + 누적입고수량(구매발주및입고 시트에서 그 자재의 모든 행 합계)
//         - 누적출고수량(출고 시트에서 그 자재의 모든 행 합계)
//         + 누적반납수량(반납 시트에서 그 자재의 모든 행 합계)
// 재고를 독립적으로 증감시키지 않고, 매번 발주/출고/반납 원본 데이터로부터 다시 계산한다.
function calculateCurrentStock_(site, itemId) {
  const stockRows = readAll_(sheet_(stockSheetName_(site)));
  const stockRow = stockRows.find(s => String(s['자재코드']) === String(itemId));
  const monthStart = stockRow ? Number(stockRow['월초재고']) || 0 : 0;

  const poRows = readAll_(sheet_(poInSheetName_(site)));
  const totalIn = poRows
    .filter(r => String(r['자재코드']) === String(itemId))
    .reduce((sum, r) => sum + (Number(r['누적입고수량']) || 0), 0);

  const outRows = readAll_(sheet_(txSheetName_(site)));
  const totalOut = outRows
    .filter(r => String(r['자재코드']) === String(itemId))
    .reduce((sum, r) => sum + (Number(r['출고수량']) || 0), 0);

  const returnRows = readAll_(sheet_(returnSheetName_(site)));
  const totalReturn = returnRows
    .filter(r => String(r['자재코드']) === String(itemId))
    .reduce((sum, r) => sum + (Number(r['반납수량']) || 0), 0);

  return monthStart + totalIn - totalOut + totalReturn;
}

function recalculateStock_(site, itemId, item) {
  const newQty = calculateCurrentStock_(site, itemId);
  setStockQuantity_(site, itemId, newQty, item);
  return newQty;
}

// 출고 시 재고 시트의 현재고에서 출고수량만큼 직접 차감한다(현재고 = 현재고 - 출고수량).
// calculateCurrentStock_처럼 입고/출고/반납 이력 전체를 매번 다시 합산하지 않으므로, 과거 이력
// 데이터의 누락/중복 등으로 인한 드리프트가 현재고에 반영되지 않는다. 락(LockService)으로 감싼
// 함수 안에서만 호출해 동시 요청에 의한 중복 차감을 막는다.
function decrementStockQuantity_(site, itemId, qty, item) {
  const current = getStockQty_(site, itemId);
  const newQty = current - qty;
  setStockQuantity_(site, itemId, newQty, item);
  return newQty;
}

function assertItemExists_(itemId) {
  const item = readAll_(sheet_('Items')).find(it => String(it.ItemID) === String(itemId));
  if (!item) throw new Error('자재를 찾을 수 없습니다: ' + itemId);
  return item;
}

// ------------------------- 구매발주 FIFO 매칭 -------------------------

// 자재코드로, 아직 완료되지 않은 발주만 필요일자 오름차순(오래된 것 먼저)으로 정렬해 반환한다.
// 입고여부가 비어있는 행(수동 입력 직후 등)도 미입고로 간주해 포함시킨다.
// 필요일자가 같으면 시트에 적힌 순서(_row)로 안정 정렬한다.
function poSortComparator_(a, b) {
  const da = a['필요일자'] ? new Date(a['필요일자']).getTime() : Infinity;
  const db = b['필요일자'] ? new Date(b['필요일자']).getTime() : Infinity;
  if (da !== db) return da - db;
  return (a._row || 0) - (b._row || 0);
}

// 재고사용(O,X)이 'O'로 표시된 행(자재담당자가 기존 재고로 충당하기로 확정한 요청)은
// 실제 입고를 받을 일이 없으므로 FIFO 매칭/입고 화면 표시 대상에서 제외한다.
// '취소'로 표시된 행(구매 취소 처리된 요청) 역시 같은 이유로 제외한다.
function isStockCoveredRow_(r) {
  return String(r['재고사용(O,X)'] || '').trim().toUpperCase() === 'O';
}

function isCancelledRow_(r) {
  return String(r['재고사용(O,X)'] || '').trim() === '취소';
}

// 재고사용(O,X)이 '보류'로 표시된 행(자재담당자가 구매 진행을 보류한 요청)도 실제 구매/입고가
// 진행되지 않는 상태이므로, 재고사용(O) 행과 마찬가지로 FIFO 입고 매칭 대상에서 제외한다.
function isOnHoldRow_(r) {
  return String(r['재고사용(O,X)'] || '').trim() === '보류';
}

// 누적출고수량이 요청수량 이상이면(=출고여부가 "출고완료"가 되는 조건) 이미 마감된 행으로 보고
// 더 이상 입고/재출고 대상이 아니므로 제외한다. 별도 플래그 없이 수량 비교만으로 판단한다.
function isOutboundDoneRow_(r) {
  const requested = Number(r['요청수량']) || 0;
  const shipped = Number(r['누적출고수량']) || 0;
  return requested > 0 && shipped >= requested;
}

// 누적출고수량이 0보다 크고 요청수량보다 적으면 부분출고 상태다.
function isOutboundPartialRow_(r) {
  const requested = Number(r['요청수량']) || 0;
  const shipped = Number(r['누적출고수량']) || 0;
  return shipped > 0 && shipped < requested;
}

function findOpenPurchaseOrders_(site, itemId) {
  const rows = readAll_(sheet_(poInSheetName_(site)));
  return rows
    .filter(r => String(r['자재코드']) === String(itemId) && r['입고여부'] !== '입고완료' && !isStockCoveredRow_(r) && !isCancelledRow_(r) && !isOnHoldRow_(r) && !isOutboundDoneRow_(r))
    .sort(poSortComparator_);
}

function poRowToView_(po) {
  const requested = Number(po['요청수량']) || 0;
  const cumulative = Number(po['누적입고수량']) || 0;
  return {
    requester: po['신청자'] || '',
    requestedQty: requested,
    cumulativeQty: cumulative,
    remainingQty: requested - cumulative,
    dueDate: po['필요일자'] || '',
    status: po['입고여부'] || (cumulative <= 0 ? '미입고' : (cumulative < requested ? '부분입고' : '입고완료'))
  };
}

// 조회만 하고 시트는 변경하지 않음 (QR 스캔 직후 화면 표시용). 필요일자 오름차순 목록을 그대로 반환하며,
// 프런트엔드는 첫 번째 항목을 "현재 입고 대상"으로 강조 표시한다.
function listOpenPurchaseOrders_(site, itemId) {
  assertSite_(site);
  if (!itemId) throw new Error('ItemID가 필요합니다.');
  return findOpenPurchaseOrders_(site, itemId).map(poRowToView_);
}

// 입고 화면 전용 QR 스캔 조회. Items 시트에서 자재코드로 찾고, 그 사이트의 미완료 발주만 함께 반환한다.
// 재고 시트는 전혀 읽지 않는다 (입고 화면은 더 이상 재고 현황을 보여주지 않으므로 itemByCode보다 훨씬 가볍다).
function scanLookupForStockIn_(site, code) {
  assertSite_(site);
  if (!code) throw new Error('QR 코드 값이 없습니다.');
  const items = readAll_(sheet_('Items'));
  if (!items.length) {
    throw new Error('Items 시트에 등록된 자재가 없습니다. 자재 데이터를 먼저 업로드하세요.');
  }
  const normalized = String(code).trim();
  const item = items.find(it => String(it.ItemID).trim() === normalized);
  if (!item) throw new Error('코드 불일치: "' + normalized + '"는 Items 시트의 ItemID와 일치하지 않습니다.');

  const openPos = findOpenPurchaseOrders_(site, item.ItemID).map(poRowToView_);
  return { item: stripRow_(item), openPos };
}

// 출고 화면 전용 QR 스캔 조회. Items 시트에서 자재코드로 찾고, 현재 선택된 사이트의 재고 시트만 읽는다.
// itemByCode(getItemDetail_)는 SITES 전체(기흥/화성/평택)의 재고 시트를 다 읽어 느리므로,
// 출고 화면은 어차피 로그인한 사이트 재고만 보여주면 되기 때문에 이 경량 버전을 사용한다.
function scanLookupForStockOut_(site, code) {
  assertSite_(site);
  if (!code) throw new Error('QR 코드 값이 없습니다.');
  const items = readAll_(sheet_('Items'));
  if (!items.length) {
    throw new Error('Items 시트에 등록된 자재가 없습니다. 자재 데이터를 먼저 업로드하세요.');
  }
  const normalized = String(code).trim();
  const item = items.find(it => String(it.ItemID).trim() === normalized);
  if (!item) throw new Error('코드 불일치: "' + normalized + '"는 Items 시트의 ItemID와 일치하지 않습니다.');

  const stockRows = readAll_(sheet_(stockSheetName_(site)));
  const stockRow = stockRows.find(s => String(s['자재코드']) === String(item.ItemID));
  const quantity = stockRow ? Number(stockRow['현재고']) || 0 : 0;

  return { item: stripRow_(item), quantity };
}

// 날짜만 비교할 수 있게 시/분/초를 제거한 Date를 반환한다. 값이 비어있거나 날짜로
// 해석할 수 없으면 null (요청일자가 비어있는 행, 혹은 검색창에 날짜를 입력하지 않은 경우).
function toDateOnly_(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// 입고확인 화면 전용: 신청자 이름(부분 일치) + 요청일자 범위 + 라인으로 그 사이트의 모든 발주(모든 자재)를 찾는다.
// listOpenPurchaseOrders_와 달리 자재별이 아니라 신청자/날짜/라인 기준 조회이고, 입고완료 건도 포함한다.
// 이름/시작일/종료일/라인은 모두 선택사항이며, 전부 비어 있으면(=전체 라인 + 조건 없음) 그 사이트의
// 전체 데이터를 대상으로 하되 요청일자가 최근인 순으로 INBOUND_CHECK_MAX_ROWS건까지만 돌려준다.
//  - 이름만: 이름으로만 필터
//  - 이름 + 날짜 + 라인: 모두 AND 조건으로 필터
//  - 라인만: 라인(정확히 일치)으로만 필터
//  - 자재명: 두 방법을 병행해 OR로 합친다(중복 제거) —
//      1) 구매발주및입고 시트 자체의 자재코드/BQMS/자재명(+한글검색 컬럼이 있으면 그것도) 부분 일치
//      2) 사용자재 시트의 한글검색 컬럼에서 부분 일치하는 자재코드를 먼저 찾고, 그 자재코드로
//         구매발주및입고 시트를 조회 (구매발주및입고 시트 자체에는 한글 자재명이 없는 경우가
//         많아, 한글 검색어는 사용자재 시트의 한글 별칭 목록을 거쳐야 매칭되기 때문)
//    대소문자 구분 없음.
//  - 모두 없음: 필터 없이 전체 데이터 중 최근 요청 100건
// 재고사용(O,X)이 '취소'인 행은 시트 데이터는 그대로 두고 이 조회 결과(요약/상세 모두, 따라서
// 화면 상단 건수 표시도)에서만 제외한다.
// 반환값은 { summary, detail } 객체다. detail은 관리 버튼(재고사용/입고/출고완료/취소)이
// 필요로 하는 필드를 모두 담은 기존 행 목록이고, summary는 입고확인 화면 "요약 보기"
// 표에 필요한 필드(rowIndex + 라인구매번호/구매요청번호/라인/자재코드/품명/규격/요청수량/특이사항1/2)만
// 추려 자재 1건 = 1행으로 만든 가벼운 목록이다 — 둘 다 같은 조회 결과에서 파생되므로
// 행 순서/건수는 항상 같다.
function checkInbound_(site, name, startDate, endDate, zone, materialQuery) {
  assertSite_(site);
  const q = (name || '').toString().trim();
  const start = toDateOnly_(startDate);
  const end = toDateOnly_(endDate);
  const zoneQ = (zone || '').toString().trim();
  const materialQ = normalizeForSearch_((materialQuery || '').toString().trim().toLowerCase());
  const hasFilter = !!(q || zoneQ || start || end || materialQ);

  const allRows = readAll_(sheet_(poInSheetName_(site)));
  // 취소된 요청(재고사용(O,X)=취소)은 시트 데이터는 그대로 두고, 이 화면의 조회 결과(요약/상세
  // 모두)에서만 제외한다 — pendingMap 등 다른 계산에 쓰이는 allRows는 건드리지 않는다.
  let rows = allRows.filter(r => !isCancelledRow_(r));
  if (q) rows = rows.filter(r => String(r['신청자'] || '').includes(q));
  if (zoneQ) rows = rows.filter(r => String(r['라인'] || '').trim() === zoneQ);
  if (start || end) {
    rows = rows.filter(r => {
      const d = toDateOnly_(r['요청일자']);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }
  if (materialQ) {
    const hangulItemIds = findItemIdsByHangulAlias_(site, materialQ);
    rows = rows.filter(r => materialMatchesQuery_(r, materialQ) || hangulItemIds.has(String(r['자재코드'] || '').trim()));
  }

  if (!hasFilter && rows.length > INBOUND_CHECK_MAX_ROWS) {
    rows = rows
      .slice()
      .sort((a, b) => {
        const da = a['요청일자'] ? new Date(a['요청일자']).getTime() : 0;
        const db = b['요청일자'] ? new Date(b['요청일자']).getTime() : 0;
        return db - da;
      })
      .slice(0, INBOUND_CHECK_MAX_ROWS);
  }

  const stockMap = buildStockMap_(site);
  const pendingMap = buildPendingInboundMap_(allRows);
  const detail = rows.sort(poSortComparator_).map(r => poRowToInboundView_(site, r, stockMap, pendingMap));
  const summary = detail.map(r => ({
    rowIndex: r.rowIndex,
    lineOrderNo: r.lineOrderNo,
    purchaseReqNo: r.purchaseReqNo,
    zone: r.zone,
    itemId: r.itemId,
    itemName: r.itemName,
    spec: r.spec,
    requestedQty: r.requestedQty,
    note1: r.note1,
    note2: r.note2
  }));
  return { summary, detail };
}

// 문자열을 완성형 한글(NFC)로 정규화한다. 엑셀/CSV로 가져온 데이터나 일부 IME 입력은
// 한글이 자모가 분리된 형태(NFD)로 저장되는 경우가 있는데, 이 상태에서는 화면에서는 같은
// 글자로 보여도 includes()가 매칭에 실패한다(영문/숫자는 애초에 정규화 형태가 없어 이 문제가
// 없으므로 "영문만 검색되고 한글은 안 되는" 증상으로 나타난다). 비교 전 양쪽 다 이 함수로
// 정규화하면 저장/입력 형태가 달라도 같은 글자로 인식된다.
function normalizeForSearch_(s) {
  const str = String(s == null ? '' : s);
  try {
    return str.normalize('NFC');
  } catch (e) {
    return str;
  }
}

// 자재코드/BQMS/자재명(품명) 중 하나라도 검색어를 부분 포함하면(대소문자 무시, 한글 정규화
// 포함) 일치로 본다. 구매발주및입고 시트에 "한글검색" 컬럼이 있으면(사용자재 시트처럼 쉼표로
// 구분된 여러 별칭을 담아둔 컬럼) 그 값들도 공백을 제거한 뒤 부분 일치로 함께 검색한다.
// lowerQuery는 호출부(checkInbound_)에서 이미 trim + toLowerCase + normalizeForSearch_ 처리된 값이다.
function materialMatchesQuery_(r, lowerQuery) {
  const code = normalizeForSearch_(String(r['자재코드'] || '').toLowerCase());
  const bqms = normalizeForSearch_(String(r['BQMS'] || '').toLowerCase());
  const itemName = normalizeForSearch_(String(r['자재명'] || '').toLowerCase());
  if (code.includes(lowerQuery) || bqms.includes(lowerQuery) || itemName.includes(lowerQuery)) return true;

  const hangul = String(r['한글검색'] || '');
  if (!hangul) return false;
  const qNoSpace = stripSpaces_(lowerQuery);
  if (!qNoSpace) return false;
  return hangul.split(',').some(token => {
    const t = normalizeForSearch_(stripSpaces_(token).toLowerCase());
    return t && t.includes(qNoSpace);
  });
}

// 구매발주및입고 시트에는 한글 자재명이 없는 경우가 많아, 자재명 검색어가 한글이면
// materialMatchesQuery_만으로는 매칭되지 않는다. 이 함수는 그 사이트의 "사용자재" 시트에서
// 한글검색 컬럼(쉼표로 구분된 여러 한글 별칭)이 검색어와 부분 일치하는 행을 찾아 그 자재코드
// 집합을 돌려준다 — checkInbound_가 이 자재코드들을 구매발주및입고 시트 조회 조건에 OR로
// 합쳐서(중복 제거는 Set + 행 필터가 자동으로 처리) 두 방법의 결과를 하나로 합친다.
// lowerQuery는 호출부에서 이미 trim + toLowerCase + normalizeForSearch_ 처리된 값이다.
function findItemIdsByHangulAlias_(site, lowerQuery) {
  const ids = new Set();
  const qNoSpace = stripSpaces_(lowerQuery);
  if (!qNoSpace) return ids;

  const rows = readAll_(sheet_(usedMaterialsSheetName_(site)));
  rows.forEach(r => {
    const itemId = String(r['자재코드'] || '').trim();
    if (!itemId) return;
    const hangul = String(r['한글검색'] || '');
    if (!hangul) return;
    const matched = hangul.split(',').some(token => {
      const t = normalizeForSearch_(stripSpaces_(token).toLowerCase());
      return t && t.includes(qNoSpace);
    });
    if (matched) ids.add(itemId);
  });
  return ids;
}

// 입고확인 화면 전용 상태 계산. 우선순위(위에서부터 먼저 매칭되는 것이 최종 상태):
//   1) 누적출고수량 >= 요청수량  → 출고완료 (한 번이라도 출고가 시작되면 재고사용/입고 상태보다 우선)
//   2) 0 < 누적출고수량 < 요청수량 → 부분출고
//   3) 재고사용(O,X) = 취소    → 취소 (기존 구매요청 취소 기능, 건수 집계에는 포함하지 않음)
//   4) 재고사용(O,X) = 보류    → 구매보류 (자재담당자가 구매 진행을 보류한 상태)
//   5) 재고사용(O,X) = O       → 재고사용
//   6) 구매요청번호 등록됨     → 구매완료/부분입고/입고완료 (누적입고수량 vs 요청수량으로 세분화;
//                                아직 입고 전(누적입고수량 <= 0)이면 구매완료로 표시)
//   7) 재고사용(O,X) = X       → 구매대기 (자재담당자가 "구매필요"를 눌렀지만 아직 구매요청번호 미등록)
//   8) 그 외(공란)             → 재고확인중
// category는 상단 건수 필터가 사용하는 그룹 키로, status와 항상 같은 값이다(건마다 정확히 하나의
// 상태/집계 칸에만 속한다).
function computeInboundStatus_(po) {
  const stockUse = String(po['재고사용(O,X)'] || '').trim();
  const stockUseUpper = stockUse.toUpperCase();
  const purchaseReqNo = String(po['구매요청번호'] || '').trim();
  const requested = Number(po['요청수량']) || 0;
  const cumulative = Number(po['누적입고수량']) || 0;

  if (isOutboundDoneRow_(po)) return { status: '출고완료', category: '출고완료' };
  if (isOutboundPartialRow_(po)) return { status: '부분출고', category: '부분출고' };
  if (stockUse === '취소') return { status: '취소', category: '취소' };
  if (stockUse === '보류') return { status: '구매보류', category: '구매보류' };
  if (stockUseUpper === 'O') return { status: '재고사용', category: '재고사용' };
  if (purchaseReqNo) {
    const status = cumulative <= 0 ? '구매완료' : (cumulative < requested ? '부분입고' : '입고완료');
    return { status, category: status };
  }
  if (stockUseUpper === 'X') return { status: '구매대기', category: '구매대기' };
  return { status: '재고확인중', category: '재고확인중' };
}

// stockMap/pendingMap을 넘기면(여러 행을 한 번에 변환하는 checkInbound_) 그 맵에서 값을 찾고,
// 넘기지 않으면(관리 버튼 처리 후 행 하나만 반환하는 경우) 시트를 직접 조회해 계산한다.
function poRowToInboundView_(site, po, stockMap, pendingMap) {
  const requested = Number(po['요청수량']) || 0;
  const cumulative = Number(po['누적입고수량']) || 0;
  const shipped = Number(po['누적출고수량']) || 0;
  const info = computeInboundStatus_(po);
  const itemId = po['자재코드'] || '';
  const stockQty = stockMap ? (stockMap[String(itemId)] || 0) : getStockQty_(site, itemId);
  const pendingQty = pendingMap ? (pendingMap[String(itemId)] || 0) : getPendingInboundQty_(site, itemId);
  return {
    rowIndex: po._row,
    requestDate: po['요청일자'] || '',
    requester: po['신청자'] || '',
    zone: po['라인'] || '',
    itemId: itemId,
    itemName: po['자재명'] || '',
    spec: po['규격'] || '',
    requestedQty: requested,
    stockQty: stockQty,
    pendingQty: pendingQty,
    cumulativeQty: cumulative,
    remainingQty: requested - cumulative,
    shippedQty: shipped,
    remainingShipQty: requested - shipped,
    dueDate: po['필요일자'] || '',
    status: info.status,
    category: info.category,
    stockUse: po['재고사용(O,X)'] || '',
    outboundDone: isOutboundDoneRow_(po),
    outboundPartial: isOutboundPartialRow_(po),
    note: po['비고'] || '',
    note1: po['특이사항1'] || '',
    note2: po['특이사항2'] || '',
    lineOrderNo: po['라인구매번호'] || '',
    purchaseReqNo: po['구매요청번호'] || '',
    lastInboundDate: po['최종입고일'] || '',
    lastOutboundDate: po['최종출고일'] || ''
  };
}

// 입고대기 합산 대상 여부: 구매요청번호가 등록되어(=실제로 구매가 진행되어) 구매완료로
// 넘어간 건 중에서도 아직 입고가 끝나지 않은(구매완료/부분입고) 건만 대상으로 한다.
// 재고확인중/구매대기(구매요청번호 미등록)·재고사용·구매보류·취소·출고완료 건은 제외된다 —
// computeInboundStatus_()가 화면에 보여주는 status와 정확히 같은 정의를 그대로 사용한다.
function isPendingInboundRow_(r) {
  const info = computeInboundStatus_(r);
  return info.status === '구매완료' || info.status === '부분입고';
}

// 같은 자재코드의 구매완료/부분입고 건들의 (요청수량 - 누적입고수량)을 모두 합산해,
// 자재코드별 "입고대기 수량" 맵을 만든다 (입고확인 화면 카드에 재고수량과 함께 표시).
function buildPendingInboundMap_(rows) {
  const map = {};
  rows.forEach(r => {
    if (!isPendingInboundRow_(r)) return;
    const itemId = String(r['자재코드'] || '');
    if (!itemId) return;
    const requested = Number(r['요청수량']) || 0;
    const cumulative = Number(r['누적입고수량']) || 0;
    map[itemId] = (map[itemId] || 0) + Math.max(0, requested - cumulative);
  });
  return map;
}

// buildPendingInboundMap_을 행 하나짜리 조회(관리 버튼 처리 직후 등)에서 재사용하기 위한 헬퍼.
function getPendingInboundQty_(site, itemId) {
  const rows = readAll_(sheet_(poInSheetName_(site)));
  return buildPendingInboundMap_(rows)[String(itemId)] || 0;
}

// 사이트 재고 시트에서 자재 하나의 현재고를 조회한다 (입고확인 화면의 "재고수량" 표시용).
function getStockQty_(site, itemId) {
  const row = readAll_(sheet_(stockSheetName_(site))).find(s => String(s['자재코드']) === String(itemId));
  return row ? Number(row['현재고']) || 0 : 0;
}

// 사이트 재고 시트를 한 번만 읽어 자재코드 → 현재고 맵을 만든다 (checkInbound_처럼 여러 행을
// 한꺼번에 변환할 때 행마다 재고 시트를 다시 읽지 않도록 하기 위함).
function buildStockMap_(site) {
  const map = {};
  readAll_(sheet_(stockSheetName_(site))).forEach(s => {
    map[String(s['자재코드'])] = Number(s['현재고']) || 0;
  });
  return map;
}

// FIFO 입고 처리: 필요일자가 이른 발주부터 순서대로 입고수량을 채워나간다.
// 한 발주의 잔여수량을 채우고도 수량이 남으면 다음 발주로 넘어간다.
// 모든 미완료 발주를 다 채우고도 남는 수량은 unmatchedQty로 반환한다.
// candidates는 호출부에서 미리 조회해 전달한다 (발주 존재 여부를 먼저 검사해야 하므로 중복 조회를 피하기 위함).
function applyFifoReceipt_(site, candidates, qty) {
  const sheet = sheet_(poInSheetName_(site));
  const allocations = [];
  let remaining = qty;

  for (let i = 0; i < candidates.length && remaining > 0; i++) {
    const po = candidates[i];
    const requested = Number(po['요청수량']) || 0;
    const before = Number(po['누적입고수량']) || 0;
    const openQty = requested - before;
    if (openQty <= 0) continue;

    const applied = Math.min(openQty, remaining);
    const cumulative = before + applied;
    const remainingQty = requested - cumulative;
    const status = cumulative <= 0 ? '미입고' : (cumulative < requested ? '부분입고' : '입고완료');

    updateRow_(sheet, po._row, {
      '누적입고수량': cumulative,
      '잔여수량': remainingQty,
      '입고여부': status,
      '최종입고일': Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd')
    });

    allocations.push({
      dueDate: po['필요일자'] || '',
      appliedQty: applied,
      cumulativeQty: cumulative,
      requestedQty: requested,
      remainingQty: remainingQty,
      status
    });

    remaining -= applied;
  }

  return { allocations, unmatchedQty: remaining };
}

// 발주와 매칭되지 않은(또는 모든 발주를 채우고 남은) 입고수량은 별도 행으로 기록한다.
function appendAdhocReceiptRow_(site, item, qty) {
  appendRow_(sheet_(poInSheetName_(site)), {
    '요청일자': '',
    '신청자': '',
    '라인': '',
    'BQMS': '',
    '자재코드': item.ItemID,
    '자재명': item.ItemName,
    '규격': item.Spec || '',
    '필요일자': '',
    '요청수량': qty,
    '현재고수량': '',
    '재고사용(O,X)': '',
    '누적입고수량': qty,
    '잔여수량': 0,
    '입고여부': '입고완료',
    '최종입고일': Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd')
  });
}

// ------------------------- 구매요청(Purchase) -------------------------

// true로 두면 searchMaterials_가 검색어와 일치한 행마다 "어느 필드에서 매칭됐는지"를
// Apps Script 실행 로그(보기 > 실행 기록/로그, 또는 Logger.log 출력)에 남긴다.
// 원인 파악이 끝나면 false로 되돌려 로그를 끄면 된다.
const SEARCH_MATERIALS_DEBUG = true;

// 품명 검색창(query)이 부분 문자열로 비교하는 일반 필드는 이 4개뿐이다 — 비고는
// 검색 대상에서 제외한다. 한글검색 컬럼은
// 쉼표로 여러 값을 담을 수 있고 공백 제거 후 비교해야 해서 별도 로직(matchesHangulField_)으로
// 처리한다. 이 배열을 SSOT로 두고 matchesSearchQuery_/디버그 로그가 함께 사용해, 필드 목록이
// 여러 곳에서 따로 흩어져 실수로 어긋나는 일을 막는다.
const SEARCH_MATERIALS_QUERY_FIELDS_ = ['자재코드', 'BQMS', '품명', '사용설비'];
const SEARCH_MATERIALS_HANGUL_FIELD_ = '한글검색';

// 문자열에서 모든 공백(스페이스/탭 등)을 제거한다. 한글검색 컬럼 비교에서
// "타워램프"와 "타워 램프"를 동일하게 취급하기 위해 사용한다.
function stripSpaces_(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

// 한글검색 컬럼(쉼표로 여러 값 구분)이 검색어 qNoSpace(이미 공백 제거+소문자 처리됨)와
// 부분 일치하는지 검사한다. 각 값도 공백을 제거한 뒤 비교한다.
function matchesHangulField_(r, qNoSpace) {
  const raw = String(r[SEARCH_MATERIALS_HANGUL_FIELD_] || '');
  if (!raw || !qNoSpace) return { matched: false, matchedValue: '' };
  const tokens = raw.split(',').map(t => stripSpaces_(t)).filter(t => t);
  const matchedToken = tokens.find(t => t.toLowerCase().includes(qNoSpace));
  return { matched: !!matchedToken, matchedValue: matchedToken || '' };
}

// 행 하나가 검색어 q(이미 trim+소문자 처리됨)와 일치하는지 검사한다.
// SEARCH_MATERIALS_QUERY_FIELDS_(자재코드/BQMS/품명/사용설비)는 부분 문자열로 비교하고,
// 한글검색 컬럼은 쉼표로 분리한 각 값을 공백 제거 후 부분 일치로 비교한다 — 규격은
// specQuery로 별도 검색(searchMaterials_ 참고)하고, 비고는 어떤 검색창에서도
// 매칭 대상이 아니다.
// SEARCH_MATERIALS_DEBUG가 켜져 있으면 매칭된 행마다 실행 로그(Apps Script 편집기 >
// 실행 기록)에 다음을 남긴다:
//   - 어느 필드(자재코드/BQMS/품명/사용설비/한글검색)에서, 어떤 값으로 매칭됐는지
//   - (참고용) 매칭에 전혀 관여하지 않는 비고 값도 함께 표시해, "매칭 대상이
//     아닌 필드에 우연히 검색어가 들어있어서 헷갈리는 것뿐인지" 눈으로 바로 구분할 수 있게 한다.
function matchesSearchQuery_(site, r, q) {
  const fields = {};
  SEARCH_MATERIALS_QUERY_FIELDS_.forEach(k => { fields[k] = String(r[k] || ''); });
  const matchedFields = SEARCH_MATERIALS_QUERY_FIELDS_.filter(k => fields[k].toLowerCase().includes(q));

  const qNoSpace = stripSpaces_(q).toLowerCase();
  const hangul = matchesHangulField_(r, qNoSpace);
  const matchedFieldNames = hangul.matched ? matchedFields.concat([SEARCH_MATERIALS_HANGUL_FIELD_]) : matchedFields;

  if (matchedFieldNames.length && SEARCH_MATERIALS_DEBUG) {
    const detail = matchedFields.map(k => k + '="' + fields[k] + '"')
      .concat(hangul.matched ? [SEARCH_MATERIALS_HANGUL_FIELD_ + '="' + hangul.matchedValue + '"'] : [])
      .join(', ');
    const note = String(r['비고'] || '');
    Logger.log(
      '[searchMaterials_] site=%s q="%s" row=%s 자재코드=%s → 매칭필드=[%s] %s (참고, 검색대상 아님: 비고="%s")',
      site, q, r._row, fields['자재코드'], matchedFieldNames.join(', '), detail, note
    );
  }

  return matchedFieldNames.length > 0;
}

// 구매요청 화면의 자재 검색. query는 자재코드/BQMS/품명/사용설비/한글검색 중 어디든 부분 문자열로
// 포함되면 매칭되고(대소문자 구분 없음), 한글검색은 쉼표로 구분된 값마다 공백을 제거한 뒤
// 검색어도 공백을 제거해 비교한다(예: "타워램프" = "타워 램프"). specQuery는 규격에서만
// 별도로 부분 문자열 매칭한다.
// 두 검색어를 모두 입력하면 AND 조건으로 둘 다 만족하는 행만 반환한다(예: query="O-RING" +
// specQuery="NW50" → 품명에 O-RING이 있으면서 규격에 NW50이 있는 자재만). 둘 다 비어있으면
// (리스트 진입 직후 등) 사용자재 시트 전체를 반환한다.
function searchMaterials_(site, query, specQuery) {
  assertSite_(site);
  const q = (query || '').toString().trim().toLowerCase();
  const specQ = (specQuery || '').toString().trim().toLowerCase();
  const rows = readAll_(sheet_(usedMaterialsSheetName_(site)));
  const filtered = (q || specQ)
    ? rows.filter(r => {
        const mainOk = !q || matchesSearchQuery_(site, r, q);
        const spec = String(r['규격'] || '');
        const specOk = !specQ || spec.toLowerCase().includes(specQ);
        if (specQ && specOk && SEARCH_MATERIALS_DEBUG) {
          Logger.log(
            '[searchMaterials_] site=%s specQuery="%s" row=%s 자재코드=%s → 규격 매칭 규격="%s"',
            site, specQ, r._row, r['자재코드'] || '', spec
          );
        }
        return mainOk && specOk;
      })
    : rows;
  return filtered.map(r => ({
    itemId: r['자재코드'] || '',
    bqms: r['BQMS'] || '',
    itemName: r['품명'] || '',
    spec: r['규격'] || '',
    equipment: r['사용설비'] || '',
    note: r['비고'] || ''
  }));
}

// 구매 화면 사진보기용: 지정된 Drive 폴더에서 "자재코드.jpg" → "자재코드.jpeg" → "자재코드.png"
// 순서로 파일을 찾아, 썸네일 URL(thumbnail?id=...&sz=w400)을 반환한다. 파일이 없으면 null(오류 아님).
// DriveApp.getFolderById()/getFilesByName() 호출 자체가 실패하면(권한 문제, 잘못된 폴더 ID 등)
// 원인을 구분할 수 있는 메시지로 다시 던진다.
function getPhotoUrl_(itemId) {
  if (!itemId) throw new Error('자재코드가 필요합니다.');
  const normalized = String(itemId).trim();

  let folder;
  try {
    folder = DriveApp.getFolderById(MATERIAL_PHOTO_FOLDER_ID);
  } catch (err) {
    throw new Error('사진 폴더에 접근할 수 없습니다 (권한 오류). Drive 폴더 공유 설정을 확인하세요: ' + String(err.message || err));
  }

  const extensions = ['jpg', 'jpeg', 'png'];
  for (let i = 0; i < extensions.length; i++) {
    const fileName = normalized + '.' + extensions[i];
    let files;
    try {
      files = folder.getFilesByName(fileName);
    } catch (err) {
      throw new Error('사진 파일 조회 중 오류가 발생했습니다: ' + String(err.message || err));
    }
    if (files.hasNext()) {
      const file = files.next();
      return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w400';
    }
  }
  return null; // jpg/jpeg/png 모두 없음 = 등록된 사진 없음 (오류 아님)
}

// 구매요청 완료: 장바구니에 담긴 자재마다 "_구매발주및입고" 시트에 새 행을 하나씩 등록한다.
// 요청일자는 오늘 날짜, 신청자는 로그인한 사용자, 현재고수량은 그 시점 재고 시트 스냅샷으로
// 자동 채워지고, 재고사용(O,X)/누적입고수량은 비워둔 채(입고여부는 '미입고') 등록해
// 자재담당자가 이후 재고사용(O,X) 여부를 확인하고 실제 입고를 FIFO로 매칭하게 한다.
function submitPurchase_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const zone = assertZone_(site, body.zone);
    const worker = handleLogin_(body.pin);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new Error('담긴 자재가 없습니다.');

    const requiredDate = body.requiredDate || '';
    const note1 = String(body.note1 || '').trim();
    const note2 = String(body.note2 || '').trim();
    const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

    const stockRows = readAll_(sheet_(stockSheetName_(site)));
    const stockMap = {};
    stockRows.forEach(s => { stockMap[String(s['자재코드'])] = Number(s['현재고']) || 0; });

    const sheet = sheet_(poInSheetName_(site));
    const lineOrderNo = generateLineOrderNo_(site);
    let count = 0;
    items.forEach(it => {
      const qty = Number(it.quantity);
      if (!qty || qty <= 0) return;
      const itemName = it.itemName || '';

      // 세트(품명이 "***"로 시작): 묶음자재 시트에서 구성 자재를 찾아, 세트 수량 × 구성 수량으로
      // 계산한 요청수량을 각 구성 자재마다 한 행씩 등록한다. 비고에 세트명을 남겨 입고확인
      // 화면에서 같은 세트 주문임을 알아볼 수 있게 한다.
      if (isSetItemName_(itemName)) {
        const components = findBundleComponents_(site, itemName);
        if (!components.length) throw new Error('세트 구성을 찾을 수 없습니다: ' + itemName);

        components.forEach(comp => {
          const compItemId = String(comp['자재코드'] || '').trim();
          const compQty = qty * (Number(comp['수량']) || 0);
          if (!compItemId || compQty <= 0) return;

          registerNewItemIfMissing_(compItemId, comp['품명'] || '', comp['규격'] || '');

          appendRow_(sheet, {
            '요청일자': today,
            '신청자': worker.name,
            '라인': zone,
            'BQMS': comp['BQMS'] || '',
            '자재코드': compItemId,
            '자재명': comp['품명'] || '',
            '규격': comp['규격'] || '',
            '필요일자': requiredDate,
            '요청수량': compQty,
            '현재고수량': stockMap[compItemId] !== undefined ? stockMap[compItemId] : 0,
            '재고사용(O,X)': '',
            '누적입고수량': '',
            '잔여수량': compQty,
            '입고여부': '미입고',
            '최종입고일': '',
            '라인구매번호': lineOrderNo,
            '비고': '[세트: ' + itemName + ']',
            '특이사항1': note1,
            '특이사항2': note2
          });
          count++;
        });
        return;
      }

      const itemId = String(it.itemId || '').trim();
      if (!itemId) return;

      registerNewItemIfMissing_(itemId, itemName, it.spec || '');

      appendRow_(sheet, {
        '요청일자': today,
        '신청자': worker.name,
        '라인': zone,
        'BQMS': it.bqms || '',
        '자재코드': itemId,
        '자재명': itemName,
        '규격': it.spec || '',
        '필요일자': requiredDate,
        '요청수량': qty,
        '현재고수량': stockMap[itemId] !== undefined ? stockMap[itemId] : 0,
        '재고사용(O,X)': '',
        '누적입고수량': '',
        '잔여수량': qty,
        '입고여부': '미입고',
        '최종입고일': '',
        '라인구매번호': lineOrderNo,
        '특이사항1': note1,
        '특이사항2': note2
      });
      count++;
    });

    if (!count) throw new Error('등록할 수 있는 자재가 없습니다 (자재코드/수량을 확인하세요).');
    return { count, lineOrderNo };
  } finally {
    lock.releaseLock();
  }
}

// 건별 출고 화면: 라인구매번호로 구매발주및입고 시트에서 해당 건에 속한 자재 목록을 조회한다.
function getPurchaseByLineOrderNo_(site, orderNo) {
  assertSite_(site);
  const no = String(orderNo || '').trim();
  if (!no) throw new Error('라인구매번호를 입력하세요.');

  const rows = readAll_(sheet_(poInSheetName_(site)));
  const matched = rows.filter(r => String(r['라인구매번호'] || '').trim() === no);
  if (!matched.length) throw new Error('해당 라인구매번호의 구매 내역을 찾을 수 없습니다: ' + no);

  return matched.map(r => ({
    itemId: r['자재코드'] || '',
    bqms: r['BQMS'] || '',
    itemName: r['자재명'] || '',
    spec: r['규격'] || '',
    zone: r['라인'] || '',
    requestedQty: Number(r['요청수량']) || 0,
    receivedQty: Number(r['누적입고수량']) || 0,
    remainingQty: Number(r['잔여수량']) || 0,
    inboundStatus: r['입고여부'] || ''
  }));
}

// 구매요청에 담긴 자재코드가 Items 시트(전체 자재 마스터)에 없으면 자동으로 등록하고
// 신규여부에 '★신규' 표시를 남긴다. 이미 등록된 자재는 그대로 둔다(신규여부도 건드리지 않음).
function registerNewItemIfMissing_(itemId, itemName, spec) {
  const sheet = sheet_('Items');
  const existing = readAll_(sheet).find(it => String(it.ItemID) === String(itemId));
  if (existing) return;

  appendRow_(sheet, {
    ItemID: itemId,
    ItemName: itemName,
    Spec: spec,
    Unit: '',
    Category: '',
    CreatedAt: new Date(),
    '신규여부': '★신규'
  });
}

// 입고확인 화면에서 아직 확정되지 않은 구매 요청을 취소한다. 취소 가능 범위는 역할에 따라 다르다:
//  - 신청자 본인(라인담당자/작업자 등 비관리자): 재고확인중 상태의 본인 신청 건만 취소 가능.
//    재고사용/구매필요(구매대기)/구매완료로 넘어간 건은 이미 절차가 진행된 것으로 보고 막는다.
//  - Role이 자재담당자/관리자인 사용자: 재고확인중/재고사용/구매필요(구매대기) 건까지 취소 가능.
//    구매완료(구매요청번호 등록, 구매완료/부분입고/입고완료)·출고완료로 넘어간 건은 취소를 막는다.
function cancelPurchase_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const row = findPoRowByIndex_(site, body.rowIndex);
    const user = handleLogin_(body.pin);

    const isOwner = String(row['신청자'] || '').trim() === String(user.name || '').trim();
    const isManager = MANAGER_ROLES.indexOf(user.role) !== -1;
    const info = computeInboundStatus_(row);

    if (isManager) {
      if (info.status !== '재고확인중' && info.status !== '구매대기' && info.status !== '재고사용') {
        throw new Error('재고확인중, 구매필요 또는 재고사용 상태에서만 취소할 수 있습니다.');
      }
    } else if (isOwner) {
      if (info.status !== '재고확인중') {
        throw new Error('재고확인중 상태의 본인 신청 건만 취소할 수 있습니다.');
      }
    } else {
      throw new Error('취소 권한이 없습니다. 신청자 본인 또는 자재담당자/관리자만 취소할 수 있습니다.');
    }

    updateRow_(sheet_(poInSheetName_(site)), row._row, { '재고사용(O,X)': '취소' });
    return poRowToInboundView_(site, findPoRowByIndex_(site, body.rowIndex));
  } finally {
    lock.releaseLock();
  }
}

// 입고확인 화면의 "수량 변경" 버튼: 구매요청번호가 아직 등록되지 않아 실제 구매/입고가
// 시작되지 않은(재고확인중/구매대기) 요청에 한해 요청수량 자체를 고친다. 신청자 본인 또는
// 자재담당자/관리자만 바꿀 수 있다(cancelPurchase_와 동일한 권한 패턴).
function updateRequestedQty_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const row = findPoRowByIndex_(site, body.rowIndex);
    const user = handleLogin_(body.pin);

    const isOwner = String(row['신청자'] || '').trim() === String(user.name || '').trim();
    const isManager = MANAGER_ROLES.indexOf(user.role) !== -1;
    if (!isOwner && !isManager) {
      throw new Error('수량 변경 권한이 없습니다. 신청자 본인 또는 자재담당자/관리자만 변경할 수 있습니다.');
    }

    const info = computeInboundStatus_(row);
    if (info.status !== '재고확인중' && info.status !== '구매대기') {
      throw new Error('재고확인중 또는 구매대기 상태에서만 수량을 변경할 수 있습니다.');
    }

    const qty = Number(body.quantity);
    if (!qty || qty <= 0) throw new Error('올바른 수량을 입력하세요.');

    updateRow_(sheet_(poInSheetName_(site)), row._row, { '요청수량': qty });
    return poRowToInboundView_(site, findPoRowByIndex_(site, body.rowIndex));
  } finally {
    lock.releaseLock();
  }
}

// rowIndex(시트 행 번호)로 구매발주및입고 시트의 행 하나를 찾는다. 입고확인 화면의 관리 버튼들이 공통으로 사용한다.
function findPoRowByIndex_(site, rowIndex) {
  const sheet = sheet_(poInSheetName_(site));
  const idx = Number(rowIndex);
  if (!idx || idx < 2) throw new Error('요청을 찾을 수 없습니다.');
  if (idx > sheet.getLastRow()) throw new Error('요청을 찾을 수 없습니다.');
  const row = readAll_(sheet).find(r => r._row === idx);
  if (!row) throw new Error('요청을 찾을 수 없습니다.');
  return row;
}

// 입고확인 화면의 "재고사용"/"구매필요"/"구매보류" 버튼: 재고사용(O,X) 컬럼에 O, X 또는 보류를 표시한다.
function updateStockUsage_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    assertManagerRole_(body.pin);
    const raw = String(body.value || '').trim();
    const value = raw === '보류' ? raw : raw.toUpperCase();
    if (value !== 'O' && value !== 'X' && value !== '보류') throw new Error('올바르지 않은 값입니다.');

    const row = findPoRowByIndex_(site, body.rowIndex);
    const info = computeInboundStatus_(row);
    if (STOCK_USAGE_LOCKED_STATUSES.indexOf(info.status) !== -1) {
      throw new Error('구매완료 이후에는 재고사용/구매필요/구매보류를 변경할 수 없습니다.');
    }

    updateRow_(sheet_(poInSheetName_(site)), row._row, { '재고사용(O,X)': value });
    return poRowToInboundView_(site, findPoRowByIndex_(site, body.rowIndex));
  } finally {
    lock.releaseLock();
  }
}

// 입고확인 화면의 "입고" 버튼: 팝업으로 입력받은 수량을 그 구매요청 행 하나에 직접 누적한다.
// (QR 스캔 입고(stockIn_)와 달리 여러 발주에 FIFO로 나눠 채우지 않고, 화면에 보이는 그 요청 건에만 반영한다.)
// 구매완료(구매요청번호 등록) 상태 중 구매완료/부분입고 건에서만 처리할 수 있다 — 재고확인중/구매대기/
// 재고사용/입고완료/부분출고/출고완료는 모두 막는다(입고 버튼 활성화 조건과 동일하게 서버에서도 검증).
function inboundByManager_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    assertManagerRole_(body.pin);
    let qty = Number(body.quantity);
    if (!qty || qty <= 0) throw new Error('입고 수량은 0보다 커야 합니다.');

    const row = findPoRowByIndex_(site, body.rowIndex);
    const info = computeInboundStatus_(row);
    if (info.status !== '구매완료' && info.status !== '부분입고') {
      throw new Error('구매완료(구매완료/부분입고) 상태에서만 입고 처리할 수 있습니다.');
    }

    const requested = Number(row['요청수량']) || 0;
    const before = Number(row['누적입고수량']) || 0;
    const maxQty = Math.max(0, requested - before);
    if (qty > maxQty) qty = maxQty;
    if (qty <= 0) throw new Error('입고 가능한 수량이 없습니다.');

    const cumulative = before + qty;
    const remaining = Math.max(0, requested - cumulative);
    const status = cumulative <= 0 ? '미입고' : (cumulative < requested ? '부분입고' : '입고완료');

    updateRow_(sheet_(poInSheetName_(site)), row._row, {
      '누적입고수량': cumulative,
      '잔여수량': remaining,
      '입고여부': status,
      '최종입고일': Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd')
    });

    const item = assertItemExists_(row['자재코드']);
    recalculateStock_(site, row['자재코드'], item);

    return poRowToInboundView_(site, findPoRowByIndex_(site, body.rowIndex));
  } finally {
    lock.releaseLock();
  }
}

// 입고확인 화면의 "출고완료" 버튼: 재고사용(O) 또는 입고완료 상태인 요청을 그 라인으로 출고 처리한다.
// 입력받은 수량만큼만 그 행의 누적출고수량에 더하고(선입선출로 다른 행을 건드리지 않음),
// 누적출고수량과 요청수량을 비교해 출고여부를 부분출고/출고완료로 자동 판정한다.
// 출고 시트에도 이번에 출고한 수량만큼 한 줄을 기록한다(라인구매번호 포함, 추후 QR 출고 연동용).
function outboundComplete_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const worker = assertManagerRole_(body.pin);
    const row = findPoRowByIndex_(site, body.rowIndex);

    if (isOutboundDoneRow_(row)) throw new Error('이미 출고완료 처리된 요청입니다.');

    const stockUse = String(row['재고사용(O,X)'] || '').trim().toUpperCase();
    const requested = Number(row['요청수량']) || 0;
    const cumulativeIn = Number(row['누적입고수량']) || 0;
    const isInboundDone = requested > 0 && cumulativeIn >= requested;
    if (stockUse !== 'O' && !isInboundDone) {
      throw new Error('재고사용 또는 입고완료 상태에서만 출고완료 처리할 수 있습니다.');
    }

    const qty = Number(body.quantity);
    if (!qty || qty <= 0) throw new Error('출고 수량은 0보다 커야 합니다.');

    const itemId = row['자재코드'];
    let item;
    try {
      item = assertItemExists_(itemId);
    } catch (err) {
      // Items 시트에서 삭제된 자재라도, 구매발주및입고 행에 남아있는 자재명/규격으로 출고 기록은 남긴다.
      item = { ItemID: itemId, ItemName: row['자재명'] || '', Spec: row['규격'] || '', Unit: '' };
    }

    const current = getStockQty_(site, itemId);
    if (current <= 0) {
      throw new Error(`재고가 없어 출고할 수 없습니다. (현재 재고 0${item.Unit || ''})`);
    }

    // 재고수량이 입력한 출고수량보다 적으면, 요청수량 전체가 아니라 실제 재고수량만큼만
    // 부분 출고 처리한다(재고수량 >= 출고수량이면 그대로, 재고수량 < 출고수량이면 재고수량만큼).
    const actualQty = Math.min(qty, current);

    logTransaction_(site, {
      itemId, itemName: item.ItemName, spec: item.Spec, unit: item.Unit,
      zone: row['라인'] || '', quantity: actualQty, worker: worker.name,
      lineOrderNo: row['라인구매번호'] || ''
    });

    decrementStockQuantity_(site, itemId, actualQty, item);

    const shippedBefore = Number(row['누적출고수량']) || 0;
    const shippedCumulative = shippedBefore + actualQty;
    const outboundStatus = shippedCumulative <= 0 ? '' : (shippedCumulative < requested ? '부분출고' : '출고완료');

    updateRow_(sheet_(poInSheetName_(site)), row._row, {
      '누적출고수량': shippedCumulative,
      '출고여부': outboundStatus,
      '최종출고일': Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd')
    });

    const updatedView = poRowToInboundView_(site, findPoRowByIndex_(site, body.rowIndex));
    updatedView.shippedNow = actualQty;
    updatedView.requestedNow = qty;
    return updatedView;
  } finally {
    lock.releaseLock();
  }
}

// 입고확인 화면의 "수정" 버튼: 입고완료/출고완료로 이미 확정된 건의 수량을 당일에 한해 고친다.
// 대상 컬럼은 현재 상태(computeInboundStatus_)로 판단한다 — 입고완료면 누적입고수량, 출고완료면
// 누적출고수량. 두 상태는 서로 배타적으로만 표시되므로(출고완료가 입고완료보다 우선 판정됨)
// 카드에 뜬 상태와 항상 일치한다. 입력값은 요청수량을 넘지 않게 자르고(잔여수량이 마이너스가
// 되지 않도록), 저장 후 입고여부/출고여부를 새 수량 기준으로 다시 계산한다. 재고 시트 현재고
// 반영 방식은 입고/출고가 서로 다르다(각 분기 주석 참고).
function editInboundQty_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    assertManagerRole_(body.pin);
    const row = findPoRowByIndex_(site, body.rowIndex);
    const info = computeInboundStatus_(row);
    const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    const requested = Number(row['요청수량']) || 0;

    let qty = Number(body.quantity);
    if (body.quantity === '' || body.quantity == null || isNaN(qty) || qty < 0) {
      throw new Error('올바른 수량을 입력하세요.');
    }
    if (qty > requested) qty = requested;
    const item = assertItemExists_(row['자재코드']);

    if (info.status === '입고완료') {
      const lastDate = String(row['최종입고일'] || '').trim();
      if (lastDate !== today) throw new Error('당일 건만 수정 가능합니다.');
      const remaining = Math.max(0, requested - qty);
      const status = qty <= 0 ? '미입고' : (qty < requested ? '부분입고' : '입고완료');
      updateRow_(sheet_(poInSheetName_(site)), row._row, {
        '누적입고수량': qty,
        '잔여수량': remaining,
        '입고여부': status
      });
      // 현재고 = 월초재고 + 모든 발주 행의 누적입고수량 합계이므로(calculateCurrentStock_),
      // 이 행의 누적입고수량만 고치면 전체 재계산으로 정확히 반영된다.
      recalculateStock_(site, row['자재코드'], item);
    } else if (info.status === '출고완료') {
      const lastDate = String(row['최종출고일'] || '').trim();
      if (lastDate !== today) throw new Error('당일 건만 수정 가능합니다.');
      const outboundStatus = qty <= 0 ? '' : (qty < requested ? '부분출고' : '출고완료');
      const shippedBefore = Number(row['누적출고수량']) || 0;
      updateRow_(sheet_(poInSheetName_(site)), row._row, {
        '누적출고수량': qty,
        '출고여부': outboundStatus
      });
      // 출고 현재고는 (출고완료 처리 때와 마찬가지로) 출고 이력 전체를 다시 합산하지 않고 직접
      // 증감한다 — 출고 이력은 별도 출고 시트에 개별 거래로 남아 있어 이 행 하나의 수정으로
      // 되돌릴 수 없으므로, 수정 전후 수량 차이(delta)만큼만 현재고에서 추가로 빼거나 되돌린다.
      const delta = qty - shippedBefore;
      decrementStockQuantity_(site, row['자재코드'], delta, item);
    } else {
      throw new Error('입고완료 또는 출고완료 상태에서만 수정할 수 있습니다.');
    }

    return poRowToInboundView_(site, findPoRowByIndex_(site, body.rowIndex));
  } finally {
    lock.releaseLock();
  }
}

// ------------------------- 입고 / 출고 -------------------------

function stockIn_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const { itemId, quantity, pin } = body;
    const qty = Number(quantity);
    if (!qty || qty <= 0) throw new Error('입고 수량은 0보다 커야 합니다.');
    const item = assertItemExists_(itemId);
    handleLogin_(pin);

    // 발주 이력이 전혀 없는 자재는 입고를 막는다 (프런트엔드에서도 막지만, 서버에서도 한 번 더 검증).
    const openPos = findOpenPurchaseOrders_(site, itemId);
    if (!openPos.length) {
      throw new Error('발주 이력이 없습니다. 입고할 수 없습니다.');
    }

    // 필요일자가 이른 발주부터 FIFO로 입고수량을 채운다. 모든 미완료 발주를 채우고도
    // 남는 수량(예: 발주 수량보다 많이 입고)은 별도 행으로 기록한다.
    const fifoResult = applyFifoReceipt_(site, openPos, qty);
    if (fifoResult.unmatchedQty > 0) {
      appendAdhocReceiptRow_(site, item, fifoResult.unmatchedQty);
    }

    // 구매발주및입고/출고 원본 데이터로부터 현재고를 다시 계산해 재고 시트에 반영한다.
    const newQty = recalculateStock_(site, itemId, item);

    return {
      newQuantity: newQty,
      allocations: fifoResult.allocations,
      unmatchedQty: fifoResult.unmatchedQty
    };
  } finally {
    lock.releaseLock();
  }
}

// QR 스캔 출고 전용 선입선출 장부 처리. 실제 재고 차감은 stockOut_이 (건별로 나눠) 기록하는
// 출고 행들의 합으로 이루어지므로, 여기서는 구매발주및입고 시트의 누적출고수량/출고여부/최종출고일만
// 갱신하고, 각 건에서 얼마나 차감했는지(라인구매번호 + 차감수량)를 배열로 돌려준다 — 호출부가 그
// 배열을 그대로 출고 시트에 건별 행으로 나눠 기록한다.
// 같은 자재코드 + 같은 라인(zone)의 행만 대상으로 하며(다른 라인 구매 건은 건드리지 않음),
// 취소 건은 제외하고, 입고완료/부분입고(누적입고수량 > 0) 또는 재고사용(O) 건을 모두 대상에 포함한다
// (재고사용(O) 건은 실제 입고를 받지 않으므로 최종입고일로는 걸러낼 수 없다).
// 요청일자 오름차순(오래된 건부터)으로 스캔 수량이 남는 동안 순서대로 채운다.
function applyLineFifoOutboundBookkeeping_(site, itemId, zone, qty) {
  const sheet = sheet_(poInSheetName_(site));
  const rows = readAll_(sheet).filter(r => {
    if (String(r['자재코드']) !== String(itemId)) return false;
    if (String(r['라인'] || '').trim() !== String(zone).trim()) return false;
    if (isCancelledRow_(r)) return false;
    const cumulativeIn = Number(r['누적입고수량']) || 0;
    return isStockCoveredRow_(r) || cumulativeIn > 0;
  });
  rows.sort((a, b) => {
    const da = a['요청일자'] ? new Date(a['요청일자']).getTime() : Infinity;
    const db = b['요청일자'] ? new Date(b['요청일자']).getTime() : Infinity;
    if (da !== db) return da - db;
    return (a._row || 0) - (b._row || 0);
  });

  const allocations = [];
  let remaining = qty;
  for (let i = 0; i < rows.length && remaining > 0; i++) {
    const po = rows[i];
    const requested = Number(po['요청수량']) || 0;
    const before = Number(po['누적출고수량']) || 0;
    const openQty = requested - before;
    if (openQty <= 0) continue;

    const applied = Math.min(openQty, remaining);
    const cumulative = before + applied;
    const status = cumulative < requested ? '부분출고' : '출고완료';

    updateRow_(sheet, po._row, {
      '누적출고수량': cumulative,
      '출고여부': status,
      '최종출고일': Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd')
    });

    allocations.push({ lineOrderNo: po['라인구매번호'] || '', appliedQty: applied });
    remaining -= applied;
  }
  return allocations;
}

// QR 스캔 출고: 같은 자재+라인의 구매요청 건들을 선입선출로 매칭해 각 건의 누적출고수량/출고여부를
// 갱신하고, 매칭된 건별로 출고 시트에 행을 나눠 기록한다(라인구매번호 포함, 건별 이력 추적용).
function stockOut_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const zone = assertZone_(site, body.zone);
    const { itemId, quantity, pin } = body;
    const qty = Number(quantity);
    if (!qty || qty <= 0) throw new Error('출고 수량은 0보다 커야 합니다.');
    const item = assertItemExists_(itemId);
    const worker = handleLogin_(pin);

    const current = getStockQty_(site, itemId);
    if (current < qty) throw new Error(`재고 부족: 현재고 ${current}${item.Unit || ''}, 출고 요청 ${qty}${item.Unit || ''}`);

    // 스캔한 수량만큼, 같은 자재+라인의 구매요청 건들을 선입선출로 "출고됨" 처리하고(구매발주및입고
    // 시트의 누적출고수량/출고여부 갱신), 각 건에서 차감된 수량(+라인구매번호)을 돌려받는다.
    const allocations = applyLineFifoOutboundBookkeeping_(site, itemId, zone, qty);

    // 건별로 매칭된 수량만큼 출고 시트에 행을 나눠 기록한다(예: 10개 출고가 두 건에서
    // 6개/4개로 나뉘어 차감됐다면 출고 시트에도 두 줄로 남긴다).
    let remaining = qty;
    allocations.forEach((a) => {
      logTransaction_(site, {
        itemId, itemName: item.ItemName, spec: item.Spec, unit: item.Unit, zone,
        quantity: a.appliedQty, worker: worker.name, lineOrderNo: a.lineOrderNo
      });
      remaining -= a.appliedQty;
    });
    // 어떤 구매요청 건에도 매칭되지 않은 나머지(예: 구매요청 없이 재고만 있는 자재)는
    // 라인구매번호 없이 한 줄로 기록한다.
    if (remaining > 0) {
      logTransaction_(site, {
        itemId, itemName: item.ItemName, spec: item.Spec, unit: item.Unit, zone,
        quantity: remaining, worker: worker.name
      });
    }

    // 방금 기록한 출고수량만큼 재고 시트의 현재고를 직접 차감한다.
    const newQty = decrementStockQuantity_(site, itemId, qty, item);

    return { newQuantity: newQty };
  } finally {
    lock.releaseLock();
  }
}

// 건별 출고: 라인구매번호로 조회한 여러 자재를 한 번에 출고 처리한다 (건 하나당 락 1회).
function stockOutByOrder_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const zone = assertZone_(site, body.zone);
    const worker = handleLogin_(body.pin);
    const orderNo = String(body.orderNo || '').trim();
    if (!orderNo) throw new Error('라인구매번호가 없습니다.');
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new Error('출고할 자재가 없습니다.');

    let count = 0;
    items.forEach(it => {
      const itemId = String(it.itemId || '').trim();
      const qty = Number(it.quantity);
      if (!itemId || !qty || qty <= 0) return;
      const item = assertItemExists_(itemId);

      const current = getStockQty_(site, itemId);
      if (current < qty) {
        throw new Error(`재고 부족: ${item.ItemName}(${itemId}) 현재고 ${current}${item.Unit || ''}, 출고 요청 ${qty}${item.Unit || ''}`);
      }

      logTransaction_(site, {
        itemId, itemName: item.ItemName, spec: item.Spec, unit: item.Unit, zone,
        quantity: qty, worker: worker.name
      });
      decrementStockQuantity_(site, itemId, qty, item);
      count++;
    });

    if (!count) throw new Error('올바른 출고 항목이 없습니다.');
    return { count, orderNo };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------- 반납 -------------------------

// 이미 출고되었던 자재를 재고로 되돌린다. 발주/라인 개념이 없어 장바구니에 담긴 자재마다
// 반납 시트에 한 줄씩 기록하고, 입고/출고와 동일하게 원본 데이터로부터 현재고를 다시 계산해 반영한다.
function stockReturn_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const worker = handleLogin_(body.pin);
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new Error('반납할 자재가 없습니다.');

    const sheet = sheet_(returnSheetName_(site));
    const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    let count = 0;

    items.forEach(it => {
      const itemId = String(it.itemId || '').trim();
      const qty = Number(it.quantity);
      if (!itemId || !qty || qty <= 0) return;
      const item = assertItemExists_(itemId);

      appendRow_(sheet, {
        '반납일자': today,
        '자재코드': itemId,
        '자재명': item.ItemName,
        '규격': item.Spec || '',
        '반납수량': qty,
        '담당자': worker.name,
        '비고': it.note || ''
      });

      recalculateStock_(site, itemId, item);
      count++;
    });

    if (!count) throw new Error('올바른 반납 항목이 없습니다.');
    return { count };
  } finally {
    lock.releaseLock();
  }
}

// 자재코드로 해당 사이트 사용자재 시트에서 BQMS 값을 조회한다. 못 찾으면 빈 문자열.
function lookupBqmsForItem_(site, itemId) {
  const rows = readAll_(sheet_(usedMaterialsSheetName_(site)));
  const row = rows.find(r => String(r['자재코드']) === String(itemId));
  return row ? (row['BQMS'] || '') : '';
}

// 출고 이력 한 줄을 기록한다 (Setup.gs 헤더와 반드시 일치해야 함).
function logTransaction_(site, t) {
  const sheet = sheet_(txSheetName_(site));
  const txId = 'TX-' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMddHHmmss') + '-' + Math.floor(Math.random() * 900 + 100);
  const now = new Date();
  appendRow_(sheet, {
    '출고일자': Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd'),
    '라인': t.zone || '',
    '자재코드': t.itemId,
    '자재명': t.itemName,
    '규격': t.spec || '',
    '단위': t.unit || '',
    '출고수량': t.quantity,
    '담당자': t.worker,
    '거래코드': txId,
    '시간': Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm:ss'),
    'S/N관리여부': '',
    'BQMS': lookupBqmsForItem_(site, t.itemId),
    'S/N': '',
    '수량': t.quantity,
    '층': '1층',
    '라인구매번호': t.lineOrderNo || ''
  });
}

// 출고 시트도 컬럼명이 한글이라, 이력 화면이 공통으로 쓰는 영문 필드명으로 맞춰준다.
function normalizeOutRow_(r) {
  const dateStr = r['출고일자'] || '';
  const timeStr = r['시간'] || '';
  return {
    _row: r._row,
    Type: 'OUT',
    Timestamp: dateStr ? `${dateStr}T${timeStr || '00:00:00'}` : (timeStr || ''),
    TransactionID: r['거래코드'] || '',
    ItemID: r['자재코드'],
    ItemName: r['자재명'],
    Spec: r['규격'] || '',
    Unit: r['단위'] || '',
    Zone: r['라인'] || '',
    Quantity: r['출고수량'],
    Worker: r['담당자'],
    Note: ''
  };
}

// 입고 시트는 이제 "발주 1건 = 1행"의 누적 상태 시트라 컬럼명이 한글이다.
// 실제 입고가 발생한 적 있는 행(최종입고일이 있는 행)만 이력으로 취급하고,
// 이력 화면이 공통으로 쓰는 영문 필드명으로 맞춰준다. Quantity는 이번 이벤트 수량이 아니라
// 해당 발주의 "누적입고수량" 스냅샷이다 (발주별로 통합 갱신되는 구조라서 개별 이벤트 로그는 없음).
function normalizeInRow_(r) {
  return {
    _row: r._row,
    Type: 'IN',
    Timestamp: r['최종입고일'],
    ItemID: r['자재코드'],
    ItemName: r['자재명'],
    Spec: r['규격'] || '',
    Quantity: r['누적입고수량'],
    Requester: r['신청자'] || '',
    Worker: '',
    Note: '',
    Zone: r['라인'] || '',
    Status: r['입고여부'] || ''
  };
}

function listTransactions_(filter) {
  const site = assertSite_(filter.site);
  let rows;
  if (filter.type === 'IN') {
    rows = readAll_(sheet_(poInSheetName_(site))).filter(r => r['최종입고일']).map(normalizeInRow_);
  } else if (filter.type === 'OUT') {
    rows = readAll_(sheet_(txSheetName_(site))).map(normalizeOutRow_);
  } else {
    const inRows = readAll_(sheet_(poInSheetName_(site))).filter(r => r['최종입고일']).map(normalizeInRow_);
    const outRows = readAll_(sheet_(txSheetName_(site))).map(normalizeOutRow_);
    rows = inRows.concat(outRows);
  }

  if (filter.itemId) rows = rows.filter(r => String(r.ItemID) === String(filter.itemId));

  rows.sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
  const limit = filter.limit || 50;
  return rows.slice(0, limit).map(stripRow_);
}

// ------------------------- 엑셀 다운로드 -------------------------

// 자재코드 → 단위(Unit) 맵 (Items 시트는 사이트 공통, 구매발주및입고 시트에는 단위 컬럼이 없어 여기서 보충한다).
function buildItemUnitMap_() {
  const map = {};
  readAll_(sheet_('Items')).forEach(it => { map[String(it.ItemID)] = it.Unit || ''; });
  return map;
}

// 다운로드 화면 공용: dateField(예: 필요일자/출고일자) 기준으로 시작일~종료일 범위에 드는 행만 남긴다.
// 시작일/종료일이 모두 비어있으면(=기간 조건 없음) 그대로 반환한다.
function filterByDateRange_(rows, dateField, startDate, endDate) {
  const start = toDateOnly_(startDate);
  const end = toDateOnly_(endDate);
  if (!start && !end) return rows;
  return rows.filter(r => {
    const d = toDateOnly_(r[dateField]);
    if (!d) return false;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
}

// 구매 다운로드: 구매발주및입고 시트에서 재고사용(O,X)이 정확히 'X'(=구매필요, 자재담당자가
// 실제로 구매를 넣어야 한다고 확정한 요청)로 표시된 행만 대상으로 한다. 재고사용(O,X)이 공란인
// (아직 재고확인중) 행, 'O'(재고사용), '취소' 행은 모두 제외하고, 구매요청번호가 이미 등록된
// (실제 구매발주로 넘어간) 행도 제외한다.
// 같은 자재코드가 여러 행(다른 신청자/필요일자/라인)에 걸쳐 있으면 요청수량을 합산해 1행으로 합친다.
// 필요일자는 합쳐진 행 중 가장 이른 날짜, 라인은 서로 다른 값이 섞여 있으면 콤마로 나열한다.
function getPurchaseDownload_(site, startDate, endDate, zone) {
  assertSite_(site);
  const zoneQ = (zone || '').toString().trim();
  const unitMap = buildItemUnitMap_();

  let rows = readAll_(sheet_(poInSheetName_(site)));
  rows = rows.filter(r => String(r['재고사용(O,X)'] || '').trim().toUpperCase() === 'X' && !String(r['구매요청번호'] || '').trim());
  if (zoneQ) rows = rows.filter(r => String(r['라인'] || '').trim() === zoneQ);
  rows = filterByDateRange_(rows, '필요일자', startDate, endDate);

  const merged = {};
  rows.forEach(r => {
    const itemId = String(r['자재코드'] || '').trim();
    if (!itemId) return;
    const qty = Number(r['요청수량']) || 0;
    const dueDate = r['필요일자'] || '';
    const lineZone = String(r['라인'] || '').trim();

    if (!merged[itemId]) {
      merged[itemId] = {
        itemId, itemName: r['자재명'] || '', spec: r['규격'] || '',
        unit: unitMap[itemId] || '', dueDate: dueDate, qty: 0, zones: []
      };
    }
    const m = merged[itemId];
    m.qty += qty;
    if (dueDate && (!m.dueDate || new Date(dueDate) < new Date(m.dueDate))) m.dueDate = dueDate;
    if (lineZone && m.zones.indexOf(lineZone) === -1) m.zones.push(lineZone);
  });

  return Object.keys(merged).map(itemId => {
    const m = merged[itemId];
    return {
      itemId: m.itemId,
      itemName: m.itemName,
      spec: m.spec,
      unit: m.unit,
      dueDate: m.dueDate ? Utilities.formatDate(new Date(m.dueDate), 'Asia/Seoul', 'yyyy-MM-dd') : '',
      qty: m.qty,
      zone: m.zones.join(', ')
    };
  });
}

// 출고 다운로드: 출고 시트에서 날짜/라인 조건에 맞는 행을 자재코드별로 합산해 1행으로 만든다.
function getOutboundDownload_(site, startDate, endDate, zone) {
  assertSite_(site);
  const zoneQ = (zone || '').toString().trim();

  let rows = readAll_(sheet_(txSheetName_(site)));
  if (zoneQ) rows = rows.filter(r => String(r['라인'] || '').trim() === zoneQ);
  rows = filterByDateRange_(rows, '출고일자', startDate, endDate);

  const merged = {};
  rows.forEach(r => {
    const itemId = String(r['자재코드'] || '').trim();
    if (!itemId) return;
    const qty = Number(r['출고수량']) || 0;
    const lineZone = String(r['라인'] || '').trim();

    if (!merged[itemId]) {
      merged[itemId] = {
        itemId, itemName: r['자재명'] || '', spec: r['규격'] || '',
        unit: r['단위'] || '', qty: 0, zones: []
      };
    }
    const m = merged[itemId];
    m.qty += qty;
    if (lineZone && m.zones.indexOf(lineZone) === -1) m.zones.push(lineZone);
  });

  return Object.keys(merged).map(itemId => {
    const m = merged[itemId];
    return { itemId: m.itemId, itemName: m.itemName, spec: m.spec, unit: m.unit, qty: m.qty, zone: m.zones.join(', ') };
  });
}

// 거래명세서 다운로드: 출고 시트 원본 그대로(자재코드 중복 합산 없이) BQMS/S-N/수량/라인/층만 뽑는다.
function getTransactionDownload_(site, startDate, endDate, zone) {
  assertSite_(site);
  const zoneQ = (zone || '').toString().trim();

  let rows = readAll_(sheet_(txSheetName_(site)));
  if (zoneQ) rows = rows.filter(r => String(r['라인'] || '').trim() === zoneQ);
  rows = filterByDateRange_(rows, '출고일자', startDate, endDate);

  return rows.map(r => ({
    bqms: r['BQMS'] || '',
    sn: r['S/N'] || '',
    qty: Number(r['수량']) || 0,
    zone: r['라인'] || '',
    floor: r['층'] || ''
  }));
}

// ------------------------- 유지보수(Keep-alive) -------------------------

// 5분마다 실행되는 트리거(Setup.gs의 setupTrigger() 참고)가 호출하는 핑 함수.
// 시트/스프레드시트를 건드리지 않고 로그만 남긴다.
function keepAlive() {
  Logger.log('ping: ' + new Date().toISOString());
}
