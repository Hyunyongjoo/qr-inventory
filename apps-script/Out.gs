/**
 * Out.gs — ERP 자재 출고등록 자동화 (사이트_출고 시트 → 사무실 PC 출고등록.bat → ERP).
 *
 * 상태는 출고 시트의 "출고번호" 열(비고 바로 뒤) 하나로 관리한다.
 *   빈칸 = 미등록(대상) / 등록중 = PC 처리 중 / 2026-1117-0148 = 완료 / 실패: 사유 = 실패(다시 대상)
 *   수동등록 = 자동등록 시작 전 사람이 등록(대상 아님) / 제외: 환경안전용품 = 출고 절차 없음(대상 아님)
 *   출고번호 확인 필요 = ERP 등록은 됐지만 번호를 못 받음(대상 아님, 사람이 번호 입력)
 *
 * API (토큰 = 스크립트 속성 ERP_BOT_TOKEN, 구매 자동등록과 같음)
 *   GET  ?action=out_pending&token&sites=평택&pc=평택PC  → 미리보기(출고번호 열은 바꾸지 않음, 제외/조건 오류 표시만)
 *   POST {action:"out_start", token, batch_ids:[…]}      → 지금도 같은 행 묶음이면 등록중으로
 *   POST {action:"out_result", token, batch_id, status:"완료"|"실패", out_number, message}
 */

const OUT_NUMBER_COLUMN = '출고번호';
const OUT_START_PROP = 'OUT_START_DATE';
const OUT_START_DEFAULT = '2026-11-17';
const OUT_ST = {
  RUNNING: '등록중',
  MANUAL: '수동등록',
  EXCLUDED: '제외: 환경안전용품',
  NEED_NUMBER: '출고번호 확인 필요',
  FAIL_PREFIX: '실패: '
};
// 사용자재 시트 사용설비 값(띄어쓰기 무시, 정확히 일치). 환경안전용품 제외는 공통 함수 isEnvSafetyItem_(Erp.gs).
const OUT_FREE_EQUIPMENT = '안전용품';
const OUT_FREE_NOTE_WORD = '무상';
const OUT_PAID = '유상';
const OUT_FREE = '무상';

const OUT_COND_SHEET_NAME = '출고조건';
const OUT_COND_HEADERS = ['사이트', '유무상', '명칭템플릿', '추가명칭템플릿', '출고장소', '용도', '설비종류', '출고창고', '출고사유'];
const OUT_COND_SEED_ROWS = [
  ['화성', '유상', '[SCR] 화성 A/S 유상출고자재({라인}, {출고일자})', '', '고정:H1', 'A/S자재', 'SCRUBBER', '사이트창고', 'A/S'],
  ['화성', '무상', '[SCR] 화성 A/S 무상출고자재({라인}, {출고일자})', '', '고정:H1', 'A/S자재', 'SCRUBBER', '사이트창고', 'A/S'],
  ['평택', '유상', '[SCR] 삼성 평택 {라인} 출고 件', '[SCR] 삼성 평택 {라인} 추가 출고 件', '라인', 'A/S자재', 'SCRUBBER', '사이트창고', 'A/S'],
  ['평택', '무상', '[SCR] 삼성 평택 {라인} 무상 출고 件', '[SCR] 삼성 평택 {라인} 무상 추가 출고 件', '라인', 'A/S자재', 'SCRUBBER', '사이트창고', 'A/S'],
  ['기흥', '유상', '[SCR] 삼성 기흥 출고자재({출고일자} {라인})', '', '고정:K2', 'A/S자재', 'SCRUBBER', '사이트창고', 'A/S'],
  ['기흥', '무상', '[SCR] 삼성 기흥 무상출고자재({출고일자} {라인})', '', '고정:K2', 'A/S자재', 'SCRUBBER', '사이트창고', 'A/S']
];
const OUT_LINE_SHEET_NAME = '출고라인';
const OUT_LINE_HEADERS = ['사이트', 'QR라인값', '명칭표기', 'ERP출고장소', 'ERP라인코드'];
const OUT_LINE_SEED_ROWS = [
  ['화성', '15LINE', '15L', 'H1', 'L0014'],
  ['화성', '16LINE', '16L', 'H1', 'L0014'],
  ['화성', '17LINE', '17L', 'H1', 'L0014'],
  ['화성', 'CS', 'CS', 'H1', 'L0014'],
  ['화성', 'NRD', 'NRD', 'H1', 'L0014'],
  ['평택', 'P1', 'P1', 'P1', 'L0012'],
  ['평택', 'P2', 'P2', 'P2', 'L0013'],
  ['평택', 'P3', 'P3', 'P3', 'L0020'],
  ['평택', 'P4', 'P4', 'P4', 'L0076'],
  ['평택', 'S5', 'S5', 'S5', 'L0021'],
  ['기흥', 'K2', 'K2', 'K2', 'L0011'],
  ['기흥', 'S3', 'S3', 'K2', 'L0011']
];
const OUT_COND_CACHE_KEY = 'outConditions:v1';
const OUT_LINE_CACHE_KEY = 'outLines:v1';
const OUT_CONFIG_CACHE_SEC = 600;

const OUT_STALE_MS = 20 * 60 * 1000;
const OUT_RUN_PROP_PREFIX = 'OUT_RUN_';
const OUT_RUN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// out_pending 한 번에 내려주는 최대 묶음 수(나머지는 앞 묶음이 등록중이 된 뒤 다음 요청에서).
const OUT_PENDING_MAX_BATCHES = 8;
const OUT_FILE_CACHE_PREFIX = 'outFile:';
const OUT_FILE_CACHE_SEC = 600;
const OUT_XLSX_COLUMNS = ['자재코드', '자재명', '규격', '단위', '출고수량'];

// ------------------------- 조건 시트 -------------------------

// 조건 시트를 읽어 [{헤더: 값}]으로 돌려준다(10분 캐시). 시트가 없으면 초기값으로 만든다.
function loadOutConfigSheet_(sheetName, headers, seedRows, cacheKey) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 다시 읽는다 */ }
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) sheet = createOutConfigSheet_(sheetName, headers, seedRows);
  let list = [];
  if (sheet.getLastRow() >= 2) {
    const heads = headers_(sheet).map(h => String(h || '').trim());
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, heads.length).getValues();
    list = values.map(row => {
      const o = {};
      headers.forEach(h => {
        const i = heads.indexOf(h);
        o[h] = i === -1 ? '' : String(row[i] == null ? '' : row[i]).trim();
      });
      return o;
    }).filter(o => o['사이트']);
  }
  try {
    cache.put(cacheKey, JSON.stringify(list), OUT_CONFIG_CACHE_SEC);
  } catch (e) {
    Logger.log(sheetName + ' 캐시 저장 실패: ' + (e && e.message || e));
  }
  return list;
}

function createOutConfigSheet_(sheetName, headers, seedRows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.insertSheet(sheetName);
  const aoa = [headers].concat(seedRows);
  sheet.getRange(1, 1, aoa.length, headers.length).setNumberFormat('@').setValues(aoa);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.setFrozenRows(1);
  return sheet;
}

function loadOutConditions_() {
  return loadOutConfigSheet_(OUT_COND_SHEET_NAME, OUT_COND_HEADERS, OUT_COND_SEED_ROWS, OUT_COND_CACHE_KEY)
    .map(o => ({
      site: o['사이트'],
      paid: stripSpaces_(o['유무상']),
      template: o['명칭템플릿'],
      addTemplate: o['추가명칭템플릿'],
      location: o['출고장소'],
      fields: { '용도': o['용도'], '설비종류': o['설비종류'], '출고창고': o['출고창고'], '출고사유': o['출고사유'] }
    }));
}

function loadOutLines_() {
  return loadOutConfigSheet_(OUT_LINE_SHEET_NAME, OUT_LINE_HEADERS, OUT_LINE_SEED_ROWS, OUT_LINE_CACHE_KEY)
    .map(o => ({
      site: o['사이트'],
      key: normalizeLine_(o['QR라인값']),
      name: o['명칭표기'],
      location: o['ERP출고장소'],
      code: o['ERP라인코드']
    }))
    .filter(l => l.key);
}

function clearOutConfigCache_() {
  CacheService.getScriptCache().removeAll([OUT_COND_CACHE_KEY, OUT_LINE_CACHE_KEY]);
}

// ------------------------- 출고 시트 읽기/쓰기 -------------------------

function outStartYmd_() {
  const v = PropertiesService.getScriptProperties().getProperty(OUT_START_PROP);
  return outYmd_(v) || OUT_START_DEFAULT;
}

function outTodayYmd_(nowMs) {
  return Utilities.formatDate(new Date(nowMs || Date.now()), 'Asia/Seoul', 'yyyy-MM-dd');
}

// 시트 날짜(Date 또는 '2026-11-17', '2026. 11. 17' 같은 문자열)를 yyyy-MM-dd로. 해석 불가면 ''.
function outYmd_(v) {
  if (v instanceof Date) return sheetDateStr_(v);
  const m = String(v == null ? '' : v).trim().match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

// 출고번호 열이 없으면 비고 바로 오른쪽 빈 열에(그 자리에 다른 열이 있으면 맨 오른쪽에) 만든다. 일반 텍스트 서식.
function ensureOutNumberColumn_(sheet) {
  const heads = headers_(sheet).map(h => String(h || '').trim());
  if (heads.indexOf(OUT_NUMBER_COLUMN) !== -1) return;
  const note = heads.indexOf('비고');
  let col = sheet.getLastColumn() + 1;
  if (note !== -1 && (note + 1 >= heads.length || heads[note + 1] === '')) col = note + 2;
  if (col > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), col - sheet.getMaxColumns());
  sheet.getRange(1, col).setValue(OUT_NUMBER_COLUMN).setFontWeight('bold').setBackground('#f1f3f4');
  sheet.getRange(1, col, sheet.getMaxRows(), 1).setNumberFormat('@');
}

/**
 * 사이트_출고 시트를 읽는다. 라인은 같은 이름 열이 둘(B, O)이라 첫 번째 '라인'(B) 열을 쓴다
 * (readAll_은 같은 이름이면 뒤 열 값을 주므로 쓰지 않는다).
 */
function readOutSheet_(site) {
  const sheet = sheet_(txSheetName_(site));
  ensureOutNumberColumn_(sheet);
  const heads = headers_(sheet).map(h => String(h || '').trim());
  const col = name => heads.indexOf(name);
  const c = {
    date: col('출고일자'), line: col('라인'), code: col('자재코드'), name: col('자재명'), spec: col('규격'),
    unit: col('단위'), qty: col('출고수량'), note: col('비고'), tx: col('거래코드'), out: col(OUT_NUMBER_COLUMN)
  };
  ['date', 'line', 'code', 'qty', 'out'].forEach(k => {
    if (c[k] === -1) throw new Error('"' + sheet.getName() + '" 시트에서 필요한 열을 찾을 수 없습니다: ' + k);
  });
  const lastRow = sheet.getLastRow();
  const values = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, heads.length).getValues() : [];
  const get = (v, i) => (i === -1 ? '' : v[i]);
  const rows = values.map((v, i) => ({
    row: i + 2,
    date: outYmd_(v[c.date]),
    line: String(v[c.line] == null ? '' : v[c.line]).trim(),
    code: String(v[c.code] == null ? '' : v[c.code]).trim(),
    name: String(get(v, c.name) == null ? '' : get(v, c.name)),
    spec: String(get(v, c.spec) == null ? '' : get(v, c.spec)),
    unit: String(get(v, c.unit) == null ? '' : get(v, c.unit)),
    qty: Number(v[c.qty]) || 0,
    note: String(get(v, c.note) == null ? '' : get(v, c.note)),
    tx: String(get(v, c.tx) == null ? '' : get(v, c.tx)).trim(),
    out: String(v[c.out] == null ? '' : v[c.out]).trim()
  }));
  return { sheet, outCol: c.out + 1, rows };
}

// 출고번호 열에 { 행번호: 값 }을 쓴다. 연속된 행끼리 한 번에 쓴다.
function writeOutCells_(sheet, outCol, updates) {
  const rowIdxs = Object.keys(updates).map(Number).filter(n => n >= 2).sort((a, b) => a - b);
  let i = 0;
  while (i < rowIdxs.length) {
    let j = i;
    while (j + 1 < rowIdxs.length && rowIdxs[j + 1] === rowIdxs[j] + 1) j++;
    const vals = rowIdxs.slice(i, j + 1).map(r => [updates[r]]);
    sheet.getRange(rowIdxs[i], outCol, vals.length, 1).setNumberFormat('@').setValues(vals);
    i = j + 1;
  }
}

// 결과 기록 때 행이 밀렸는지 확인하는 키(거래코드 + 자재코드 + 수량).
function outRowKey_(r) {
  return [r.tx, normalizeMaterialCode_(r.code), r.qty].join('~');
}

function isOutTargetStatus_(out) {
  return out === '' || out.indexOf('실패') === 0;
}

// 이미 등록됐거나 등록 중인 행(추가 명칭 판단용): 출고번호·등록중·출고번호 확인 필요·사람이 넣은 값.
function isOutRegisteredStatus_(out) {
  return !!out && !isOutTargetStatus_(out) && out !== OUT_ST.MANUAL && out.indexOf('제외') !== 0;
}

// ------------------------- 묶음 계산 (시트 쓰기 없음) -------------------------

/**
 * 출고 시트 행으로 묶음을 계산한다.
 * ctx = { start, today, equipmentOf(code), conditions, lines, unitOf(code) }
 * 반환 { groups: [...], exclude: [행번호] }. group.error가 있으면 그 묶음은 내려주지 않고 실패로 표시한다.
 */
function buildOutGroups_(site, rows, ctx) {
  const map = {};
  const order = [];
  const registered = {};
  const exclude = [];
  rows.forEach(r => {
    if (!r.code || !r.date || r.date < ctx.start || r.date > ctx.today) return;
    const eq = stripSpaces_(ctx.equipmentOf(r.code));
    const target = isOutTargetStatus_(r.out);
    if (isEnvSafetyItem_(r.code, eq)) {
      if (target) exclude.push(r.row);
      return;
    }
    const paid = stripSpaces_(r.note).indexOf(OUT_FREE_NOTE_WORD) !== -1 || eq === OUT_FREE_EQUIPMENT ? OUT_FREE : OUT_PAID;
    const lineKey = normalizeLine_(r.line);
    const gk = r.date + '|' + lineKey + '|' + paid;
    if (isOutRegisteredStatus_(r.out)) registered[gk] = true;
    if (!target || r.qty <= 0) return;
    if (!map[gk]) {
      map[gk] = { site, date: r.date, lineKey, rawLine: r.line, paid, rows: [] };
      order.push(gk);
    }
    map[gk].rows.push(r);
  });

  const groups = order.map(gk => {
    const g = map[gk];
    g.rows.sort((a, b) => a.row - b.row);
    g.batchId = outBatchId_(site, g);
    g.added = !!registered[gk];
    const cond = ctx.conditions.find(c => c.site === site && c.paid === g.paid);
    const line = g.lineKey ? ctx.lines.find(l => l.site === site && l.key === g.lineKey) : null;
    g.lineName = line && line.name ? line.name : g.rawLine;
    g.locationCode = line ? line.code : '';
    if (!cond) {
      g.error = '출고조건 시트에 조건 없음(' + site + ' ' + g.paid + ')';
      return g;
    }
    const loc = String(cond.location || '').trim();
    const fixed = loc.match(/^고정\s*[:：]\s*(.+)$/);
    if (fixed) {
      g.location = fixed[1].trim();
    } else if (stripSpaces_(loc) === '라인') {
      if (!line || !line.location) {
        g.error = '출고라인 시트에 라인 없음';
        return g;
      }
      g.location = line.location;
    } else {
      g.error = '출고조건 출고장소 형식 오류(' + (loc || '빈값') + ')';
      return g;
    }
    const template = g.added && cond.addTemplate ? cond.addTemplate : cond.template;
    g.title = String(template || '')
      .replace(/\{라인\}/g, g.lineName)
      .replace(/\{출고일자\}/g, g.date.replace(/-/g, ''));
    g.fields = Object.assign({}, cond.fields);
    g.items = mergeOutItems_(g.rows, ctx.unitOf);
    return g;
  });
  return { groups, exclude };
}

// 같은 자재코드는 수량을 더해 한 줄로(첫 행의 자재명·규격·단위, 처음 나온 순서).
function mergeOutItems_(rows, unitOf) {
  const byCode = {};
  const items = [];
  rows.forEach(r => {
    const k = normalizeMaterialCode_(r.code);
    if (!byCode[k]) {
      byCode[k] = { code: r.code, name: r.name, spec: r.spec, unit: r.unit || (unitOf ? unitOf(r.code) : ''), qty: 0 };
      items.push(byCode[k]);
    }
    byCode[k].qty = Math.round((byCode[k].qty + r.qty) * 1e6) / 1e6;
  });
  return items;
}

// 사이트|출고일자|라인|유무상|대상 행(행번호:자재코드:수량) 해시. 행이 바뀌면 값이 달라진다.
function outBatchId_(site, g) {
  const src = [site, g.date, g.lineKey, g.paid, g.rows.map(r => r.row + ':' + normalizeMaterialCode_(r.code) + ':' + r.qty).join(',')].join('|');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, src, Utilities.Charset.UTF_8);
  const hex = bytes.map(b => ('0' + ((b + 256) % 256).toString(16)).slice(-2)).join('').slice(0, 12);
  return 'O' + (SITE_CODES[site] || site) + g.date.replace(/-/g, '') + '-' + hex;
}

function outContext_(site, nowMs) {
  let equip = null;
  let units = null;
  return {
    start: outStartYmd_(),
    today: outTodayYmd_(nowMs),
    conditions: loadOutConditions_(),
    lines: loadOutLines_(),
    equipmentOf: code => {
      if (!equip) equip = readUsedEquipmentMap_(site).byCode;
      return equip[normalizeMaterialCode_(code)] || '';
    },
    unitOf: code => {
      if (!units) units = buildItemUnitMap_();
      return units[String(code)] || '';
    }
  };
}

// ------------------------- 등록중 기록(스크립트 속성) -------------------------

function readOutRuns_() {
  const all = PropertiesService.getScriptProperties().getProperties();
  const runs = [];
  Object.keys(all).forEach(k => {
    if (k.indexOf(OUT_RUN_PROP_PREFIX) !== 0) return;
    try {
      runs.push(Object.assign({ key: k, batchId: k.slice(OUT_RUN_PROP_PREFIX.length) }, JSON.parse(all[k])));
    } catch (e) { /* 깨진 값은 무시 */ }
  });
  return runs;
}

function saveOutRun_(run) {
  const o = { site: run.site, at: run.at, pc: run.pc || '', rows: run.rows, reverted: !!run.reverted, done: run.done || '' };
  PropertiesService.getScriptProperties().setProperty(OUT_RUN_PROP_PREFIX + run.batchId, JSON.stringify(o));
}

// 기록된 [행번호, 키] 목록을 지금 시트 행에 맞춘다. 행이 밀렸으면 같은 키·허용 상태인 다른 행을 찾는다.
function resolveOutRunRows_(rows, entries, allowed) {
  const byRow = {};
  rows.forEach(r => { byRow[r.row] = r; });
  const used = {};
  const found = [];
  let missing = 0;
  entries.forEach(e => {
    let r = byRow[e[0]];
    if (!r || used[r.row] || outRowKey_(r) !== e[1] || !allowed(r.out)) {
      r = rows.find(x => !used[x.row] && outRowKey_(x) === e[1] && allowed(x.out));
    }
    if (r) {
      used[r.row] = true;
      found.push(r);
    } else {
      missing++;
    }
  });
  return { found, missing };
}

// 등록중으로 20분 넘게 결과가 없는 묶음은 빈칸으로 되돌린다(기록은 남겨 늦게 온 결과도 받는다).
// 7일 지난 기록은 지운다. data.rows의 out 값도 함께 바꾼다. 잠금 안에서 부른다.
function reclaimStaleOutRuns_(site, data, nowMs, runs) {
  const props = PropertiesService.getScriptProperties();
  const updates = {};
  runs.forEach(run => {
    if (run.site !== site) return;
    if (nowMs - (Number(run.at) || 0) > OUT_RUN_KEEP_MS) {
      props.deleteProperty(run.key);
      return;
    }
    if (run.done || run.reverted || nowMs - (Number(run.at) || 0) <= OUT_STALE_MS) return;
    const res = resolveOutRunRows_(data.rows, run.rows || [], out => out === OUT_ST.RUNNING);
    res.found.forEach(r => { updates[r.row] = ''; r.out = ''; });
    run.reverted = true;
    saveOutRun_(run);
    Logger.log('출고 등록중 20분 초과 → 빈칸: ' + run.batchId + ' ' + res.found.length + '행');
  });
  writeOutCells_(data.sheet, data.outCol, updates);
}

// ------------------------- API -------------------------

/** GET ?action=out_pending&token&sites=평택&pc=평택PC */
function outPending_(p) {
  if (!erpTokenOk_(p.token)) return { ok: false, error: 'unauthorized' };
  const pc = String(p.pc || '').trim();
  const sites = parseErpSitesStrict_(p.sites);
  if (!sites) {
    Logger.log('출고 pending 거부 [' + (pc || '?') + ']: sites="' + String(p.sites == null ? '' : p.sites) + '"');
    return { ok: false, error: 'sites 설정 오류' };
  }
  const now = Date.now();
  const ready = [];
  const lock = scriptLock_();
  lock.waitLock(20000);
  try {
    const runs = readOutRuns_();
    sites.forEach(site => {
      const data = readOutSheet_(site);
      reclaimStaleOutRuns_(site, data, now, runs);
      const res = buildOutGroups_(site, data.rows, outContext_(site, now));
      // 시트에 남기는 표시는 제외(환경안전용품)와 조건 오류뿐. 값이 같으면 다시 쓰지 않는다.
      const marks = {};
      const byRow = {};
      data.rows.forEach(r => { byRow[r.row] = r; });
      res.exclude.forEach(ri => { if (byRow[ri].out !== OUT_ST.EXCLUDED) marks[ri] = OUT_ST.EXCLUDED; });
      res.groups.forEach(g => {
        if (!g.error) {
          ready.push(g);
          return;
        }
        const v = OUT_ST.FAIL_PREFIX + g.error;
        g.rows.forEach(r => { if (r.out !== v) marks[r.row] = v; });
      });
      writeOutCells_(data.sheet, data.outCol, marks);
    });
  } finally {
    lock.releaseLock();
  }

  ready.sort((a, b) => (a.date + a.site + a.lineKey + a.paid < b.date + b.site + b.lineKey + b.paid ? -1 : 1));
  const batches = [];
  ready.slice(0, OUT_PENDING_MAX_BATCHES).forEach(g => {
    try {
      const fileName = g.batchId + '.xlsx';
      batches.push({
        batch_id: g.batchId,
        site: g.site,
        date: g.date,
        line: g.lineName,
        paid: g.paid,
        title: g.title,
        location: g.location,
        location_code: g.locationCode,
        fields: g.fields,
        row_count: g.items.length,
        file_name: fileName,
        file_b64: outXlsxBase64Cached_(g.batchId, g.items)
      });
    } catch (err) {
      Logger.log(g.batchId + ' 출고 엑셀 준비 실패: ' + (err && err.message || err));
    }
  });
  if (batches.length) {
    Logger.log('출고 pending [' + (pc || '?') + ']: ' + batches.map(b => b.batch_id + ' ' + b.title).join(', ') +
      (ready.length > batches.length ? ' (남은 묶음 ' + (ready.length - batches.length) + ')' : ''));
  }
  return { ok: true, batches };
}

/** POST {action:"out_start", token, batch_ids:[…], pc} */
function outStart_(body) {
  if (!erpTokenOk_(body.token)) return { ok: false, error: 'unauthorized' };
  const ids = (Array.isArray(body.batch_ids) ? body.batch_ids : [body.batch_ids])
    .map(s => String(s == null ? '' : s).trim()).filter(Boolean);
  const pc = String(body.pc || '').trim();
  const codeToSite = {};
  Object.keys(SITE_CODES).forEach(s => { codeToSite[SITE_CODES[s]] = s; });
  const bySite = {};
  ids.forEach(id => {
    const m = id.match(/^O([A-Z]{2})\d{8}-/);
    const site = m && codeToSite[m[1]];
    if (site) (bySite[site] = bySite[site] || []).push(id);
  });
  const now = Date.now();
  const accepted = [];
  const lock = scriptLock_();
  lock.waitLock(20000);
  try {
    const runs = readOutRuns_();
    Object.keys(bySite).forEach(site => {
      const data = readOutSheet_(site);
      reclaimStaleOutRuns_(site, data, now, runs);
      const res = buildOutGroups_(site, data.rows, outContext_(site, now));
      const updates = {};
      bySite[site].forEach(id => {
        const g = res.groups.find(x => x.batchId === id && !x.error);
        if (!g) return;
        g.rows.forEach(r => { updates[r.row] = OUT_ST.RUNNING; });
        // 같은 행을 가졌던 이전 기록은 지운다(늦게 온 이전 결과가 이 행을 덮지 않게).
        const rowSet = {};
        g.rows.forEach(r => { rowSet[r.row] = true; });
        runs.forEach(run => {
          if (run.site === site && !run.done && (run.rows || []).some(e => rowSet[e[0]])) {
            PropertiesService.getScriptProperties().deleteProperty(run.key);
          }
        });
        saveOutRun_({ batchId: id, site, at: now, pc, rows: g.rows.map(r => [r.row, outRowKey_(r)]) });
        accepted.push(id);
      });
      writeOutCells_(data.sheet, data.outCol, updates);
    });
  } finally {
    lock.releaseLock();
  }
  Logger.log('출고 start [' + (pc || '?') + ']: 요청 ' + ids.length + ' / 수락 ' + accepted.join(', '));
  return { ok: true, accepted };
}

/** POST {action:"out_result", token, batch_id, status:"완료"|"실패", out_number, message} */
function outResult_(body) {
  if (!erpTokenOk_(body.token)) return { ok: false, error: 'unauthorized' };
  const batchId = String(body.batch_id || '').trim();
  const status = String(body.status || '').trim();
  if (!batchId) return { ok: false, error: 'batch_id가 없습니다.' };
  if (status !== '완료' && status !== '실패') return { ok: false, error: 'status는 완료 또는 실패여야 합니다.' };
  const number = String(body.out_number || '').trim();
  const message = String(body.message || '').trim();
  let value;
  if (status === '완료') value = number || OUT_ST.NEED_NUMBER;
  else value = OUT_ST.FAIL_PREFIX + (message || '사유 없음').slice(0, 80);

  const lock = scriptLock_();
  lock.waitLock(20000);
  try {
    const run = readOutRuns_().find(r => r.batchId === batchId);
    if (!run) return { ok: false, error: '배치를 찾을 수 없습니다: ' + batchId };
    if (run.done) return { ok: true, updated: 0, already: true };
    const data = readOutSheet_(run.site);
    // 등록중 행, 그리고 20분 초과로 빈칸이 된 뒤 아직 다른 묶음이 가져가지 않은 행에 기록한다.
    const res = resolveOutRunRows_(data.rows, run.rows || [], out => out === OUT_ST.RUNNING || out === '');
    const updates = {};
    res.found.forEach(r => { updates[r.row] = value; });
    writeOutCells_(data.sheet, data.outCol, updates);
    run.done = status + (number ? ' ' + number : '');
    saveOutRun_(run);
    Logger.log('출고 result ' + batchId + ': ' + value + ' (' + res.found.length + '행' +
      (res.missing ? ', 못 찾은 행 ' + res.missing : '') + ')' + (message && status === '완료' ? ' / ' + message : ''));
    return { ok: true, updated: res.found.length, missing: res.missing };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------- 업로드 엑셀 -------------------------

function outXlsxBase64Cached_(batchId, items) {
  const cache = CacheService.getScriptCache();
  const key = OUT_FILE_CACHE_PREFIX + batchId;
  const hit = cache.get(key);
  if (hit) return hit;
  const b64 = buildOutXlsxBase64_(batchId, items);
  if (b64.length < 90000) {
    try { cache.put(key, b64, OUT_FILE_CACHE_SEC); } catch (e) { /* 캐시 실패는 무시 */ }
  }
  return b64;
}

// ERP 자재 출고등록 엑셀 서식: 1행 머리글, 자재코드 | 자재명 | 규격 | 단위 | 출고수량 (수량만 숫자).
function buildOutXlsxBase64_(name, items) {
  const cols = OUT_XLSX_COLUMNS;
  const aoa = [cols].concat(items.map(it => [it.code, it.name, it.spec, it.unit, it.qty]));
  const ss = SpreadsheetApp.create('ERP_OUT_' + name);
  const fileId = ss.getId();
  try {
    const sh = ss.getSheets()[0];
    sh.setName('출고');
    sh.getRange(1, 1, aoa.length, cols.length).setNumberFormat('@');
    if (aoa.length > 1) sh.getRange(2, 5, aoa.length - 1, 1).setNumberFormat('General');
    sh.getRange(1, 1, aoa.length, cols.length).setValues(aoa);
    SpreadsheetApp.flush();
    const resp = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + fileId + '/export?format=xlsx', {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) throw new Error('xlsx 내보내기 실패 (HTTP ' + resp.getResponseCode() + ')');
    return Utilities.base64Encode(resp.getBlob().getBytes());
  } finally {
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (e) {
      Logger.log('임시 파일 삭제 실패(' + fileId + '): ' + (e && e.message || e));
    }
  }
}

// ------------------------- 메뉴 / 준비 -------------------------

/** 편집기·메뉴: 시작일 속성(없을 때만), 출고조건·출고라인 시트(없을 때만), 사이트별 출고번호 열을 준비한다. */
function setupOutAutomation() {
  const props = PropertiesService.getScriptProperties();
  const lines = [];
  if (!props.getProperty(OUT_START_PROP)) {
    props.setProperty(OUT_START_PROP, OUT_START_DEFAULT);
    lines.push(OUT_START_PROP + ' = ' + OUT_START_DEFAULT + ' 설정');
  } else {
    lines.push(OUT_START_PROP + ' = ' + props.getProperty(OUT_START_PROP) + ' (기존 값 유지)');
  }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [[OUT_COND_SHEET_NAME, OUT_COND_HEADERS, OUT_COND_SEED_ROWS], [OUT_LINE_SHEET_NAME, OUT_LINE_HEADERS, OUT_LINE_SEED_ROWS]]
    .forEach(([name, heads, seed]) => {
      if (ss.getSheetByName(name)) lines.push(name + ' 시트: 이미 있어 그대로 둠');
      else { createOutConfigSheet_(name, heads, seed); lines.push(name + ' 시트 생성(' + seed.length + '행)'); }
    });
  clearOutConfigCache_();
  SITES.forEach(site => {
    const sheet = ss.getSheetByName(txSheetName_(site));
    if (!sheet) { lines.push(site + '_출고 시트 없음'); return; }
    ensureOutNumberColumn_(sheet);
    const col = headers_(sheet).map(h => String(h || '').trim()).indexOf(OUT_NUMBER_COLUMN) + 1;
    lines.push(site + '_출고: 출고번호 = ' + columnLetter_(col) + '열');
  });
  const msg = '출고 자동등록 준비\n\n' + lines.join('\n');
  Logger.log(msg);
  return msg;
}

function columnLetter_(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 출고일자 < OUT_START_DATE 이고 출고번호가 빈 행에 '수동등록'을 쓴다(1회 실행용). */
function markOutManualBeforeStart_() {
  const start = outStartYmd_();
  const lines = [];
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    SITES.forEach(site => {
      if (!SpreadsheetApp.getActiveSpreadsheet().getSheetByName(txSheetName_(site))) return;
      const data = readOutSheet_(site);
      const updates = {};
      let noDate = 0;
      data.rows.forEach(r => {
        if (r.out) return;
        if (!r.date) { if (r.code) noDate++; return; }
        if (r.date < start) updates[r.row] = OUT_ST.MANUAL;
      });
      writeOutCells_(data.sheet, data.outCol, updates);
      lines.push(site + ': ' + Object.keys(updates).length + '행 수동등록' + (noDate ? ' (출고일자 해석 불가 ' + noDate + '행은 그대로)' : ''));
    });
  } finally {
    lock.releaseLock();
  }
  const msg = '출고 시작일(' + start + ') 이전 행 수동등록 표시\n\n' + lines.join('\n');
  Logger.log(msg);
  return msg;
}

function setupOutAutomationFromMenu() {
  const msg = setupOutAutomation();
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 편집기 실행 */ }
  return msg;
}

function markOutManualBeforeStartFromMenu() {
  const msg = markOutManualBeforeStart_();
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* 편집기 실행 */ }
  return msg;
}
