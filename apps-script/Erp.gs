/**
 * Erp.gs — 구매유형 지정 · 청구서/긴급 등록 · ERP 자동등록 PC용 API
 *
 * 흐름
 *  1) 구매요청이 들어오면(submitPurchase_) '유형제안규칙' 시트의 규칙을 우선순위대로 검사해 처음 맞는 유형을
 *     구매발주및입고 시트 맨 오른쪽 신규 열의 구매유형코드에 넣고 유형상태=제안, 제안근거를 남긴다.
 *     안전용품구매인데 사용설비로 유형을 못 정하면 구매유형코드 빈값 + 유형상태=확인필요(등록 불가).
 *  2) 관리자/자재관리자(Users 시트 '사이트' 열로 담당 사이트 지정)가 PWA "청구서 관리" 화면에서 구매대기(구매필요 확정) 건을 골라
 *     유형 저장 / 청구서 등록 / 긴급 등록을 누른다(erpUpdateRequests_). 등록 버튼은 ERP상태=대기로만 바꾼다.
 *  3) 사이트별 사무실 PC의 등록 프로그램이 GET ?action=pending 으로 대기 건을 배치 단위로 가져가고
 *     (ERP상태=등록중), ERP 등록 후 POST action=result 로 완료/실패를 돌려준다.
 *  4) PC는 POST action=heartbeat 로 살아 있음을 알린다(스크립트 속성에만 저장, 시트 쓰기 없음).
 *
 * ERP 등록은 관리자가 버튼을 눌렀을 때만 진행된다. 시간 기반 트리거는 만들지 않는다.
 *
 * 스크립트 속성
 *  - ERP_BOT_TOKEN            : PC 프로그램 인증 토큰 (필수, 비어 있으면 모든 PC 요청 거부)
 *  - ERP_ALERT_EMAIL          : 실패/로그인필요 알림 메일 기본 수신자
 *  - ERP_ALERT_EMAIL_<사이트> : 사이트별 수신자 (예: ERP_ALERT_EMAIL_화성). 없으면 ERP_ALERT_EMAIL
 *  - ERP_BOT_LAST_<사이트>    : heartbeat가 자동 기록 (직접 설정하지 않음)
 */

const PURCHASE_TYPE_SHEET_NAME = '구매유형';
// 1~14열은 요청 명세의 열 구성 그대로, 15열 '확인필요'는 조건표 초안의 확인 메모를 보존하기 위한 참고 열이다.
// 16~18열은 조건표 교체(2026-11) 때 맨 오른쪽에 추가한 열. 시트에서는 열 이름으로 찾으므로 순서가 달라도 된다.
//  - 라인분리=Y   : 같은 버튼 클릭이라도 라인이 다르면 배치를 나눈다(명칭의 {라인}이 하나만 들어가게).
//  - 원인부서      : ERP 원인부서 칸 값.
//  - 기타요청사유  : ERP 기타요청사유 칸 문구. {명칭과 동일}이면 만들어진 명칭을 그대로 쓴다.
const PURCHASE_TYPE_HEADERS = [
  '사이트', '유형코드', '구매유형', '용도', '유무상', '유무상상세', '사유1', '사유2', '설비구분',
  '명칭템플릿', '입력항목', '등록단위', '기본값', '사용', '확인필요', '라인분리', '원인부서', '기타요청사유'
];
// 이 중 하나라도 비어 있거나 '확인필요'로 적혀 있으면 조건 미완성 유형으로 보고 등록을 막는다.
const PURCHASE_TYPE_REQUIRED_FIELDS = ['용도', '유무상', '유무상상세', '사유1', '사유2', '명칭템플릿'];
const PURCHASE_TYPE_PLACEHOLDER = '확인필요';
const PURCHASE_TYPE_CACHE_KEY = 'purchaseTypes:v2';
const PURCHASE_TYPE_CACHE_SEC = 600;
const PURCHASE_TYPE_DEFAULT_EQUIPMENT = 'SCRUBBER';
// 기타요청사유 템플릿에서 "만들어진 명칭 그대로"를 뜻하는 변수.
const ERP_REASON_SAME_AS_TITLE = '명칭과 동일';
// 긴급 등록 배치는 기타요청사유 끝에 이 문구를 붙인다(명칭은 그대로).
const ERP_URGENT_REASON_SUFFIX = ' 긴급요망';

// 구매유형 자동 제안 규칙 시트. 시트를 고치면 코드 수정 없이 반영된다(10분 캐시, 편집 시 onEdit가 캐시 삭제).
const PROPOSAL_RULE_SHEET_NAME = '유형제안규칙';
const PROPOSAL_RULE_HEADERS = ['우선순위', '사이트', '조건종류', '조건값', '유형코드', '사용', '설명'];
const PROPOSAL_RULE_CACHE_KEY = 'proposalRules:v1';
const PROPOSAL_RULE_ALL_SITES = '전체';
const RULE_KIND = {
  ROUTE: '구매경로',
  SAFETY_EQUIPMENT: '안전용품 사용설비',
  NOTE_WORD: '특이사항 단어',
  NAME_CONTAINS: '자재명 포함',
  LAST_CONFIRMED: '이전 확정',
  DEFAULT: '기본값'
};
// 초기 규칙(시트가 없거나 비어 있을 때만 채운다). 열 순서는 PROPOSAL_RULE_HEADERS와 같다.
const PROPOSAL_RULE_SEED_ROWS = [
  [10, '화성', '구매경로', '안전재고', 'H-03', 'Y', '안전재고 메뉴로 들어온 요청'],
  [10, '평택', '구매경로', '안전재고', 'P-01', 'Y', '안전재고 메뉴로 들어온 요청'],
  [10, '기흥', '구매경로', '안전재고', 'G-02', 'Y', '안전재고 메뉴로 들어온 요청'],
  [20, '화성', '안전용품 사용설비', '안전용품', 'H-06', 'Y', '안전용품구매 + 사용자재 시트 사용설비'],
  [20, '화성', '안전용품 사용설비', '환경안전용품', 'H-07', 'Y', '안전용품구매 + 사용자재 시트 사용설비'],
  [20, '화성', '안전용품 사용설비', '환경안전용품-공구', 'H-08', 'Y', '안전용품구매 + 사용자재 시트 사용설비'],
  [20, '평택', '안전용품 사용설비', '안전용품', 'P-05', 'Y', '안전용품구매 + 사용자재 시트 사용설비'],
  [20, '평택', '안전용품 사용설비', '환경안전용품-공구', 'P-06', 'Y', '안전용품구매 + 사용자재 시트 사용설비'],
  [20, '기흥', '안전용품 사용설비', '안전용품,환경안전용품,환경안전용품-공구', 'G-06', 'Y', '쉼표 = 어느 하나라도'],
  [30, '화성', '특이사항 단어', 'CS무상', 'H-05', 'Y', '특이사항1/2에 단어 포함'],
  [30, '평택', '특이사항 단어', 'WI', 'P-03', 'Y', '영문은 단어 단위로만(WIRE 제외)'],
  [30, '평택', '특이사항 단어', 'WO', 'P-04', 'Y', '영문은 단어 단위로만(TWO 제외)'],
  [30, '기흥', '특이사항 단어', 'WI', 'G-07', 'Y', '영문은 단어 단위로만(WIRE 제외)'],
  [30, '기흥', '특이사항 단어', 'WO', 'G-05', 'Y', '영문은 단어 단위로만(TWO 제외)'],
  [40, '화성', '자재명 포함', '폐수+BOTTLE', 'H-02', 'Y', '+ = 모두 포함'],
  [90, '전체', '이전 확정', '', '', 'Y', '같은 사이트·자재코드의 마지막 확정 유형'],
  [99, '전체', '기본값', '', '', 'Y', '구매유형 시트의 기본값=Y 유형']
];

// 구매발주및입고 시트 맨 오른쪽에 추가하는 열(기존 열 위치 불변 — sheet_()의 ensureColumns_가 끝에 덧붙인다).
// '제안근거'는 조건표 교체(2026-11) 때 추가한 열(자동 제안이 어느 규칙으로 정해졌는지).
const ERP_COLUMNS = [
  '구매유형코드', '유형상태', '긴급', '명칭변수', 'ERP상태', 'ERP명칭', 'ERP처리일시', 'ERP메시지', '배치ID', '처리자', '제안근거'
];
const ERP_STATUS = { WAITING: '대기', RUNNING: '등록중', DONE: '완료', FAILED: '실패' };
// 이 상태의 행은 유형·명칭변수·요청수량을 바꿀 수 없다(실패 행은 수정 후 재처리 가능).
const ERP_LOCKED_STATUSES = [ERP_STATUS.WAITING, ERP_STATUS.RUNNING, ERP_STATUS.DONE];
// 확인필요: 안전용품구매인데 사용설비로 유형을 정하지 못한 행. 자재관리자가 유형을 고르기 전까지 등록 불가.
const TYPE_STATE = { PROPOSED: '제안', CONFIRMED: '확정', NEEDS_CHECK: '확인필요' };
// 사용자가 행의 유형을 직접 바꿨을 때 남기는 제안근거.
const TYPE_REASON_MANUAL = '직접 지정';
// 명칭템플릿 변수 중 입력칸 없이 자동으로 채우는 것({라인} = {SITE}, {NN} = ISO 주차).
const ERP_AUTO_VARS = ['SITE', '라인', 'MM', 'N', 'NN'];
// 등록중인데 이 시간 동안 결과가 없으면 대기로 되돌린다(PC 중단 대비).
const ERP_STALE_MS = 20 * 60 * 1000;
// heartbeat가 이 시간 이상 끊기면 PWA에서 빨간색/경고로 표시한다.
const ERP_BOT_OFFLINE_MS = 10 * 60 * 1000;
// 로그인필요 알림 메일은 같은 상태가 반복되면 이 간격에 1회까지만 보낸다.
const ERP_ALERT_INTERVAL_MS = 60 * 60 * 1000;
// pending 빠른 경로용 캐시 플래그 수명(CacheService 최대값). 사라지면 시트를 한 번 읽어 다시 계산한다.
const ERP_FLAG_TTL_SEC = 21600;
// 청구서 관리 화면 "진행·완료" 탭에 보여 줄 완료 건 기간.
const ERP_DONE_VIEW_DAYS = 7;
const ERP_URGENT_NOTE_KEYWORD = '긴급';
// 청구서 관리 권한: 관리자(전체 사이트) / 자재관리자(Users 시트 '사이트' 열의 사이트만, '전체'면 전체).
const ERP_ADMIN_ROLE = '관리자';
const ERP_SITE_MANAGER_ROLE = '자재관리자';
const ERP_SITE_ALL = '전체';
// 관리자(전체 담당)가 고를 수 있는 사이트.
const ERP_SITES = ['화성', '평택', '기흥'];

// ------------------------- 구매유형 조건표 -------------------------

function isPurchaseTypeBlank_(v) {
  const s = String(v == null ? '' : v).trim();
  return !s || s.indexOf(PURCHASE_TYPE_PLACEHOLDER) !== -1;
}

function templateVars_(template) {
  const out = [];
  String(template || '').replace(/\{([^}]+)\}/g, (m, v) => {
    const name = v.trim();
    if (name && out.indexOf(name) === -1) out.push(name);
    return m;
  });
  return out;
}

// 입력칸으로 보여 줄 변수 목록. 입력항목 열의 순서를 따르되(괄호 설명 제거), 명칭템플릿에 실제로 있는
// 변수만 쓰고 {SITE}/{MM}/{N}은 자동이라 뺀다. 입력항목에 빠진 템플릿 변수도 뒤에 덧붙인다.
function typeInputVars_(t) {
  const tplVars = templateVars_(t['명칭템플릿']).filter(v => ERP_AUTO_VARS.indexOf(v) === -1);
  const vars = [];
  String(t['입력항목'] || '').split(/[,，]/).forEach(tok => {
    const name = tok.replace(/\(.*?\)/g, '').trim();
    if (tplVars.indexOf(name) !== -1 && vars.indexOf(name) === -1) vars.push(name);
  });
  tplVars.forEach(v => { if (vars.indexOf(v) === -1) vars.push(v); });
  return vars;
}

// 구매유형 시트 전체를 읽어 유형 객체 배열로 돌려준다(10분 캐시). 시트가 없으면 빈 배열.
// 시트를 편집하면 onEdit(Setup.gs)가 캐시를 지워 바로 반영된다.
function loadPurchaseTypes_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(PURCHASE_TYPE_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 다시 읽는다 */ }
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PURCHASE_TYPE_SHEET_NAME);
  let types = [];
  if (sheet && sheet.getLastRow() >= 2) {
    const heads = headers_(sheet).map(h => String(h || '').trim());
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, heads.length).getValues();
    types = values
      .map(row => {
        const t = {};
        PURCHASE_TYPE_HEADERS.forEach(h => {
          const i = heads.indexOf(h);
          t[h] = i === -1 ? '' : String(row[i] == null ? '' : row[i]).trim();
        });
        return t;
      })
      .filter(t => t['사이트'] && t['유형코드'])
      .map(t => ({
        site: t['사이트'],
        code: t['유형코드'],
        name: t['구매유형'],
        fields: {
          '설비구분': t['설비구분'] || PURCHASE_TYPE_DEFAULT_EQUIPMENT,
          '용도': t['용도'],
          '유무상': t['유무상'],
          '유무상상세': t['유무상상세'],
          '사유1': t['사유1'],
          '사유2': t['사유2'],
          '원인부서': t['원인부서']
        },
        template: t['명칭템플릿'],
        reasonTemplate: t['기타요청사유'],
        lineSplit: t['라인분리'].toUpperCase() === 'Y',
        inputVars: typeInputVars_(t),
        weekly: String(t['등록단위']).replace(/\s/g, '').indexOf('묶음') !== -1,
        unit: t['등록단위'],
        isDefault: t['기본값'].toUpperCase() === 'Y',
        enabled: t['사용'].toUpperCase() !== 'N',
        incomplete: PURCHASE_TYPE_REQUIRED_FIELDS.some(h => isPurchaseTypeBlank_(t[h])),
        missing: PURCHASE_TYPE_REQUIRED_FIELDS.filter(h => isPurchaseTypeBlank_(t[h]))
      }));
  }
  try {
    cache.put(PURCHASE_TYPE_CACHE_KEY, JSON.stringify(types), PURCHASE_TYPE_CACHE_SEC);
  } catch (e) {
    Logger.log('구매유형 캐시 저장 실패: ' + (e && e.message || e));
  }
  return types;
}

function clearPurchaseTypeCache_() {
  CacheService.getScriptCache().remove(PURCHASE_TYPE_CACHE_KEY);
}

function purchaseTypesForSite_(site) {
  return loadPurchaseTypes_().filter(t => t.site === site);
}

function findPurchaseType_(site, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  return purchaseTypesForSite_(site).find(t => t.code === c) || null;
}

function defaultPurchaseType_(site) {
  return purchaseTypesForSite_(site).find(t => t.isDefault && t.enabled) || null;
}


// ------------------------- 명칭 생성 -------------------------

// 해당 월의 주차: 월요일 시작, 1일이 속한 주 = 1주차.
function weekOfMonth_(date) {
  const y = Number(Utilities.formatDate(date, 'Asia/Seoul', 'yyyy'));
  const m = Number(Utilities.formatDate(date, 'Asia/Seoul', 'M'));
  const d = Number(Utilities.formatDate(date, 'Asia/Seoul', 'd'));
  const firstDow = new Date(y, m - 1, 1).getDay(); // 스크립트 시간대 = Asia/Seoul
  const offset = (firstDow + 6) % 7; // 월요일=0
  return Math.floor((d - 1 + offset) / 7) + 1;
}

// ISO 8601 주차(월요일 시작, 그 해 첫 목요일이 있는 주 = 1주차). 등록일 기준 Asia/Seoul.
function isoWeek_(date) {
  const y = Number(Utilities.formatDate(date, 'Asia/Seoul', 'yyyy'));
  const m = Number(Utilities.formatDate(date, 'Asia/Seoul', 'M'));
  const d = Number(Utilities.formatDate(date, 'Asia/Seoul', 'd'));
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7)); // 그 주의 목요일
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.floor((t - yearStart) / 86400000 / 7) + 1;
}

// 명칭/기타요청사유 템플릿에 넣을 값.
//  - {SITE}·{라인}: 묶음 행들의 라인 값(중복 제거 후 ', ' 연결)
//  - {MM}: 등록일 월, {N}: 월 기준 주차, {NN}: ISO 주차 2자리
//  - {PART}: 명칭변수 PART를 입력했으면 그 값. 비어 있으면 배치의 품목 수(서로 다른 자재코드 수)로 정한다:
//            1개 → 그 품목의 자재명 / 2개 이상 → 'PART'. 1개일 때는 템플릿의 "{PART} 등"에서 " 등"을 지운다.
const ERP_PART_MULTI = 'PART';
const ERP_PART_SINGLE_FLAG = '__partSingle';
function erpTemplateValues_(rows, vars, date) {
  const d = date || new Date();
  const list = rows || [];
  const lines = [];
  list.forEach(r => {
    const z = String(r['라인'] || '').trim();
    if (z && lines.indexOf(z) === -1) lines.push(z);
  });
  const values = Object.assign({}, vars || {});
  values.SITE = lines.join(', ');
  values['라인'] = values.SITE;
  values.MM = Utilities.formatDate(d, 'Asia/Seoul', 'M');
  values.N = String(weekOfMonth_(d));
  values.NN = ('0' + isoWeek_(d)).slice(-2);
  if (!String(values.PART == null ? '' : values.PART).trim() && list.length) {
    const codes = [];
    list.forEach(r => {
      const c = normalizeMaterialCode_(r['자재코드']) || String(r['자재명'] || '').trim();
      if (codes.indexOf(c) === -1) codes.push(c);
    });
    if (codes.length === 1) {
      values.PART = String(list[0]['자재명'] || list[0]['자재코드'] || '').trim();
      values[ERP_PART_SINGLE_FLAG] = true;
    } else {
      values.PART = ERP_PART_MULTI;
    }
  }
  return values;
}

// 템플릿의 {변수}를 값으로 바꾼다. 값이 빈 괄호 변수("({버전})")는 괄호째 지우고 연속 공백을 정리한다.
function fillErpTemplate_(template, values) {
  const valueOf = name => String(values[name.trim()] == null ? '' : values[name.trim()]).trim();
  let s = String(template || '');
  // PART를 자동으로 채웠고 품목이 1개면 "{PART} 등"의 " 등"을 지운다.
  if (values[ERP_PART_SINGLE_FLAG]) s = s.replace(/\{\s*PART\s*\}\s*등(?=\s|$)/g, '{PART}');
  s = s.replace(/\(\s*\{([^}]+)\}\s*\)/g, (m, v) => {
    const val = valueOf(v);
    return val ? '(' + val + ')' : '';
  });
  s = s.replace(/\{([^}]+)\}/g, (m, v) => valueOf(v));
  return s.replace(/\s{2,}/g, ' ').trim();
}

/**
 * ERP 구매요청서 명칭을 만든다.
 *  - typeRow: 유형 객체(loadPurchaseTypes_) 또는 { '명칭템플릿': ... } / { template: ... }
 *  - rows: 묶음에 포함된 구매발주및입고 행들
 *  - vars: 입력 변수 { PART: 'PRE-WET', ... }
 *  - date: 등록일
 * 변수 규칙은 erpTemplateValues_ 참고.
 */
function buildErpTitle(typeRow, rows, vars, date) {
  const template = String((typeRow && (typeRow.template || typeRow['명칭템플릿'])) || '');
  return fillErpTemplate_(template, erpTemplateValues_(rows, vars, date));
}

/**
 * ERP 기타요청사유를 만든다. {명칭과 동일}은 title로, 나머지 변수는 명칭과 같은 규칙으로 바꾼다.
 * 긴급 등록 배치는 끝에 " 긴급요망"을 붙인다(명칭은 그대로).
 */
function buildErpReason(typeRow, rows, vars, date, title, urgent) {
  const template = String((typeRow && (typeRow.reasonTemplate || typeRow['기타요청사유'])) || '');
  const values = erpTemplateValues_(rows, vars, date);
  values[ERP_REASON_SAME_AS_TITLE] = title == null ? buildErpTitle(typeRow, rows, vars, date) : title;
  const reason = fillErpTemplate_(template, values);
  return urgent && reason ? reason + ERP_URGENT_REASON_SUFFIX : reason;
}

// ------------------------- 구매유형 자동 제안 -------------------------

// 글자 비교용: NFC 정규화 + 모든 공백 제거 + 대문자 ("안전 용품" = "안전용품", "환경안전 용품 - 공구" = "환경안전용품-공구").
function ruleNorm_(s) {
  return stripSpaces_(normalizeForSearch_(s)).toUpperCase();
}

// 쉼표(전각 포함)로 나눈 값 목록(정규화, 빈값 제외).
function ruleList_(s) {
  return String(s == null ? '' : s).split(/[,，]/).map(ruleNorm_).filter(Boolean);
}

// 유형제안규칙 시트를 읽어 사용 중인 규칙을 우선순위(같으면 시트 순서)대로 돌려준다(10분 캐시).
function loadProposalRules_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(PROPOSAL_RULE_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* 다시 읽는다 */ }
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(PROPOSAL_RULE_SHEET_NAME);
  let rules = [];
  if (sheet && sheet.getLastRow() >= 2) {
    const heads = headers_(sheet).map(h => String(h || '').trim());
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, heads.length).getValues();
    const get = (row, h) => {
      const i = heads.indexOf(h);
      return i === -1 ? '' : String(row[i] == null ? '' : row[i]).trim();
    };
    rules = values
      .map((row, i) => ({
        order: i,
        priority: Number(get(row, '우선순위')) || 0,
        site: get(row, '사이트'),
        kind: ruleNorm_(get(row, '조건종류')),
        value: get(row, '조건값'),
        code: get(row, '유형코드'),
        enabled: get(row, '사용').toUpperCase() !== 'N'
      }))
      .filter(r => r.enabled && r.kind && r.site)
      .sort((a, b) => a.priority - b.priority || a.order - b.order);
  }
  try {
    cache.put(PROPOSAL_RULE_CACHE_KEY, JSON.stringify(rules), PURCHASE_TYPE_CACHE_SEC);
  } catch (e) {
    Logger.log('유형제안규칙 캐시 저장 실패: ' + (e && e.message || e));
  }
  return rules;
}

function clearProposalRuleCache_() {
  CacheService.getScriptCache().remove(PROPOSAL_RULE_CACHE_KEY);
}

// 요청이 들어온 메뉴: 라인 열 값이 안전재고/안전용품 표식이면 그 메뉴(submitPurchase_가 라인 대신 넣는 값), 아니면 일반 라인 요청.
function purchaseRouteOf_(r) {
  const zone = ruleNorm_(r['라인']);
  if (zone === ruleNorm_(SAFETY_STOCK_ZONE)) return SAFETY_STOCK_ZONE;
  if (zone === ruleNorm_(SAFETY_SUPPLY_ZONE)) return SAFETY_SUPPLY_ZONE;
  return '';
}

// 특이사항 단어 일치. 영문/숫자만으로 된 값(WI, WO 등)은 단어 단위로만 본다(WIRE, TWO 제외).
// 이때 영문 사이의 '/'는 무시한다(W/O = WO). 그 외 값은 띄어쓰기를 무시한 포함 여부.
function noteHasWord_(text, word) {
  if (/^[A-Z0-9]+$/.test(word)) {
    const t = normalizeForSearch_(text).toUpperCase().replace(/([A-Z0-9])\/(?=[A-Z0-9])/g, '$1');
    return new RegExp('(^|[^A-Z0-9])' + word + '(?![A-Z0-9])').test(t);
  }
  return ruleNorm_(text).indexOf(word) !== -1;
}

// 자재명 포함: 쉼표 = 어느 하나라도, '+' = 모두 포함.
function nameContains_(name, value) {
  const n = ruleNorm_(name);
  return String(value || '').split(/[,，]/).some(alt => {
    const parts = alt.split('+').map(ruleNorm_).filter(Boolean);
    return parts.length > 0 && parts.every(p => n.indexOf(p) !== -1);
  });
}

// 사이트 사용자재 시트: 자재코드 → 사용설비, 세트명 → 사용설비.
function readUsedEquipmentMap_(site) {
  const byCode = {};
  const bySet = {};
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(usedMaterialsSheetName_(site));
  if (!sheet) return { byCode, bySet };
  readAll_(sheet).forEach(r => {
    const eq = String(r['사용설비'] || '').trim();
    const code = normalizeMaterialCode_(r['자재코드']);
    if (code && !(code in byCode)) byCode[code] = eq;
    if (isSetItemName_(r['품명'])) {
      const name = normalizeSetName_(r['품명']);
      if (!(name in bySet)) bySet[name] = eq;
    }
  });
  return { byCode, bySet };
}

// 구매발주및입고 시트: 자재코드 → 마지막(가장 아래 행) 확정 유형코드. 필요한 3개 열만 읽는다.
function readLastConfirmedTypeMap_(site) {
  const map = {};
  const sheet = sheet_(poInSheetName_(site));
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return map;
  const heads = headers_(sheet);
  const cols = ['자재코드', '구매유형코드', '유형상태'].map(h => heads.indexOf(h));
  if (cols.some(c => c === -1)) return map;
  const read = c => sheet.getRange(2, c + 1, lastRow - 1, 1).getValues();
  const codes = read(cols[0]);
  const types = read(cols[1]);
  const states = read(cols[2]);
  for (let i = 0; i < codes.length; i++) {
    const type = String(types[i][0] || '').trim();
    if (!type || String(states[i][0] || '').trim() !== TYPE_STATE.CONFIRMED) continue;
    const code = normalizeMaterialCode_(codes[i][0]);
    if (code) map[code] = type;
  }
  return map;
}

// 한 사이트의 제안 계산에 쓰는 데이터. 사용자재/이전 확정은 필요할 때 한 번만 읽는다.
function proposalContext_(site) {
  const ctx = {
    site,
    types: purchaseTypesForSite_(site).filter(t => t.enabled),
    rules: loadProposalRules_().filter(r => r.site === site || r.site === PROPOSAL_RULE_ALL_SITES),
    equip: null,
    confirmed: null
  };
  ctx.typeOk = code => ctx.types.some(t => t.code === code);
  ctx.equipmentOf = r => {
    if (!ctx.equip) ctx.equip = readUsedEquipmentMap_(site);
    const code = normalizeMaterialCode_(r['자재코드']);
    if (code && code in ctx.equip.byCode) return ctx.equip.byCode[code];
    // 세트 구성 자재는 사용자재 시트에 세트명으로만 있을 수 있다(비고 "[세트: *** 세트명]").
    const m = String(r['비고'] || '').match(/\[세트:\s*(.+?)\]/);
    if (m) {
      const name = normalizeSetName_(m[1]);
      if (name in ctx.equip.bySet) return ctx.equip.bySet[name];
    }
    return '';
  };
  ctx.lastConfirmedOf = r => {
    if (!ctx.confirmed) ctx.confirmed = readLastConfirmedTypeMap_(site);
    return ctx.confirmed[normalizeMaterialCode_(r['자재코드'])] || '';
  };
  return ctx;
}

/**
 * 구매발주및입고 행 하나의 구매유형을 제안한다. 반환 { code, state, reason }.
 * 규칙을 우선순위대로 검사해 처음 맞는 규칙의 유형(사용 중인 유형만)을 쓴다.
 * 안전용품구매 행은 구매경로/안전용품 사용설비 규칙만 보고, 맞는 것이 없으면 기본값으로 넘기지 않고
 * { code: '', state: 확인필요 }를 돌려준다.
 */
function proposeTypeForRow_(r, ctx) {
  const route = purchaseRouteOf_(r);
  const isSupply = route === SAFETY_SUPPLY_ZONE;
  let equipment = null;
  for (let i = 0; i < ctx.rules.length; i++) {
    const rule = ctx.rules[i];
    let code = rule.code;
    let reason = '';
    switch (rule.kind) {
      case ruleNorm_(RULE_KIND.ROUTE):
        if (route && ruleList_(rule.value).indexOf(ruleNorm_(route)) !== -1) reason = route + ' 메뉴';
        break;
      case ruleNorm_(RULE_KIND.SAFETY_EQUIPMENT): {
        if (!isSupply) break;
        if (equipment === null) equipment = String(ctx.equipmentOf(r) || '').trim();
        const have = ruleList_(equipment);
        if (have.length && ruleList_(rule.value).some(v => have.indexOf(v) !== -1)) reason = '사용설비:' + equipment;
        break;
      }
      case ruleNorm_(RULE_KIND.NOTE_WORD): {
        if (isSupply) break;
        const note = String(r['특이사항1'] || '') + ' ' + String(r['특이사항2'] || '');
        const hit = String(rule.value || '').split(/[,，]/).map(v => v.trim()).filter(Boolean)
          .find(v => noteHasWord_(note, ruleNorm_(v)));
        if (hit) reason = '특이사항:' + hit;
        break;
      }
      case ruleNorm_(RULE_KIND.NAME_CONTAINS):
        if (!isSupply && nameContains_(r['자재명'], rule.value)) reason = '자재명:' + rule.value;
        break;
      case ruleNorm_(RULE_KIND.LAST_CONFIRMED):
        if (isSupply) break;
        code = ctx.lastConfirmedOf(r);
        if (code) reason = '이전 확정';
        break;
      case ruleNorm_(RULE_KIND.DEFAULT): {
        if (isSupply) break;
        const def = ctx.types.find(t => t.isDefault);
        code = def ? def.code : '';
        if (code) reason = '기본값';
        break;
      }
      default:
        break;
    }
    // 삭제됐거나 사용하지 않는 유형을 가리키는 규칙은 건너뛴다.
    if (reason && code && ctx.typeOk(code)) return { code, state: TYPE_STATE.PROPOSED, reason };
  }
  if (isSupply) {
    if (equipment === null) equipment = String(ctx.equipmentOf(r) || '').trim();
    return { code: '', state: TYPE_STATE.NEEDS_CHECK, reason: equipment ? '사용설비:' + equipment + '(규칙 없음)' : '사용설비 없음' };
  }
  return { code: '', state: '', reason: '' };
}

// 제안 결과를 구매발주및입고 행의 ERP 열 값으로 바꾼다.
function proposalToRowValues_(p) {
  return { '구매유형코드': p.code, '유형상태': p.state, '제안근거': p.reason };
}

/**
 * 미등록(ERP상태 빈값/실패, 취소 아님) 행 중 조건에 맞는 행의 제안을 다시 계산해 시트에 쓴다. 바뀐 행 수를 돌려준다.
 *  - mode 'proposed': 유형상태가 제안/확인필요인 행 (관리자 "제안 다시 계산")
 *  - mode 'deleted' : 구매유형코드가 조건표에 없는(삭제된) 행 — 확정 행도 포함 (조건표 교체 직후)
 * 대기/등록중/완료 행은 건드리지 않는다. 호출부에서 스크립트 락을 잡는다.
 */
function reproposeRows_(site, mode) {
  const sheet = sheet_(poInSheetName_(site));
  const heads = headers_(sheet);
  const ctx = proposalContext_(site);
  const allCodes = purchaseTypesForSite_(site).map(t => t.code);
  const updates = {};
  let count = 0;
  readAll_(sheet).forEach(r => {
    const st = erpStatusOf_(r);
    if (st !== '' && st !== ERP_STATUS.FAILED) return;
    if (isCancelledRow_(r)) return;
    const code = String(r['구매유형코드'] || '').trim();
    const state = String(r['유형상태'] || '').trim();
    if (mode === 'deleted') {
      if (!code || allCodes.indexOf(code) !== -1) return;
    } else if (state !== TYPE_STATE.PROPOSED && state !== TYPE_STATE.NEEDS_CHECK) {
      return;
    }
    const u = proposalToRowValues_(proposeTypeForRow_(r, ctx));
    if (!u['유형상태']) u['유형상태'] = TYPE_STATE.PROPOSED; // 맞는 규칙이 없어도 미확정 상태로 둔다
    if (u['구매유형코드'] === code && u['유형상태'] === state && u['제안근거'] === String(r['제안근거'] || '').trim()) return;
    updates[r._row] = u;
    count++;
  });
  writeErpUpdates_(sheet, heads, updates);
  return count;
}

/**
 * 관리자 "제안 다시 계산": 유형상태가 제안/확인필요인 미등록 행에만 규칙을 다시 적용한다.
 * body: { site, pin }
 */
function erpRepropose_(body) {
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    const access = erpAccess_(body.pin);
    if (access.user.role !== ERP_ADMIN_ROLE) throw new Error('제안 다시 계산은 관리자만 사용할 수 있습니다.');
    const site = resolveErpSite_(access, body.site);
    clearProposalRuleCache_();
    return { site, count: reproposeRows_(site, 'proposed') };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------- 공용 헬퍼 -------------------------

function erpStatusOf_(r) {
  return String(r['ERP상태'] || '').trim();
}

function isErpUrgentRow_(r) {
  return String(r['긴급'] || '').trim().toUpperCase() === 'Y';
}

function hasUrgentNote_(r) {
  return (String(r['특이사항1'] || '') + ' ' + String(r['특이사항2'] || '')).indexOf(ERP_URGENT_NOTE_KEYWORD) !== -1;
}

// 청구서 관리 대상: 입고확인에서 구매필요(X)로 확정됐고 아직 구매요청번호가 없는 건(=구매 다운로드 대상과 동일).
function isErpCandidateRow_(r) {
  return computeInboundStatus_(r).status === '구매대기';
}

function parseErpVars_(v) {
  if (!v) return {};
  try {
    const o = JSON.parse(String(v));
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch (e) {
    return {};
  }
}

function toTimeMs_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? 0 : v.getTime();
  const s = String(v || '').trim();
  if (!s) return 0;
  const t = new Date(s.replace(' ', 'T')).getTime();
  return isNaN(t) ? 0 : t;
}

function fmtDateTime_(v) {
  const t = toTimeMs_(v);
  return t ? Utilities.formatDate(new Date(t), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') : '';
}

// 여러 행의 ERP 열 값을 한 번의 getValues/setValues로 쓴다. updates = { 행번호: { 열이름: 값 } }.
// 범위 안에 ERP 열이 아닌 열이 끼어 있으면(수식 보호) 행별 쓰기로 대신한다.
function writeErpUpdates_(sheet, heads, updates) {
  const rowIdxs = Object.keys(updates).map(Number).filter(n => n >= 2);
  if (!rowIdxs.length) return;
  const colIdxs = [];
  rowIdxs.forEach(ri => Object.keys(updates[ri]).forEach(name => {
    const c = heads.indexOf(name);
    if (c === -1) throw new Error('"' + sheet.getName() + '" 시트에서 "' + name + '" 열을 찾을 수 없습니다.');
    if (colIdxs.indexOf(c) === -1) colIdxs.push(c);
  }));
  const minR = Math.min.apply(null, rowIdxs);
  const maxR = Math.max.apply(null, rowIdxs);
  const minC = Math.min.apply(null, colIdxs);
  const maxC = Math.max.apply(null, colIdxs);
  const spanHeads = heads.slice(minC, maxC + 1);
  if (spanHeads.some(h => ERP_COLUMNS.indexOf(h) === -1)) {
    rowIdxs.forEach(ri => updateRow_(sheet, ri, updates[ri]));
    return;
  }
  const range = sheet.getRange(minR, minC + 1, maxR - minR + 1, maxC - minC + 1);
  const values = range.getValues();
  rowIdxs.forEach(ri => {
    const u = updates[ri];
    Object.keys(u).forEach(name => { values[ri - minR][heads.indexOf(name) - minC] = u[name]; });
  });
  range.setValues(values);
}

function erpFlagKey_(scope, site) {
  return (scope === 'urgent' ? 'ERP_PENDING_URGENT_' : 'ERP_PENDING_ALL_') + site;
}

function erpInflightKey_(site) {
  return 'ERP_INFLIGHT_' + site;
}

// 시트 행 기준으로 사이트의 pending 플래그를 다시 계산해 캐시에 넣는다.
//  - URGENT: 긴급=Y 대기 건이 있으면 1 / ALL: 대기 건이 있으면 1
//  - INFLIGHT: 가장 오래된 등록중 건의 ERP처리일시(ms), 없으면 0 (20분 초과 되돌림 확인용)
function refreshErpFlags_(site, rows) {
  let urgent = false;
  let all = false;
  let oldestRunning = 0;
  rows.forEach(r => {
    const st = erpStatusOf_(r);
    if (st === ERP_STATUS.WAITING) {
      all = true;
      if (isErpUrgentRow_(r)) urgent = true;
    } else if (st === ERP_STATUS.RUNNING) {
      const t = toTimeMs_(r['ERP처리일시']) || 1;
      if (!oldestRunning || t < oldestRunning) oldestRunning = t;
    }
  });
  const flags = {};
  flags[erpFlagKey_('urgent', site)] = urgent ? '1' : '0';
  flags[erpFlagKey_('all', site)] = all ? '1' : '0';
  flags[erpInflightKey_(site)] = String(oldestRunning || 0);
  CacheService.getScriptCache().putAll(flags, ERP_FLAG_TTL_SEC);
}

function setErpPendingFlags_(site, urgent) {
  const flags = {};
  flags[erpFlagKey_('all', site)] = '1';
  if (urgent) flags[erpFlagKey_('urgent', site)] = '1';
  CacheService.getScriptCache().putAll(flags, ERP_FLAG_TTL_SEC);
}

function erpAlertEmail_(site) {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty('ERP_ALERT_EMAIL_' + site) || props.getProperty('ERP_ALERT_EMAIL') || '';
}

function sendErpAlert_(site, subject, body) {
  const to = erpAlertEmail_(site);
  if (!to) {
    Logger.log('ERP 알림 수신자 미설정(' + site + '): ' + subject);
    return false;
  }
  try {
    MailApp.sendEmail(to, subject, body);
    return true;
  } catch (e) {
    Logger.log('ERP 알림 메일 실패: ' + (e && e.message || e));
    return false;
  }
}

function erpTokenOk_(token) {
  const expected = PropertiesService.getScriptProperties().getProperty('ERP_BOT_TOKEN') || '';
  return !!expected && String(token || '') === expected;
}

function parseErpSites_(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  const sites = list.map(s => String(s || '').trim()).filter(s => SITES.indexOf(s) !== -1);
  return sites.length ? sites.filter((s, i) => sites.indexOf(s) === i) : SITES.slice();
}

// ------------------------- PWA: 청구서 관리 -------------------------

// 청구서 관리 사용 권한과 담당 사이트. multi=true면 사이트 선택 가능(관리자 또는 사이트='전체').
function erpAccess_(pin) {
  const user = handleLogin_(pin);
  const isAdmin = user.role === ERP_ADMIN_ROLE;
  if (!isAdmin && user.role !== ERP_SITE_MANAGER_ROLE) {
    throw new Error('청구서 관리는 관리자와 자재관리자만 사용할 수 있습니다.');
  }
  if (isAdmin || user.site === ERP_SITE_ALL) return { user, multi: true, sites: ERP_SITES.slice() };
  if (!user.site) throw new Error('유저 시트에 사이트를 지정해 주세요');
  if (SITES.indexOf(user.site) === -1) throw new Error('유저 시트의 사이트 값이 올바르지 않습니다: ' + user.site);
  return { user, multi: false, sites: [user.site] };
}

// 요청한 사이트를 권한에 맞게 정한다. 자재관리자는 자기 사이트로 고정, 관리자는 선택 사이트(없으면 첫 사이트).
// lenient=true(목록 조회)면 담당이 아닌 사이트를 요청해도 오류 없이 담당 사이트를 돌려준다
// (PWA는 처음 들어올 때 상단에서 고른 사이트를 보내므로).
function resolveErpSite_(access, requested, lenient) {
  const site = String(requested || '').trim();
  if (access.sites.indexOf(site) !== -1) return site;
  if (!access.multi && site && !lenient) throw new Error('담당 사이트(' + access.sites[0] + ')만 처리할 수 있습니다.');
  return access.sites[0];
}

function erpBotStatus_(site) {
  const raw = PropertiesService.getScriptProperties().getProperty('ERP_BOT_LAST_' + site);
  let last = null;
  try { last = raw ? JSON.parse(raw) : null; } catch (e) { last = null; }
  if (!last || !last.at) return { site, at: 0, time: '', state: '', pc: '', message: '', offline: true, never: true };
  return {
    site,
    at: last.at,
    time: Utilities.formatDate(new Date(last.at), 'Asia/Seoul', 'MM-dd HH:mm'),
    state: last.state || '',
    pc: last.pc || '',
    message: last.message || '',
    offline: Date.now() - last.at > ERP_BOT_OFFLINE_MS,
    never: false
  };
}

// 화면에 보여 줄 유형/상태/제안근거.
//  - 확인필요 행: 유형 빈값 그대로(기본값으로 채우지 않음)
//  - 유형코드가 비어 있는 이전 행: 사이트 기본 유형을 제안으로 표시(근거 '기본값')
function erpRowTypeView_(r, defaultType) {
  const code = String(r['구매유형코드'] || '').trim();
  const state = String(r['유형상태'] || '').trim();
  const reason = String(r['제안근거'] || '').trim();
  if (code) return { code, state: state || TYPE_STATE.PROPOSED, reason };
  if (state === TYPE_STATE.NEEDS_CHECK) return { code: '', state, reason: reason || '확인필요' };
  if (defaultType) return { code: defaultType.code, state: TYPE_STATE.PROPOSED, reason: '기본값' };
  return { code: '', state: '', reason };
}

function erpRowToView_(r, defaultType) {
  const tv = erpRowTypeView_(r, defaultType);
  return {
    rowIndex: r._row,
    requestDate: sheetDateStr_(r['요청일자']),
    dueDate: sheetDateStr_(r['필요일자']),
    requester: r['신청자'] || '',
    zone: r['라인'] || '',
    itemId: String(r['자재코드'] || ''),
    itemName: r['자재명'] || '',
    spec: r['규격'] || '',
    qty: Number(r['요청수량']) || 0,
    note1: r['특이사항1'] || '',
    note2: r['특이사항2'] || '',
    lineOrderNo: r['라인구매번호'] || '',
    typeCode: tv.code,
    typeState: tv.state,
    typeReason: tv.reason,
    vars: parseErpVars_(r['명칭변수']),
    urgent: isErpUrgentRow_(r),
    urgentNote: hasUrgentNote_(r),
    erpStatus: erpStatusOf_(r),
    erpTitle: r['ERP명칭'] || '',
    erpMessage: r['ERP메시지'] || '',
    erpAt: fmtDateTime_(r['ERP처리일시']),
    batchId: r['배치ID'] || '',
    handler: r['처리자'] || ''
  };
}

function compareErpRows_(a, b) {
  if (a.urgentNote !== b.urgentNote) return a.urgentNote ? -1 : 1;
  if (a.requestDate !== b.requestDate) return a.requestDate < b.requestDate ? 1 : -1;
  return b.rowIndex - a.rowIndex;
}

// 청구서 관리 화면 데이터. rows = 미등록(ERP상태 빈값/실패) 구매대기 건, progress = 대기/등록중 + 최근 완료 건.
function erpRequestList_(requestedSite, pin) {
  const access = erpAccess_(pin);
  const site = resolveErpSite_(access, requestedSite, true);
  const types = purchaseTypesForSite_(site);
  const defaultType = types.find(t => t.isDefault && t.enabled) || null;
  const all = readAll_(sheet_(poInSheetName_(site)));
  const doneSince = Date.now() - ERP_DONE_VIEW_DAYS * 24 * 60 * 60 * 1000;

  const rows = [];
  const progress = [];
  all.forEach(r => {
    const st = erpStatusOf_(r);
    if (st === '' || st === ERP_STATUS.FAILED) {
      if (!isCancelledRow_(r) && isErpCandidateRow_(r)) rows.push(erpRowToView_(r, defaultType));
    } else if (st === ERP_STATUS.WAITING || st === ERP_STATUS.RUNNING ||
      (st === ERP_STATUS.DONE && toTimeMs_(r['ERP처리일시']) >= doneSince)) {
      progress.push(erpRowToView_(r, defaultType));
    }
  });
  rows.sort(compareErpRows_);
  progress.sort((a, b) => (a.erpAt < b.erpAt ? 1 : a.erpAt > b.erpAt ? -1 : b.rowIndex - a.rowIndex));

  return {
    site,
    types,
    rows,
    progress,
    bot: erpBotStatus_(site),
    // 사이트 선택이 가능한 사용자(관리자)는 상단에 모든 사이트의 PC 상태를 함께 표시한다.
    bots: access.multi ? access.sites.map(erpBotStatus_) : [erpBotStatus_(site)],
    sites: access.sites,
    canSelectSite: access.multi,
    canRepropose: access.user.role === ERP_ADMIN_ROLE
  };
}

/**
 * 청구서 관리 화면의 버튼 3개.
 * body: { site, pin, mode: 'save'|'register'|'urgent', items: [{rowIndex, itemId}], typeCode?, vars? }
 *  - typeCode가 있으면 선택한 모든 행에 그 유형을, 없으면 각 행의 현재(제안/확정) 유형을 쓴다.
 *  - vars가 있으면(객체) 그 유형의 입력 변수만 골라 명칭변수에 저장하고, 없으면 각 행의 기존 값을 유지한다.
 *  - save    : 유형상태=확정, 명칭변수 저장 (ERP상태 그대로)
 *  - register: + ERP상태=대기, 긴급=빈값
 *  - urgent  : + ERP상태=대기, 긴급=Y
 */
function erpUpdateRequests_(body) {
  const lock = scriptLock_();
  lock.waitLock(30000);
  try {
    const access = erpAccess_(body.pin);
    const user = access.user;
    const site = resolveErpSite_(access, body.site);
    if (String(body.site || '').trim() !== site) throw new Error('사이트가 바뀌었습니다. 목록을 새로고침하세요.');
    const mode = String(body.mode || '');
    if (['save', 'register', 'urgent'].indexOf(mode) === -1) throw new Error('올바르지 않은 처리 방식입니다.');
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) throw new Error('선택한 행이 없습니다.');

    const typeCode = String(body.typeCode || '').trim();
    const forcedType = typeCode ? findPurchaseType_(site, typeCode) : null;
    if (typeCode && !forcedType) throw new Error('구매유형을 찾을 수 없습니다: ' + typeCode);
    const defaultType = defaultPurchaseType_(site);
    const hasVars = body.vars && typeof body.vars === 'object' && !Array.isArray(body.vars);

    const sheet = sheet_(poInSheetName_(site));
    const heads = headers_(sheet);
    const byRow = {};
    readAll_(sheet).forEach(r => { byRow[r._row] = r; });

    const now = new Date();
    const handler = user.name + ' ' + Utilities.formatDate(now, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    const updates = {};
    const touched = [];
    items.forEach(it => {
      const r = byRow[Number(it.rowIndex)];
      if (!r || normalizeMaterialCode_(r['자재코드']) !== normalizeMaterialCode_(it.itemId)) {
        throw new Error('요청을 찾을 수 없습니다(시트가 바뀌었을 수 있습니다). 목록을 새로고침하세요.');
      }
      const label = (r['자재명'] || r['자재코드']) + ' (' + r._row + '행)';
      const st = erpStatusOf_(r);
      if (ERP_LOCKED_STATUSES.indexOf(st) !== -1) throw new Error('이미 ERP ' + st + ' 상태라 수정할 수 없습니다: ' + label);
      if (isCancelledRow_(r) || !isErpCandidateRow_(r)) throw new Error('구매대기 상태가 아니라 처리할 수 없습니다: ' + label);

      // 유형을 고르지 않았으면 행의 현재 유형을 쓴다. 확인필요 행과 조건표에서 삭제된 유형의 행은
      // 기본값으로 넘기지 않는다(자재관리자가 직접 골라야 함).
      const storedCode = String(r['구매유형코드'] || '').trim();
      const storedState = String(r['유형상태'] || '').trim();
      let type = forcedType;
      if (!type && storedCode) {
        type = findPurchaseType_(site, storedCode);
        if (!type) throw new Error('구매유형 시트에 없는 유형(' + storedCode + ')입니다. 유형을 다시 선택하세요: ' + label);
      }
      if (!type && storedState === TYPE_STATE.NEEDS_CHECK) throw new Error('확인필요 행입니다. 구매유형을 선택하세요: ' + label);
      if (!type) type = defaultType;
      if (!type) throw new Error('구매유형을 선택하세요: ' + label);
      if (!type.enabled) throw new Error('사용하지 않는 구매유형입니다(' + type.code + '): ' + label);
      if (mode !== 'save' && type.incomplete) {
        throw new Error(type.code + ' ' + type.name + ': 구매유형 시트에서 조건을 채워주세요 (' + type.missing.join(', ') + ')');
      }

      let vars = parseErpVars_(r['명칭변수']);
      if (hasVars) {
        vars = {};
        type.inputVars.forEach(v => {
          const val = String(body.vars[v] == null ? '' : body.vars[v]).trim();
          if (val) vars[v] = val;
        });
      }

      const u = {
        '구매유형코드': type.code,
        '유형상태': TYPE_STATE.CONFIRMED,
        '명칭변수': Object.keys(vars).length ? JSON.stringify(vars) : '',
        '처리자': handler
      };
      // 제안과 다른 유형으로 바꿨으면 근거를 '직접 지정'으로 남긴다(같으면 원래 근거 유지).
      if (type.code !== storedCode) u['제안근거'] = forcedType ? TYPE_REASON_MANUAL : '기본값';
      if (mode !== 'save') {
        u['ERP상태'] = ERP_STATUS.WAITING;
        u['긴급'] = mode === 'urgent' ? 'Y' : '';
        u['ERP명칭'] = '';
        u['ERP메시지'] = '';
        u['ERP처리일시'] = '';
        u['배치ID'] = '';
      }
      updates[r._row] = u;
      Object.keys(u).forEach(k => { r[k] = u[k]; });
      touched.push(r);
    });

    writeErpUpdates_(sheet, heads, updates);
    if (mode !== 'save') setErpPendingFlags_(site, mode === 'urgent');

    const viewDefault = defaultPurchaseType_(site);
    return { count: touched.length, mode, rows: touched.map(r => erpRowToView_(r, viewDefault)), bot: erpBotStatus_(site) };
  } finally {
    lock.releaseLock();
  }
}

// ------------------------- ERP 자동등록 PC API -------------------------

/**
 * GET ?action=pending&token=...&scope=urgent|all&sites=화성,평택&pc=화성PC
 * 처리할 건이 없으면 캐시 플래그만 보고 바로 {ok:true,batches:[]}를 돌려준다(시트 읽기 없음).
 */
function erpPending_(p) {
  if (!erpTokenOk_(p.token)) return { ok: false, error: 'unauthorized' };
  const scope = p.scope === 'urgent' ? 'urgent' : 'all';
  const sites = parseErpSites_(p.sites);
  const pc = String(p.pc || '').trim();
  const now = Date.now();

  // 1) 빠른 경로: 요청한 사이트의 플래그가 모두 0이고, 20분 넘은 등록중 건도 없으면 즉시 응답.
  const cache = CacheService.getScriptCache();
  const keys = [];
  sites.forEach(s => { keys.push(erpFlagKey_(scope, s), erpInflightKey_(s)); });
  const flags = cache.getAll(keys);
  const idle = sites.every(s => {
    const flag = flags[erpFlagKey_(scope, s)];
    const inflight = flags[erpInflightKey_(s)];
    if (flag !== '0' || inflight === undefined || inflight === null) return false;
    const t = Number(inflight) || 0;
    return !t || now - t < ERP_STALE_MS;
  });
  if (idle) return { ok: true, batches: [] };

  // 2) 느린 경로: 잠그고 대기 건을 배치로 묶어 등록중으로 바꾼다.
  const claimed = [];
  const stamp = Utilities.formatDate(new Date(now), 'Asia/Seoul', 'yyyyMMdd-HHmmss');
  const lock = scriptLock_();
  lock.waitLock(20000);
  try {
    sites.forEach(site => {
      const sheet = sheet_(poInSheetName_(site));
      const heads = headers_(sheet);
      const rows = readAll_(sheet);
      const updates = {};

      // 등록중인데 20분 넘게 결과가 없는 행은 대기로 되돌린다. 배치ID는 남겨 두어, 늦게 도착한
      // 결과도 다시 가져가기 전까지는 받아들인다(중복 등록 방지).
      rows.forEach(r => {
        if (erpStatusOf_(r) !== ERP_STATUS.RUNNING) return;
        const t = toTimeMs_(r['ERP처리일시']);
        if (t && now - t <= ERP_STALE_MS) return;
        updates[r._row] = { 'ERP상태': ERP_STATUS.WAITING, 'ERP메시지': '20분 동안 결과가 없어 대기로 되돌림' };
        r['ERP상태'] = ERP_STATUS.WAITING;
      });

      const waiting = rows.filter(r => erpStatusOf_(r) === ERP_STATUS.WAITING && (scope === 'all' || isErpUrgentRow_(r)));
      // 같은 버튼 클릭(처리자 = 이름 + 처리 시각) + 같은 유형코드끼리 한 배치. 긴급은 일반과 섞지 않는다.
      // 라인분리=Y 유형은 라인별로 배치를 더 나눈다.
      const groups = {};
      const order = [];
      waiting.forEach(r => {
        const code = String(r['구매유형코드'] || '');
        const type = findPurchaseType_(site, code);
        const lineKey = type && type.lineSplit ? '|' + String(r['라인'] || '').trim() : '';
        const key = (isErpUrgentRow_(r) ? 'U' : 'G') + '|' + String(r['처리자'] || '') + '|' + code + lineKey;
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(r);
      });
      order.sort((a, b) => {
        if (a[0] !== b[0]) return a[0] === 'U' ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });

      order.forEach(key => {
        const groupRows = groups[key];
        const batchId = 'B' + stamp + '-' + SITE_CODES[site] + ('0' + (claimed.length + 1)).slice(-2);
        groupRows.forEach(r => {
          updates[r._row] = Object.assign(updates[r._row] || {}, {
            'ERP상태': ERP_STATUS.RUNNING, '배치ID': batchId, 'ERP처리일시': new Date(now), 'ERP메시지': ''
          });
          r['ERP상태'] = ERP_STATUS.RUNNING;
          r['ERP처리일시'] = new Date(now);
        });
        claimed.push({ site, batchId, urgent: key[0] === 'U', rows: groupRows });
      });

      writeErpUpdates_(sheet, heads, updates);
      refreshErpFlags_(site, rows);
    });
  } finally {
    lock.releaseLock();
  }
  if (claimed.length) Logger.log('ERP pending [' + (pc || '?') + ' / ' + scope + ']: ' + claimed.map(c => c.batchId).join(', '));

  // 3) 배치마다 구매 다운로드와 같은 형식의 xlsx를 만든다(잠금 밖). 실패한 배치는 실패로 기록하고 빼낸다.
  const batches = [];
  const unitMap = claimed.length ? buildItemUnitMap_() : {};
  claimed.forEach(c => {
    try {
      const typeCode = String(c.rows[0]['구매유형코드'] || '').trim();
      const type = findPurchaseType_(c.site, typeCode);
      if (!type) throw new Error('구매유형을 찾을 수 없습니다: ' + (typeCode || '(빈값)'));
      if (type.incomplete) throw new Error(type.code + ' 조건 미완성 (' + type.missing.join(', ') + ')');
      const vars = {};
      c.rows.forEach(r => {
        const v = parseErpVars_(r['명칭변수']);
        Object.keys(v).forEach(k => { if (!vars[k] && v[k]) vars[k] = v[k]; });
      });
      const fileName = c.batchId + '.xlsx';
      const title = buildErpTitle(type, c.rows, vars, new Date(now));
      // fields: 조건표 값 + 원인부서 + 완성된 기타요청사유(긴급 배치는 끝에 " 긴급요망").
      const fields = Object.assign({}, type.fields, {
        '기타요청사유': buildErpReason(type, c.rows, vars, new Date(now), title, c.urgent)
      });
      batches.push({
        batch_id: c.batchId,
        site: c.site,
        type_code: type.code,
        type_name: type.name,
        urgent: c.urgent,
        fields,
        title,
        row_count: c.rows.length,
        file_name: fileName,
        file_b64: buildPurchaseXlsxBase64_(c.batchId, buildPurchaseDownloadRows_(c.rows, unitMap))
      });
    } catch (err) {
      const message = '배치 준비 실패: ' + (err && err.message || err);
      Logger.log(c.batchId + ' ' + message);
      try {
        markErpBatch_(c.site, c.batchId, ERP_STATUS.FAILED, '', message);
        sendErpAlert_(c.site, '[QR 재고] ERP 등록 실패 ' + c.site + ' ' + c.batchId,
          '배치ID: ' + c.batchId + '\n사이트: ' + c.site + '\n유형: ' + (c.rows[0]['구매유형코드'] || '') + '\n메시지: ' + message);
      } catch (e) {
        Logger.log('배치 실패 기록 오류: ' + (e && e.message || e));
      }
    }
  });
  return { ok: true, batches };
}

// 구매 다운로드와 같은 열/시트명('구매')으로 임시 스프레드시트를 만들어 xlsx로 내보낸 뒤 base64로 돌려준다.
function buildPurchaseXlsxBase64_(name, downloadRows) {
  const columns = ['자재코드', '자재명', '규격', '단위', '필요일자', '요청수량', '라인'];
  const aoa = [columns].concat(downloadRows.map(r => [r.itemId, r.itemName, r.spec, r.unit, r.dueDate, r.qty, r.zone]));
  const ss = SpreadsheetApp.create('ERP_' + name);
  const fileId = ss.getId();
  try {
    const sh = ss.getSheets()[0];
    sh.setName('구매');
    // 브라우저 다운로드(SheetJS)처럼 자재코드/날짜는 문자 그대로, 요청수량만 숫자로 둔다.
    sh.getRange(1, 1, aoa.length, columns.length).setNumberFormat('@');
    if (aoa.length > 1) sh.getRange(2, 6, aoa.length - 1, 1).setNumberFormat('General');
    sh.getRange(1, 1, aoa.length, columns.length).setValues(aoa);
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

// 배치ID로 행을 찾아 결과를 기록한다. 등록중/대기 행만 바꾼다(되돌린 뒤 다른 배치로 다시 가져간 행은 배치ID가 달라 제외됨).
function markErpBatch_(site, batchId, status, erpTitle, message) {
  const lock = scriptLock_();
  lock.waitLock(20000);
  try {
    const sheet = sheet_(poInSheetName_(site));
    const heads = headers_(sheet);
    const rows = readAll_(sheet);
    const updates = {};
    const matched = [];
    rows.forEach(r => {
      if (String(r['배치ID'] || '').trim() !== batchId) return;
      const st = erpStatusOf_(r);
      if (st !== ERP_STATUS.RUNNING && st !== ERP_STATUS.WAITING) return;
      updates[r._row] = { 'ERP상태': status, 'ERP명칭': erpTitle || '', 'ERP메시지': message || '', 'ERP처리일시': new Date() };
      r['ERP상태'] = status;
      matched.push(r);
    });
    writeErpUpdates_(sheet, heads, updates);
    refreshErpFlags_(site, rows);
    return matched;
  } finally {
    lock.releaseLock();
  }
}

// 배치ID가 어느 사이트 시트에 있는지 배치ID 열만 읽어 찾는다.
function findErpBatchSite_(batchId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  for (let i = 0; i < SITES.length; i++) {
    const sheet = ss.getSheetByName(poInSheetName_(SITES[i]));
    if (!sheet || sheet.getLastRow() < 2) continue;
    const col = headers_(sheet).indexOf('배치ID');
    if (col === -1) continue;
    const values = sheet.getRange(2, col + 1, sheet.getLastRow() - 1, 1).getValues();
    if (values.some(v => String(v[0] || '').trim() === batchId)) return SITES[i];
  }
  return '';
}

/**
 * POST { token, action:"result", batch_id, status:"완료"|"실패", erp_title, message }
 */
function erpResult_(body) {
  if (!erpTokenOk_(body.token)) return { ok: false, error: 'unauthorized' };
  const batchId = String(body.batch_id || '').trim();
  const status = String(body.status || '').trim();
  if (!batchId) return { ok: false, error: 'batch_id가 없습니다.' };
  if (status !== ERP_STATUS.DONE && status !== ERP_STATUS.FAILED) return { ok: false, error: 'status는 완료 또는 실패여야 합니다.' };

  const site = findErpBatchSite_(batchId);
  if (!site) return { ok: false, error: '배치를 찾을 수 없습니다: ' + batchId };
  const message = String(body.message || '').trim();
  const matched = markErpBatch_(site, batchId, status, String(body.erp_title || '').trim(), message);

  if (status === ERP_STATUS.FAILED && matched.length) {
    const handler = String(matched[0]['처리자'] || '');
    sendErpAlert_(site, '[QR 재고] ERP 등록 실패 ' + site + ' ' + batchId,
      '배치ID: ' + batchId + '\n사이트: ' + site + '\n유형: ' + (matched[0]['구매유형코드'] || '') +
      '\n품목 수: ' + matched.length + '\n처리자: ' + handler + '\n메시지: ' + (message || '(없음)') +
      '\n\nPWA 청구서 관리 화면에서 수정 후 다시 등록할 수 있습니다.');
  }
  return { ok: true, updated: matched.length };
}

/**
 * POST { token, action:"heartbeat", pc, sites:["화성"], state:"정상"|"로그인필요", message }
 * 사이트별 스크립트 속성 ERP_BOT_LAST_<사이트>에만 기록한다(시트 쓰기 없음).
 */
function erpHeartbeat_(body) {
  if (!erpTokenOk_(body.token)) return { ok: false, error: 'unauthorized' };
  const sites = parseErpSites_(body.sites);
  const state = String(body.state || '정상').trim();
  const pc = String(body.pc || '').trim();
  const message = String(body.message || '').trim();
  const now = Date.now();
  const props = PropertiesService.getScriptProperties();
  const toSet = {};

  sites.forEach(site => {
    toSet['ERP_BOT_LAST_' + site] = JSON.stringify({ at: now, state, pc, message });
    const alertKey = 'ERP_BOT_ALERT_' + site;
    if (state === '로그인필요') {
      let prev = null;
      try { prev = JSON.parse(props.getProperty(alertKey) || 'null'); } catch (e) { prev = null; }
      if (!prev || prev.state !== state || now - (prev.at || 0) >= ERP_ALERT_INTERVAL_MS) {
        sendErpAlert_(site, '[QR 재고] ERP 자동등록 PC 로그인 필요 (' + site + ')',
          '사이트: ' + site + '\nPC: ' + (pc || '(미상)') + '\n시각: ' +
          Utilities.formatDate(new Date(now), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + '\n메시지: ' + (message || '(없음)'));
        toSet[alertKey] = JSON.stringify({ state, at: now });
      }
    } else if (props.getProperty(alertKey)) {
      props.deleteProperty(alertKey);
    }
  });
  props.setProperties(toSet);
  return { ok: true };
}
