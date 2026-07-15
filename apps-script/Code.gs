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
 * 각 사이트는 자신만의 재고/입고/출고 시트를 가집니다. (Setup.gs 참고)
 */

const SITES = ['기흥', '화성', '평택'];
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
        result = peekPurchaseOrder_(e.parameter.site || '', e.parameter.itemId || '');
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
  if (!zones.includes(zone)) throw new Error('올바르지 않은 구역입니다: ' + zone);
  return zone;
}

function stockSheetName_(site) {
  return site + '_재고';
}

function txSheetName_(site, type) {
  return site + '_' + (type === 'IN' ? '입고' : '출고');
}

function inSheetName_(site) {
  return site + '_입고';
}

function poSheetName_(site) {
  return site + '_구매발주';
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
    const row = stockRows.find(s => String(s.ItemID) === String(itemId));
    return { Site: site, Quantity: row ? Number(row.Quantity) || 0 : 0 };
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
    .filter(s => Number(s.Quantity) !== 0)
    .map(s => {
      const item = itemMap[String(s.ItemID)] || {};
      return {
        ItemID: s.ItemID,
        ItemName: item.ItemName || '(삭제된 자재)',
        Spec: item.Spec || '',
        Unit: item.Unit || '',
        Quantity: Number(s.Quantity) || 0,
        UpdatedAt: s.UpdatedAt
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

function getStockQuantity_(site, itemId) {
  const rows = readAll_(sheet_(stockSheetName_(site)));
  const row = rows.find(s => String(s.ItemID) === String(itemId));
  return { row, quantity: row ? Number(row.Quantity) || 0 : 0 };
}

// item을 넘기면 재고 시트에 ItemName/Spec도 함께 저장한다 (해당 컬럼이 있는 시트에서만 반영됨).
function setStockQuantity_(site, itemId, newQuantity, item) {
  const sheet = sheet_(stockSheetName_(site));
  const rows = readAll_(sheet);
  const existing = rows.find(s => String(s.ItemID) === String(itemId));
  const payload = { Quantity: newQuantity, UpdatedAt: new Date() };
  if (item) {
    payload.ItemName = item.ItemName || '';
    payload.Spec = item.Spec || '';
  }
  if (existing) {
    updateRow_(sheet, existing._row, payload);
  } else {
    payload.ItemID = itemId;
    appendRow_(sheet, payload);
  }
}

function assertItemExists_(itemId) {
  const item = readAll_(sheet_('Items')).find(it => String(it.ItemID) === String(itemId));
  if (!item) throw new Error('자재를 찾을 수 없습니다: ' + itemId);
  return item;
}

// ------------------------- 구매발주 매칭 -------------------------

// 자재코드로 아직 입고완료되지 않은 발주 중 가장 우선순위가 높은 것 하나를 고른다.
// (필요일자가 이른 것 우선, 같으면 구매요청번호 오름차순)
function poSortComparator_(a, b) {
  const da = a['필요일자'] ? new Date(a['필요일자']).getTime() : Infinity;
  const db = b['필요일자'] ? new Date(b['필요일자']).getTime() : Infinity;
  if (da !== db) return da - db;
  return String(a['구매요청번호']).localeCompare(String(b['구매요청번호']));
}

function findOpenPurchaseOrders_(site, itemId) {
  const rows = readAll_(sheet_(poSheetName_(site)));
  return rows
    .filter(r => String(r['자재코드']) === String(itemId) && r['입고여부'] !== '입고완료')
    .sort(poSortComparator_);
}

// 조회만 하고 시트는 변경하지 않음 (QR 스캔 직후 화면 표시용)
function peekPurchaseOrder_(site, itemId) {
  assertSite_(site);
  if (!itemId) throw new Error('ItemID가 필요합니다.');
  const candidates = findOpenPurchaseOrders_(site, itemId);
  if (!candidates.length) return null;
  const po = candidates[0];
  const requested = Number(po['요청수량']) || 0;
  const cumulative = Number(po['누적입고수량']) || 0;
  return {
    poNumber: po['구매요청번호'],
    requester: po['신청자'] || '',
    requestedQty: requested,
    cumulativeQty: cumulative,
    remainingQty: requested - cumulative,
    status: po['입고여부'] || (cumulative <= 0 ? '미입고' : (cumulative < requested ? '부분입고' : '입고완료'))
  };
}

// 실제 입고 처리 시 호출: 가장 우선순위 높은 미완료 발주에 입고수량을 반영하고 시트를 갱신한다.
// 매칭되는 발주가 없으면 null을 반환한다 (호출부에서 "발주 없음 - 입고 이력만 기록"으로 처리).
function applyPurchaseOrderReceipt_(site, itemId, qty) {
  const candidates = findOpenPurchaseOrders_(site, itemId);
  if (!candidates.length) return null;
  const po = candidates[0];

  const requested = Number(po['요청수량']) || 0;
  const cumulative = (Number(po['누적입고수량']) || 0) + qty;
  const remaining = requested - cumulative;
  const status = cumulative <= 0 ? '미입고' : (cumulative < requested ? '부분입고' : '입고완료');

  updateRow_(sheet_(poSheetName_(site)), po._row, {
    '누적입고수량': cumulative,
    '잔여수량': remaining,
    '입고여부': status,
    '최종입고일': new Date()
  });

  return {
    poNumber: po['구매요청번호'],
    requester: po['신청자'] || '',
    requestedQty: requested,
    cumulativeQty: cumulative,
    remainingQty: remaining,
    status
  };
}

// ------------------------- 입고 / 출고 -------------------------

function stockIn_(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const site = assertSite_(body.site);
    const { itemId, quantity, pin, note } = body;
    const qty = Number(quantity);
    if (!qty || qty <= 0) throw new Error('입고 수량은 0보다 커야 합니다.');
    const item = assertItemExists_(itemId);
    const worker = handleLogin_(pin);

    const { quantity: current } = getStockQuantity_(site, itemId);
    const newQty = current + qty;
    setStockQuantity_(site, itemId, newQty, item);

    // 자재코드로 미완료 발주를 찾아 누적입고수량/잔여수량/입고여부를 갱신한다.
    // 매칭되는 발주가 없으면 poMatch는 null이며, 입고 이력만 기록된다.
    const poMatch = applyPurchaseOrderReceipt_(site, itemId, qty);

    logTransaction_(site, 'IN', {
      itemId, itemName: item.ItemName, spec: item.Spec, unit: item.Unit,
      poNumber: poMatch ? poMatch.poNumber : '',
      requester: poMatch ? poMatch.requester : '',
      quantity: qty, handler: worker.name, note
    });

    return { newQuantity: newQty, purchaseOrder: poMatch };
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
    const { itemId, quantity, pin, note } = body;
    const qty = Number(quantity);
    if (!qty || qty <= 0) throw new Error('출고 수량은 0보다 커야 합니다.');
    const item = assertItemExists_(itemId);
    const worker = handleLogin_(pin);

    const { quantity: current } = getStockQuantity_(site, itemId);
    if (current < qty) throw new Error(`재고 부족: 현재 ${current}${item.Unit || ''}, 출고 요청 ${qty}${item.Unit || ''}`);
    const newQty = current - qty;
    setStockQuantity_(site, itemId, newQty, item);

    logTransaction_(site, 'OUT', {
      itemId, itemName: item.ItemName, zone,
      quantity: qty, balanceAfter: newQty, worker: worker.name, note
    });

    return { newQuantity: newQty };
  } finally {
    lock.releaseLock();
  }
}

function logTransaction_(site, type, t) {
  if (type === 'IN') {
    appendRow_(sheet_(inSheetName_(site)), {
      '입고일시': new Date(),
      '구매요청번호': t.poNumber || '',
      '자재코드': t.itemId,
      '자재명': t.itemName,
      '규격': t.spec || '',
      '단위': t.unit || '',
      '입고수량': t.quantity,
      '신청자': t.requester || '',
      '담당자': t.handler,
      '비고': t.note || ''
    });
    return;
  }

  const sheet = sheet_(txSheetName_(site, type));
  const txId = 'TX-' + Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyyMMddHHmmss') + '-' + Math.floor(Math.random() * 900 + 100);
  appendRow_(sheet, {
    TransactionID: txId,
    Timestamp: new Date(),
    ItemID: t.itemId,
    ItemName: t.itemName,
    Zone: t.zone || '',
    Quantity: t.quantity,
    BalanceAfter: t.balanceAfter,
    Worker: t.worker,
    Note: t.note || ''
  });
}

// 입고 시트는 컬럼명이 한글(구매발주 연동)이라, 이력 화면에서 공통으로 쓰는
// 영문 필드명(Timestamp/ItemID/ItemName/Quantity/Worker/Note 등)으로 맞춰준다.
function normalizeInRow_(r) {
  return {
    _row: r._row,
    Type: 'IN',
    Timestamp: r['입고일시'],
    PoNumber: r['구매요청번호'] || '',
    ItemID: r['자재코드'],
    ItemName: r['자재명'],
    Spec: r['규격'] || '',
    Unit: r['단위'] || '',
    Quantity: r['입고수량'],
    Requester: r['신청자'] || '',
    Worker: r['담당자'],
    Note: r['비고'] || '',
    Zone: ''
  };
}

function listTransactions_(filter) {
  const site = assertSite_(filter.site);
  let rows;
  if (filter.type === 'IN') {
    rows = readAll_(sheet_(inSheetName_(site))).map(normalizeInRow_);
  } else if (filter.type === 'OUT') {
    rows = readAll_(sheet_(txSheetName_(site, 'OUT'))).map(r => Object.assign({ Type: 'OUT' }, r));
  } else {
    const inRows = readAll_(sheet_(inSheetName_(site))).map(normalizeInRow_);
    const outRows = readAll_(sheet_(txSheetName_(site, 'OUT'))).map(r => Object.assign({ Type: 'OUT' }, r));
    rows = inRows.concat(outRows);
  }

  if (filter.itemId) rows = rows.filter(r => String(r.ItemID) === String(filter.itemId));

  rows.sort((a, b) => new Date(b.Timestamp) - new Date(a.Timestamp));
  const limit = filter.limit || 50;
  return rows.slice(0, limit).map(stripRow_);
}
