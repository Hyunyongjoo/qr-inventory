// api.js — Apps Script 웹앱과 통신하는 계층
// 배포 후 발급받은 Apps Script 웹앱 URL을 아래에 붙여넣으세요.
// 예: https://script.google.com/macros/s/AKfycbxxxxxxxxxxxxxxxx/exec
const API_BASE_URL = 'https://script.google.com/macros/s/AKfycbyQqfiv4hsU-MQtndycjDfMAZ8ZTlG2B08tgq9EL8sOWiOZENmsbmRfEq6pQWjbSKfK/exec';

const PENDING_QUEUE_KEY = 'qr_inv_pending_queue';

// fetch 자체 실패(오프라인, DNS 오류), HTTP 오류, JSON 파싱 오류를 구분해
// "API 연결 실패" 같은 구체적인 메시지로 변환한다. isNetworkError 플래그로
// 표시해 오프라인 큐 판단(isNetworkError_)이 메시지 문구가 아닌 실제 원인에 기반하도록 한다.
async function fetchJson_(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch (networkErr) {
    const e = new Error('API 연결 실패: 인터넷 연결 또는 Apps Script 배포 URL을 확인하세요.');
    e.isNetworkError = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`API 연결 실패 (HTTP ${res.status}). Apps Script 배포 상태를 확인하세요.`);
    e.isNetworkError = true;
    throw e;
  }
  try {
    return await res.json();
  } catch (parseErr) {
    const e = new Error('API 응답 형식이 올바르지 않습니다. Apps Script 배포 상태를 확인하세요.');
    e.isNetworkError = true;
    throw e;
  }
}

const Api = {
  async get(action, params = {}) {
    const url = new URL(API_BASE_URL);
    url.searchParams.set('action', action);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    const json = await fetchJson_(url.toString(), { method: 'GET' });
    if (!json.success) throw new Error(json.error || '요청 실패');
    return json.data;
  },

  // text/plain 으로 전송해 CORS 프리플라이트(OPTIONS)를 피합니다.
  async post(action, payload = {}) {
    const json = await fetchJson_(API_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ action }, payload))
    });
    if (!json.success) throw new Error(json.error || '요청 실패');
    return json.data;
  },

  // 오프라인일 수 있는 입/출고/이동 요청 전용: 실패 시 로컬 큐에 저장 후 재시도
  async postWithQueue(action, payload = {}) {
    try {
      return { queued: false, data: await this.post(action, payload) };
    } catch (err) {
      if (isNetworkError_(err)) {
        queueAdd_({ action, payload, ts: Date.now() });
        return { queued: true };
      }
      throw err;
    }
  }
};

function isNetworkError_(err) {
  return err instanceof TypeError || err.isNetworkError === true;
}

function queueGet_() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_QUEUE_KEY) || '[]');
  } catch {
    return [];
  }
}

function queueSave_(list) {
  localStorage.setItem(PENDING_QUEUE_KEY, JSON.stringify(list));
}

function queueAdd_(entry) {
  const list = queueGet_();
  list.push(entry);
  queueSave_(list);
}

const OfflineQueue = {
  count() {
    return queueGet_().length;
  },

  // 온라인 복귀 시 대기 중인 요청을 순서대로 서버에 재전송합니다.
  // 각 항목의 결과(성공/실패 사유)를 배열로 반환합니다.
  async flush() {
    const list = queueGet_();
    if (!list.length) return [];
    const results = [];
    const remaining = [];
    for (const entry of list) {
      try {
        const data = await Api.post(entry.action, entry.payload);
        results.push({ entry, success: true, data });
      } catch (err) {
        results.push({ entry, success: false, error: String(err.message || err) });
        // 네트워크 오류면 다시 큐에 남기고, 서버측 검증 오류(예: 재고부족)면 버림
        if (isNetworkError_(err)) remaining.push(entry);
      }
    }
    queueSave_(remaining);
    return results;
  }
};
