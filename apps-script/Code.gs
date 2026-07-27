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
  '기흥': ['K2', 'S3', 'S4', 'Display'],
  '화성': ['H1', 'H2', 'H3', 'H4', 'NRD'],
  '평택': ['P1', 'P2', 'P3', 'P4', 'S5']
};

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
        result = checkInbound_(e.parameter.site || '', e.parameter.name || '', e.parameter.startDate || '', e.parameter.endDate || '');
        break;
      case 'searchMaterials':
        result = searchMaterials_(e.parameter.site || '', e.parameter.query || '');
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
  return sheet;
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

// ------------------------- 사용자 / 로그인 -------------------------

function handleLogin_(pin) {
  if (!pin) throw new Error('PIN을 입력하세요.');
  const users = readAll_(sheet_('Users'));
  const user = users.find(u => String(u.PIN) === String(pin));
  if (!user) throw new Error('PIN이 올바르지 않습니다.');
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
    .map(s => {
      const item = itemMap[String(s['자재코드'])] || {};
      return {
        ItemID: s['자재코드'],
        ItemName: item.ItemName || '(삭제된 자재)',
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

function findOpenPurchaseOrders_(site, itemId) {
  const rows = readAll_(sheet_(poInSheetName_(site)));
  return rows
    .filter(r => String(r['자재코드']) === String(itemId) && r['입고여부'] !== '입고완료' && !isStockCoveredRow_(r) && !isCancelledRow_(r))
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

// 입고확인 화면 전용: 신청자 이름(부분 일치) + 요청일자 범위로 그 사이트의 모든 발주(모든 자재)를 찾는다.
// listOpenPurchaseOrders_와 달리 자재별이 아니라 신청자/날짜 기준 조회이고, 입고완료 건도 포함한다.
// 이름/시작일/종료일은 모두 선택사항이지만 최소 하나는 있어야 한다:
//  - 이름만: 이름으로만 필터
//  - 이름 + 날짜: 이름 AND 요청일자 범위
//  - 날짜만: 요청일자 범위로만 필터 (요청일자가 비어있는 행은 제외)
function checkInbound_(site, name, startDate, endDate) {
  assertSite_(site);
  const q = (name || '').toString().trim();
  const start = toDateOnly_(startDate);
  const end = toDateOnly_(endDate);
  if (!q && !start && !end) throw new Error('신청자 이름 또는 요청일자를 입력하세요.');

  let rows = readAll_(sheet_(poInSheetName_(site)));
  if (q) rows = rows.filter(r => String(r['신청자'] || '').includes(q));
  if (start || end) {
    rows = rows.filter(r => {
      const d = toDateOnly_(r['요청일자']);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }

  return rows.sort(poSortComparator_).map(poRowToInboundView_);
}

function poRowToInboundView_(po) {
  const requested = Number(po['요청수량']) || 0;
  const cumulative = Number(po['누적입고수량']) || 0;
  return {
    rowIndex: po._row,
    requestDate: po['요청일자'] || '',
    requester: po['신청자'] || '',
    zone: po['라인'] || '',
    itemId: po['자재코드'] || '',
    itemName: po['자재명'] || '',
    spec: po['규격'] || '',
    requestedQty: requested,
    cumulativeQty: cumulative,
    remainingQty: requested - cumulative,
    dueDate: po['필요일자'] || '',
    status: po['입고여부'] || (cumulative <= 0 ? '미입고' : (cumulative < requested ? '부분입고' : '입고완료')),
    stockUse: po['재고사용(O,X)'] || ''
  };
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
    '자재코드': item.ItemID,
    'BQMS': '',
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

// 구매요청 화면의 자재 검색. 자재코드/BQMS/품명 중 하나라도 부분 일치하면 반환한다.
// 검색어가 비어있으면(리스트 진입 직후 등) 사용자재 시트 전체를 반환한다.
function searchMaterials_(site, query) {
  assertSite_(site);
  const q = (query || '').toString().trim().toLowerCase();
  const rows = readAll_(sheet_(usedMaterialsSheetName_(site)));
  const filtered = q
    ? rows.filter(r =>
        String(r['자재코드'] || '').toLowerCase().includes(q) ||
        String(r['BQMS'] || '').toLowerCase().includes(q) ||
        String(r['품명'] || '').toLowerCase().includes(q))
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

// 구매 화면 사진보기용: 지정된 Drive 폴더에서 파일명(확장자 제외)이 자재코드와 일치하는
// 파일을 찾아 브라우저에서 바로 열람 가능한 URL을 반환한다. 없으면 null.
// 폴더의 파일이 "링크가 있는 모든 사용자"로 공유되어 있어야 앱(익명 접속)에서 이미지가 보인다.
function getPhotoUrl_(itemId) {
  if (!itemId) throw new Error('자재코드가 필요합니다.');
  const normalized = String(itemId).trim();
  const folder = DriveApp.getFolderById(MATERIAL_PHOTO_FOLDER_ID);
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (fileBaseNameMatches_(file.getName(), normalized)) {
      return 'https://drive.google.com/uc?export=view&id=' + file.getId();
    }
  }
  return null;
}

function fileBaseNameMatches_(fileName, itemId) {
  const base = String(fileName).replace(/\.[^./\\]+$/, '').trim();
  return base.toUpperCase() === itemId.toUpperCase();
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
    const today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

    const stockRows = readAll_(sheet_(stockSheetName_(site)));
    const stockMap = {};
    stockRows.forEach(s => { stockMap[String(s['자재코드'])] = Number(s['현재고']) || 0; });

    const sheet = sheet_(poInSheetName_(site));
    let count = 0;
    items.forEach(it => {
      const itemId = String(it.itemId || '').trim();
      const qty = Number(it.quantity);
      if (!itemId || !qty || qty <= 0) return;

      registerNewItemIfMissing_(itemId, it.itemName || '', it.spec || '');

      appendRow_(sheet, {
        '요청일자': today,
        '신청자': worker.name,
        '라인': zone,
        '자재코드': itemId,
        'BQMS': it.bqms || '',
        '자재명': it.itemName || '',
        '규격': it.spec || '',
        '필요일자': requiredDate,
        '요청수량': qty,
        '현재고수량': stockMap[itemId] !== undefined ? stockMap[itemId] : 0,
        '재고사용(O,X)': '',
        '누적입고수량': '',
        '잔여수량': qty,
        '입고여부': '미입고',
        '최종입고일': ''
      });
      count++;
    });

    if (!count) throw new Error('등록할 수 있는 자재가 없습니다 (자재코드/수량을 확인하세요).');
    return { count };
  } finally {
    lock.releaseLock();
  }
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

// 입고확인 화면에서 아직 처리되지 않은(재고사용(O,X)이 공란인) 구매 요청을 취소한다.
// 자재담당자가 이미 재고사용 여부를 확정한 건(O/X)은 이미 구매가 진행된 것으로 보고 취소를 막는다.
function cancelPurchase_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const rowIndex = Number(body.rowIndex);
    if (!rowIndex || rowIndex < 2) throw new Error('취소할 구매 요청을 찾을 수 없습니다.');

    const sheet = sheet_(poInSheetName_(site));
    if (rowIndex > sheet.getLastRow()) throw new Error('취소할 구매 요청을 찾을 수 없습니다.');

    const row = readAll_(sheet).find(r => r._row === rowIndex);
    if (!row) throw new Error('취소할 구매 요청을 찾을 수 없습니다.');

    const stockUse = String(row['재고사용(O,X)'] || '').trim().toUpperCase();
    if (stockUse === 'O' || stockUse === 'X') {
      throw new Error('이미 처리된 건은 취소 불가');
    }
    if (stockUse === '취소') {
      throw new Error('이미 취소된 요청입니다.');
    }

    updateRow_(sheet, rowIndex, { '재고사용(O,X)': '취소' });
    return { rowIndex, stockUse: '취소' };
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

    const current = calculateCurrentStock_(site, itemId);
    if (current < qty) throw new Error(`재고 부족: 현재 ${current}${item.Unit || ''}, 출고 요청 ${qty}${item.Unit || ''}`);

    logTransaction_(site, {
      itemId, itemName: item.ItemName, spec: item.Spec, unit: item.Unit, zone,
      quantity: qty, worker: worker.name
    });

    // 방금 기록한 출고를 포함해 현재고를 다시 계산해 재고 시트에 반영한다.
    const newQty = recalculateStock_(site, itemId, item);

    return { newQuantity: newQty };
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
    '시간': Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm:ss')
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
