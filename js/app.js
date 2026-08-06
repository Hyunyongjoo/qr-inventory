// app.js — QR 자재 입출고 관리 PWA 메인 로직
(() => {
  'use strict';

  const USER_KEY = 'qr_inv_user';
  const SITE_KEY = 'qr_inv_site';
  // 임시 디버그 스위치: QR 파싱/조회 확인용 패널을 스캔 화면에 표시한다. 문제 해결 후 false로 바꾸세요.
  const DEBUG_QR = true;
  const SITES = ['기흥', '화성', '평택'];
  const ZONES = {
    '기흥': ['S1', '6LINE', 'S3', 'S4', 'Display'],
    '화성': ['11LINE', '15LINE', '16LINE', '17LINE', 'NRDLINE'],
    '평택': ['P1', 'P2', 'P3', 'P4', 'S5']
  };

  const state = {
    user: null,
    site: null,
    currentScanItem: null,
    scanType: 'IN',
    scanZone: null,
    html5QrCode: null,
    scanning: false,
    scanBusy: false,
    cart: [],
    currentView: null,
    hasOpenPo: false,
    currentPurchaseItem: null,
    purchaseCart: [],
    purchaseSearchRows: [],
    purchaseSelectedIdx: new Set(),
    currentReturnItem: null,
    returnCart: [],
    returnHtml5QrCode: null,
    returnScanning: false,
    returnScanBusy: false,
    orderOutNo: '',
    orderOutItems: [],
    orderOutHtml5QrCode: null,
    orderOutScanning: false,
    inboundRows: [],
    inboundFilter: null
  };

  // popstate(뒤로가기) 처리 중 switchView가 다시 history.pushState를 호출해
  // 뒤로가기 한 번에 히스토리 항목이 새로 쌓이는 것을 막기 위한 플래그.
  let handlingPopState = false;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // 버튼 클릭 등에서 예외가 발생하면 화면이 아무 반응 없이 멈춘 것처럼 보인다.
  // 어떤 오류든 토스트로 바로 보이게 해서, 다음에 같은 문제가 생겨도 원인을 바로 알 수 있게 한다.
  window.addEventListener('error', (e) => {
    console.error('전역 오류:', e.error || e.message);
    try { toast('오류 발생: ' + (e.message || '알 수 없는 오류'), 'error'); } catch (_) {}
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    console.error('처리되지 않은 오류(Promise):', reason);
    try { toast('오류 발생: ' + ((reason && reason.message) || reason), 'error'); } catch (_) {}
  });

  // ------------------------- 초기화 -------------------------

  window.addEventListener('DOMContentLoaded', init);

  function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW 등록 실패', e));
    }

    // 화면(index.html)과 스크립트(app.js) 버전이 잠깐 어긋난 상태(예: 캐시 갱신 중 일부만
    // 새로 받아온 경우)에서 특정 화면의 요소를 찾지 못해 bindXxx() 하나가 실패하더라도,
    // 그 뒤에 이어지는 다른 화면 바인딩과 로그인 화면 진입까지는 막히지 않게 각각 감싸서 실행한다.
    [bindLogin, bindSite, bindNav, bindActions, bindLine, bindOutMode, bindOrderOut, bindHome, bindScan,
      bindPurchase, bindReturn, bindItems, bindInboundCheck, bindHistory, bindLogout, bindHardRefresh,
      bindBackNavigation, bindPullToRefreshGuard
    ].forEach((bindFn) => {
      try {
        bindFn();
      } catch (err) {
        console.error(bindFn.name + ' 초기화 실패', err);
        try { toast(bindFn.name + ' 초기화 실패: ' + (err.message || err) + ' (캐시 초기화 후 다시 시도해 주세요)', 'error'); } catch (_) {}
      }
    });

    window.addEventListener('online', () => flushQueue(true));

    const saved = localStorage.getItem(USER_KEY);
    if (saved) {
      state.user = JSON.parse(saved);
      enterApp();
    } else {
      showLoginView();
    }
  }

  function toast(message, type = '') {
    const container = $('#toast-container');
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast-' + type : '');
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3200);
  }

  function debounce(fn, delay) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }

  function formatDateTime(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return String(value || '');
    return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }

  // ------------------------- 로그인 -------------------------

  let pinBuffer = '';

  function bindLogin() {
    $$('.pin-key').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.key;
        if (key === 'clear') {
          pinBuffer = '';
        } else if (key === 'back') {
          pinBuffer = pinBuffer.slice(0, -1);
        } else if (pinBuffer.length < 4) {
          pinBuffer += key;
        }
        renderPinDots();
        $('#login-error').classList.add('hidden');
        if (pinBuffer.length === 4) attemptLogin();
      });
    });
  }

  function renderPinDots() {
    $$('.pin-dot').forEach((dot, i) => dot.classList.toggle('filled', i < pinBuffer.length));
  }

  async function attemptLogin() {
    try {
      const user = await Api.post('verifyPin', { pin: pinBuffer });
      state.user = user;
      localStorage.setItem(USER_KEY, JSON.stringify(user));
      pinBuffer = '';
      renderPinDots();
      enterApp();
    } catch (err) {
      $('#login-error').textContent = err.message || '로그인 실패';
      $('#login-error').classList.remove('hidden');
      pinBuffer = '';
      renderPinDots();
    }
  }

  function bindLogout() {
    $('#logout-btn').addEventListener('click', () => {
      if (!confirm('로그아웃 하시겠습니까?')) return;
      localStorage.removeItem(USER_KEY);
      localStorage.removeItem(SITE_KEY);
      state.user = null;
      state.site = null;
      state.cart = [];
      state.currentView = null;
      stopScanning();
      showLoginView();
    });
  }

  // 서비스워커/캐시가 예전 버전을 계속 서빙해서 화면이 이상하게 멈추는 경우를 위한 강제 초기화 버튼.
  // 로그인/사이트 정보(localStorage)는 남겨두고, 캐시된 앱 파일만 지운 뒤 새로고침한다.
  function bindHardRefresh() {
    $('#hard-refresh-btn').addEventListener('click', async () => {
      if (!confirm('앱 캐시를 초기화하고 새로고침할까요? (로그인 정보는 유지됩니다)')) return;
      try {
        if ('serviceWorker' in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        if ('caches' in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
      } catch (err) {
        console.error('캐시 초기화 실패', err);
      } finally {
        location.reload();
      }
    });
  }

  function showLoginView() {
    $('#app-header').classList.add('hidden');
    $('#bottom-nav').classList.add('hidden');
    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-login').classList.remove('hidden');
  }

  async function enterApp() {
    $('#app-header').classList.remove('hidden');
    $('#bottom-nav').classList.remove('hidden');
    $('#view-login').classList.add('hidden');
    $('#worker-name').textContent = state.user.name + (state.user.role ? ` (${state.user.role})` : '');

    const savedSite = localStorage.getItem(SITE_KEY);
    state.site = SITES.includes(savedSite) ? savedSite : null;

    if (state.site) {
      updateSiteBadge();
      // 저장된 사이트가 있어 곧장 "입출고" 화면으로 넘어가더라도, 뒤로가기 히스토리의
      // 맨 아래에는 항상 사이트 선택 화면이 깔려 있어야 한다(둘 다 switchView라 히스토리에
      // 순서대로 쌓이고, 같은 동기 코드 안에서 바로 다음 줄로 덮어써 화면 깜빡임은 없다).
      switchView('site');
      switchView('actions');
    } else {
      switchView('site');
    }
    updateOfflineBadge();
    flushQueue(false);
  }

  // ------------------------- 사이트 선택 -------------------------

  function bindSite() {
    // '.site-btn' 클래스는 라인별/건별 출고 선택 버튼 등 다른 화면에서도 스타일 목적으로
    // 재사용되므로, 사이트 선택 화면(#view-site) 안의 버튼으로만 범위를 한정해야 한다.
    // 문서 전체를 대상으로 하면 다른 화면의 버튼 클릭에도 selectSite(undefined)가 함께
    // 실행되어 state.site가 초기화되고 엉뚱한 화면으로 튕기는 문제가 있었다.
    $$('.site-btn', $('#view-site')).forEach((btn) => {
      btn.addEventListener('click', () => selectSite(btn.dataset.site));
    });
    $('#site-badge').addEventListener('click', () => switchView('site'));
  }

  function selectSite(site) {
    state.site = site;
    state.scanZone = null;
    localStorage.setItem(SITE_KEY, site);
    updateSiteBadge();
    switchView('actions');
  }

  function updateSiteBadge() {
    const badge = $('#site-badge');
    if (state.site) {
      badge.textContent = state.site;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  // ------------------------- 입고/출고 선택 -------------------------

  function bindActions() {
    $('#action-purchase-btn').addEventListener('click', () => startTransactionFlow('PURCHASE'));
    $('#action-in-btn').addEventListener('click', () => startTransactionFlow('IN'));
    $('#action-out-btn').addEventListener('click', () => startTransactionFlow('OUT'));
    $('#action-return-btn').addEventListener('click', () => startTransactionFlow('RETURN'));
  }

  function startTransactionFlow(type) {
    state.scanType = type;
    if (type === 'OUT' || type === 'PURCHASE') {
      state.scanZone = null;
      switchView('line');
      renderLineButtons();
    } else if (type === 'RETURN') {
      goToReturn();
    } else {
      goToScan();
    }
  }

  // ------------------------- 구매/출고 Line 선택 -------------------------

  function bindLine() {
    $('#line-back-btn').addEventListener('click', () => switchView('actions'));
  }

  function renderLineButtons() {
    $('#line-view-title').textContent = state.scanType === 'PURCHASE'
      ? '구매요청할 라인을 선택하세요'
      : '출고할 라인을 선택하세요';
    const grid = $('#line-grid');
    const zones = ZONES[state.site] || [];
    grid.innerHTML = zones.map((z) => `<button class="site-btn" data-zone="${escapeHtml(z)}">${escapeHtml(z)}</button>`).join('');
    $$('.site-btn', grid).forEach((btn) => {
      btn.addEventListener('click', () => {
        state.scanZone = btn.dataset.zone;
        if (state.scanType === 'PURCHASE') {
          goToPurchase();
        } else if (state.scanType === 'OUT' && state.site === '기흥') {
          goToOutMode();
        } else {
          goToScan();
        }
      });
    });
  }

  // ------------------------- 출고 방식 선택 (라인별 / 건별, 기흥 전용) -------------------------

  function bindOutMode() {
    $('#out-mode-back-btn').addEventListener('click', () => {
      switchView('line');
      if (state.currentView === 'line') renderLineButtons();
    });
    $('#out-mode-by-line-btn').addEventListener('click', () => goToScan());
    $('#out-mode-by-order-btn').addEventListener('click', () => goToOrderOut());
  }

  function goToOutMode() {
    switchView('out-mode');
    $('#out-mode-context-label').textContent = `${state.site} · ${state.scanZone} · 출고`;
  }

  function goToScan() {
    state.currentScanItem = null;
    state.cart = [];
    $('#scan-result-card').classList.add('hidden');
    $('#manual-code-input').value = '';
    clearScanError();
    clearLookupError();
    hidePoInfo();
    if (DEBUG_QR) {
      $('#scan-debug-raw').textContent = '';
      $('#scan-debug-lookup').textContent = '';
      debugCheckItemsHealth();
    }
    switchView('scan');
    updateScanContext();
    renderCart();
  }

  function updateScanContext() {
    const label = $('#scan-context-label');
    label.textContent = state.scanType === 'OUT'
      ? `${state.site} · ${state.scanZone} · 출고`
      : `${state.site} · 입고`;
  }

  // ------------------------- 내비게이션 -------------------------

  function bindNav() {
    $$('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }

  // switchView가 실제로 화면을 바꿨으면 true, 사용자가 확인창에서 취소해 화면을 그대로
  // 유지했으면 false를 반환한다. 뒤로가기(popstate) 핸들러가 이 값을 보고 브라우저 히스토리를
  // 앱 화면과 다시 맞출지 판단한다.
  function switchView(name) {
    if (name !== 'site' && !state.site) name = 'site';

    if (state.currentView === 'scan' && name !== 'scan' && state.cart.length > 0) {
      if (!confirm(`담아둔 ${state.cart.length}건이 사라집니다. 이동하시겠습니까?`)) return false;
      state.cart = [];
      renderCart();
    }

    if (state.currentView === 'purchase' && name !== 'purchase' && state.purchaseCart.length > 0) {
      if (!confirm(`담아둔 ${state.purchaseCart.length}건이 사라집니다. 이동하시겠습니까?`)) return false;
      state.purchaseCart = [];
      renderPurchaseCart();
    }

    if (state.currentView === 'return' && name !== 'return' && state.returnCart.length > 0) {
      if (!confirm(`담아둔 ${state.returnCart.length}건이 사라집니다. 이동하시겠습니까?`)) return false;
      state.returnCart = [];
      renderReturnCart();
    }

    if (state.currentView === 'order-out' && name !== 'order-out' && state.orderOutItems.some((it) => it.checked)) {
      if (!confirm('확인한 출고 목록이 사라집니다. 이동하시겠습니까?')) return false;
      state.orderOutNo = '';
      state.orderOutItems = [];
      renderOrderOutSubmitUI();
    }

    $$('.view').forEach((v) => v.classList.add('hidden'));
    $('#view-' + name).classList.remove('hidden');
    $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));

    if (name !== 'scan') stopScanning();
    if (name !== 'return') stopReturnScanning();
    if (name !== 'order-out') stopOrderOutScanning();

    if (name === 'home') loadStock();
    if (name === 'items') loadItems();
    if (name === 'history') loadHistory();
    if (name === 'inbound') populateInboundZoneOptions();

    state.currentView = name;

    // 뒤로가기(popstate)에 반응해 화면을 맞추는 중에는 다시 히스토리를 쌓지 않는다
    // (브라우저가 이미 그 방향으로 이동을 완료한 상태라 여기서 또 push하면 앞으로 가기가 꼬인다).
    if (!handlingPopState) pushViewHistory_(name);
    return true;
  }

  // 사이트 선택 화면이 뒤로가기 히스토리의 맨 아래(루트)다 — enterApp()이 항상 이 화면을
  // 먼저 쌓아두므로, 다른 모든 화면(입출고 탭 포함)에서는 뒤로가기를 누르면 앞서 있던 화면으로
  // 돌아가고, 이 화면에서 뒤로가기를 눌렀을 때만 더 돌아갈 곳이 없으므로 앱 종료를 확인한다.
  function isMainAppScreen_(name) {
    return name === 'site';
  }

  function pushViewHistory_(name) {
    history.pushState({ qrInvView: name }, '', location.href);
  }

  // 하드웨어/브라우저 뒤로가기 버튼(스와이프 포함) 처리.
  // - 메인 화면이면: 취소를 선택했을 때만 히스토리를 다시 쌓아 제자리로 되돌리고, 확인을
  //   선택하면 그대로 두어(브라우저는 이미 뒤로 이동을 마친 뒤) 실제로 앱을 벗어나게(=종료) 한다.
  // - 그 외 화면이면: 그 히스토리 항목에 저장해둔 화면 이름으로 switchView를 호출해 맞춘다.
  function handlePopState_(e) {
    // 로그인 전(switchView가 한 번도 호출되지 않아 아직 앱 화면 추적이 시작되지 않은 상태)에는
    // 관여하지 않고 기본 브라우저 동작에 맡긴다.
    if (!state.currentView) return;

    if (isMainAppScreen_(state.currentView)) {
      // 브라우저는 이미 뒤로 이동을 마친 뒤이므로, 취소를 선택했을 때만 히스토리를 다시
      // 쌓아 제자리로 되돌린다. 확인을 선택하면 그대로 두어 실제로 앱을 벗어나게(=종료) 한다.
      if (!confirm('앱을 종료하시겠습니까?')) {
        pushViewHistory_(state.currentView);
      }
      return;
    }

    const targetView = (e.state && e.state.qrInvView) || 'actions';
    handlingPopState = true;
    const navigated = switchView(targetView);
    handlingPopState = false;

    // 사용자가 확인창에서 취소해 화면을 바꾸지 않았다면, 브라우저 히스토리만 뒤로 간 상태이므로
    // 원래 화면을 다시 쌓아 앱 화면과 히스토리 위치를 맞춘다.
    if (!navigated) pushViewHistory_(state.currentView);
  }

  function bindBackNavigation() {
    window.addEventListener('popstate', handlePopState_);
  }

  // 삼성 인터넷 등 overscroll-behavior CSS만으로는 잡아당김 새로고침(pull-to-refresh)이 완전히
  // 막히지 않는 브라우저를 위한 보강 처리. 실제 스크롤 영역(#view-container)이 이미 맨 위에
  // 있는 상태에서 더 아래로 당기는 제스처만 막고, 리스트를 정상적으로 스크롤하는 중에는
  // 관여하지 않는다(그렇지 않으면 리스트 스크롤 자체가 막혀버린다).
  let ptrGuardStartY = 0;

  function bindPullToRefreshGuard() {
    document.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      ptrGuardStartY = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const scrollEl = document.getElementById('view-container');
      if (!scrollEl) return;
      const deltaY = e.touches[0].clientY - ptrGuardStartY;
      if (deltaY <= 0) return; // 아래로 당기는(=위로 스크롤하려는) 제스처가 아니면 무시
      if (scrollEl.scrollTop <= 0) {
        e.preventDefault();
      }
    }, { passive: false });
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------- 홈 / 재고 현황 -------------------------

  function bindHome() {
    $('#home-search').addEventListener('input', debounce(loadStock, 300));
  }

  async function loadStock() {
    if (!state.site) return;
    const listEl = $('#home-stock-list');
    listEl.innerHTML = `<div class="empty-state">불러오는 중...</div>`;
    try {
      const rows = await Api.get('stock', {
        site: state.site,
        q: $('#home-search').value
      });
      if (!rows.length) {
        listEl.innerHTML = `<div class="empty-state">재고 데이터가 없습니다.</div>`;
        return;
      }
      listEl.innerHTML = rows.map((r) => `
        <div class="stock-row">
          <div class="row-main">
            <span class="primary">${escapeHtml(r.ItemName)}</span>
            <span class="secondary">${escapeHtml(r.ItemID)}${r.Spec ? ' · ' + escapeHtml(r.Spec) : ''}</span>
          </div>
          <div class="row-qty">${r.Quantity.toLocaleString()} <span class="secondary">${escapeHtml(r.Unit)}</span></div>
        </div>
      `).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state">오류: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ------------------------- QR 스캔 -------------------------

  function bindScan() {
    $('#scan-toggle-btn').addEventListener('click', toggleScanning);
    $('#manual-lookup-btn').addEventListener('click', () => {
      const code = $('#manual-code-input').value.trim();
      if (code) handleScannedCode(code);
    });
    $('#scan-add-btn').addEventListener('click', addToCart);
    $('#scan-cancel-btn').addEventListener('click', cancelScan);
    $('#cart-clear-btn').addEventListener('click', () => {
      if (!state.cart.length) return;
      if (!confirm('담아둔 목록을 모두 삭제할까요?')) return;
      state.cart = [];
      renderCart();
    });
    $('#cart-submit-btn').addEventListener('click', submitCart);
    $('#scan-back-btn').addEventListener('click', () => {
      let target = 'actions';
      if (state.scanType === 'OUT') {
        target = state.site === '기흥' ? 'out-mode' : 'line';
      }
      switchView(target);
      // switchView는 사용자가 확인 취소 시 뷰를 바꾸지 않으므로, 실제로 이동했을 때만 Line 버튼을 다시 그림
      if (target === 'line' && state.currentView === 'line') {
        renderLineButtons();
      }
      if (target === 'out-mode' && state.currentView === 'out-mode') {
        goToOutMode();
      }
    });
  }

  function toggleScanning() {
    if (state.scanning) {
      stopScanning();
    } else {
      startScanning();
    }
  }

  function showScanError(message) {
    const el = $('#scan-error-text');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearScanError() {
    const el = $('#scan-error-text');
    el.textContent = '';
    el.classList.add('hidden');
  }

  function startScanning() {
    clearScanError();

    if (typeof Html5Qrcode === 'undefined') {
      showScanError('QR 스캐너 라이브러리를 불러오지 못했습니다. 앱을 새로고침해 주세요.');
      toast('QR 스캐너 라이브러리를 불러오지 못했습니다.', 'error');
      return;
    }

    const isSecureContext = window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showScanError('카메라를 사용하려면 HTTPS 주소로 접속해야 합니다. 자재코드를 직접 입력해 주세요.');
      toast('보안 연결(HTTPS)이 아니어서 카메라를 사용할 수 없습니다.', 'error');
      return;
    }

    // 카메라 스트림이 붙기 전에 컨테이너를 먼저 표시해야 html5-qrcode가 올바른 크기를 측정합니다.
    $('#qr-reader').classList.remove('hidden');

    state.html5QrCode = new Html5Qrcode('qr-reader');
    state.html5QrCode
      .start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
            const size = Math.max(150, Math.min(edge, 300));
            return { width: size, height: size };
          }
        },
        (decodedText) => {
          // 카메라는 계속 켜둔 채 연속으로 스캔한다. 이미 조회 중이거나 결과 카드가
          // 떠 있는 동안(같은 QR이 화면에 계속 잡히는 경우 등)에는 새 스캔을 무시한다.
          if (state.scanBusy || state.currentScanItem) return;
          handleScannedCode(decodedText);
        },
        () => {} // 프레임마다 실패하는 것은 정상 (인식 전까지)
      )
      .then(() => {
        state.scanning = true;
        $('#scan-toggle-btn').textContent = '스캔 중지';
      })
      .catch((err) => {
        $('#qr-reader').classList.add('hidden');
        state.scanning = false;
        $('#scan-toggle-btn').textContent = '카메라 스캔 시작';
        const message = String((err && err.message) || err || '');
        let friendly = '카메라를 시작할 수 없습니다.';
        if (/NotAllowedError|Permission/i.test(message)) {
          friendly = '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라 접근을 허용해 주세요.';
        } else if (/NotFoundError|no camera/i.test(message)) {
          friendly = '사용 가능한 카메라를 찾을 수 없습니다.';
        } else if (/NotReadableError/i.test(message)) {
          friendly = '카메라가 다른 앱에서 사용 중입니다. 다른 앱을 종료한 후 다시 시도해 주세요.';
        }
        showScanError(friendly + ' 자재코드를 직접 입력해도 됩니다.');
        toast(friendly, 'error');
      });
  }

  function stopScanning() {
    if (state.html5QrCode && state.scanning) {
      state.html5QrCode.stop().then(() => state.html5QrCode.clear()).catch(() => {});
    }
    state.scanning = false;
    $('#qr-reader').classList.add('hidden');
    $('#scan-toggle-btn').textContent = '카메라 스캔 시작';
  }

  function showLookupError(message) {
    const el = $('#scan-lookup-error');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearLookupError() {
    const el = $('#scan-lookup-error');
    el.textContent = '';
    el.classList.add('hidden');
  }

  // ------------------------- 디버그 패널 (임시) -------------------------

  function debugPanelShow() {
    if (!DEBUG_QR) return;
    $('#scan-debug-panel').classList.remove('hidden');
  }

  function debugSetRaw(raw, parsed) {
    if (!DEBUG_QR) return;
    debugPanelShow();
    $('#scan-debug-raw').textContent = `스캔 원본: ${raw}  →  파싱된 코드: ${parsed}`;
  }

  function debugSetLookup(text) {
    if (!DEBUG_QR) return;
    debugPanelShow();
    $('#scan-debug-lookup').textContent = text;
  }

  async function debugCheckItemsHealth() {
    if (!DEBUG_QR) return;
    debugPanelShow();
    $('#scan-debug-health').textContent = 'Items 시트 확인 중...';
    try {
      const ping = await Api.get('ping');
      if (ping.itemsSheetOk && ping.itemCount > 0) {
        $('#scan-debug-health').textContent = `Items 시트 정상 (${ping.itemCount}건 등록됨)`;
      } else {
        $('#scan-debug-health').textContent = `⚠ Items 시트 문제: ${ping.itemsError || '등록된 자재 없음 (' + ping.itemCount + '건)'}`;
      }
    } catch (err) {
      $('#scan-debug-health').textContent = '⚠ ping 조회 실패: ' + (err.message || err);
    }
  }

  async function handleScannedCode(rawCode) {
    clearLookupError();
    const code = String(rawCode || '').trim();
    debugSetRaw(rawCode, code || '(빈 값)');
    if (DEBUG_QR) toast(`스캔된 코드: ${code || '(빈 값)'}`, '');

    if (!code) {
      showLookupError('QR 코드에서 자재코드를 읽을 수 없습니다.');
      debugSetLookup('조회 안 함 (파싱된 코드가 없음)');
      return;
    }

    state.scanBusy = true;
    try {
      if (state.scanType === 'IN') {
        // 입고 화면 전용 경량 조회: 재고 시트는 읽지 않고, 자재 정보 + 미완료 발주만 한 번에 받아온다.
        debugSetLookup('자재 + 발주 이력 조회 중...');
        const result = await Api.get('scanLookup', { site: state.site, code });
        const hasOpenPo = !!(result.openPos && result.openPos.length);
        if (!hasOpenPo) {
          // 발주 이력이 없는 자재는 카드를 띄우지 않고 토스트만 표시한 뒤, 곧바로 다음 스캔을 받는다
          // (currentScanItem을 채우지 않아야 스캔 콜백의 가드에 걸리지 않고 연속 스캔이 이어진다).
          debugSetLookup(`조회 성공: ${result.item.ItemName} (${result.item.ItemID}), 발주 이력 없음`);
          toast(`${result.item.ItemName}: 발주 이력이 없습니다. 입고할 수 없습니다.`, 'error');
          $('#manual-code-input').value = '';
          return;
        }
        state.currentScanItem = result.item;
        renderScanResultIn(result.item, result.openPos);
        debugSetLookup(`조회 성공: ${result.item.ItemName} (${result.item.ItemID}), 미완료 발주 ${result.openPos.length}건`);
        if (DEBUG_QR) toast(`조회 결과: ${result.item.ItemName} · 발주 ${result.openPos.length}건`, 'success');
      } else {
        // 출고 화면 전용 경량 조회: 로그인한 사이트의 재고만 1번 읽어온다 (기흥/화성/평택 전체를 읽는
        // itemByCode 대신 사용해, 스캔할 때마다 시트 3개를 읽던 것을 1개로 줄여 속도를 개선한다).
        debugSetLookup('자재 + 현재 사이트 재고 조회 중...');
        const result = await Api.get('scanLookupOut', { site: state.site, code });
        const availableQty = Number(result.quantity) || 0;
        if (availableQty <= 0) {
          // 재고가 없는 자재는 카드를 띄우지 않고 토스트만 표시한 뒤, 곧바로 다음 스캔을 받는다
          // (마이너스 재고 출고를 애초에 막고, currentScanItem을 채우지 않아 연속 스캔이 이어진다).
          debugSetLookup(`조회 성공: ${result.item.ItemName} (${result.item.ItemID}), 재고 없음`);
          toast(`${result.item.ItemName}: 재고가 없습니다.`, 'error');
          $('#manual-code-input').value = '';
          return;
        }
        state.currentScanItem = result.item;
        renderScanResultOut(result.item, availableQty);
        debugSetLookup(`조회 성공: ${result.item.ItemName} (${result.item.ItemID}), 현재고 ${availableQty}`);
        if (DEBUG_QR) toast(`조회 결과: ${result.item.ItemName} (${result.item.ItemID}) 발견`, 'success');
      }
      $('#manual-code-input').value = '';
    } catch (err) {
      const message = err.message || '조회 중 알 수 없는 오류가 발생했습니다.';
      showLookupError(message);
      toast(message, 'error');
      debugSetLookup('조회 실패: ' + message);
    } finally {
      state.scanBusy = false;
    }
  }

  // 입고 화면: 자재코드/품명/규격만 보여주고, 재고 현황과 메모 입력은 표시하지 않는다.
  // 발주 이력이 없는 경우는 handleScannedCode에서 이 함수를 호출하기 전에 걸러지므로,
  // 여기서는 항상 미완료 발주가 있는 경우만 그린다.
  function renderScanResultIn(item, openPos) {
    $('#scan-result-card').classList.remove('hidden');
    $('#scan-item-title').classList.add('hidden');
    $('#scan-item-info-in').classList.remove('hidden');
    $('#in-item-code').textContent = item.ItemID;
    $('#in-item-name').textContent = item.ItemName;
    $('#in-item-spec').textContent = item.Spec || '-';
    $('#in-item-stock-row').classList.add('hidden');

    $('#scan-quantity').value = '';
    $('#scan-quantity').disabled = false;
    $('#scan-add-btn').disabled = false;
    state.hasOpenPo = true;

    renderOpenPos(openPos);
  }

  // 출고 화면: 자재코드/품명/규격 + 현재 로그인한 사이트의 재고만 보여준다
  // (구매발주 매칭은 입고 전용이라 표시하지 않음. 다른 사이트 재고는 조회하지 않는다).
  function renderScanResultOut(item, quantity) {
    $('#scan-result-card').classList.remove('hidden');
    $('#scan-item-title').classList.add('hidden');
    $('#scan-item-info-in').classList.remove('hidden');
    $('#in-item-code').textContent = item.ItemID;
    $('#in-item-name').textContent = item.ItemName;
    $('#in-item-spec').textContent = item.Spec || '-';
    $('#in-item-stock-row').classList.remove('hidden');
    $('#in-item-stock').textContent = `${Number(quantity).toLocaleString()}${item.Unit ? ' ' + item.Unit : ''}`;

    $('#scan-quantity').value = '';
    $('#scan-quantity').disabled = false;
    $('#scan-add-btn').disabled = false;
    state.hasOpenPo = true;

    hidePoInfo();
  }

  // ------------------------- 구매발주 FIFO 매칭 표시 (입고 전용) -------------------------

  function poStatusClass(status) {
    return status === '입고완료' ? 'po-status-done' : status === '부분입고' ? 'po-status-partial' : 'po-status-none';
  }

  // 필요일자에서 "N월 발주" 형태의 짧은 라벨을 만든다 (입고 완료 후 요약 토스트용). 날짜가 없으면 그냥 "발주".
  function formatPoLabel(entry) {
    if (entry.dueDate) {
      const d = new Date(entry.dueDate);
      if (!isNaN(d.getTime())) return `${d.getMonth() + 1}월 발주`;
    }
    return '발주';
  }

  // 필요일자를 YYYY-MM-DD로 표시한다 (스캔 직후 발주 현황 목록용).
  function formatPoDate(dueDate) {
    if (!dueDate) return '날짜 없음';
    const d = new Date(dueDate);
    if (isNaN(d.getTime())) return String(dueDate);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function hidePoInfo() {
    $('#scan-po-header').classList.add('hidden');
    $('#scan-po-list').classList.add('hidden');
    $('#scan-po-none').classList.add('hidden');
  }

  // list는 필요일자 오름차순(오래된 발주 먼저) 배열. 첫 번째 항목이 FIFO상 다음 입고 대상이라 강조 표시한다.
  function renderOpenPos(list) {
    if (!list || !list.length) {
      $('#scan-po-header').classList.add('hidden');
      $('#scan-po-list').classList.add('hidden');
      $('#scan-po-none').textContent = '발주 이력이 없습니다. 입고할 수 없습니다.';
      $('#scan-po-none').classList.remove('hidden');
      return;
    }

    $('#scan-po-none').classList.add('hidden');
    $('#scan-po-header').classList.remove('hidden');
    $('#scan-po-list').innerHTML = list.map((po, i) => `
      <div class="po-row${i === 0 ? ' po-row-current' : ''}">
        <div class="po-row-main">
          <span class="po-row-title">${formatPoDate(po.dueDate)}${i === 0 ? '<span class="po-row-current-badge">현재 입고 대상</span>' : ''}</span>
          <span class="po-row-detail">요청 ${Number(po.requestedQty).toLocaleString()}개 / 입고 ${Number(po.cumulativeQty).toLocaleString()}개 / 잔여 ${Number(po.remainingQty).toLocaleString()}개</span>
        </div>
        <span class="po-status-tag ${poStatusClass(po.status)}">${escapeHtml(po.status)}</span>
      </div>
    `).join('');
    $('#scan-po-list').classList.remove('hidden');
  }

  // ------------------------- 스캔 장바구니 -------------------------

  function addToCart() {
    if (!state.currentScanItem) return;
    if (!state.site) { toast('사이트를 선택하세요.', 'error'); return; }
    if (state.scanType === 'IN' && !state.hasOpenPo) {
      toast('발주 이력이 없어 입고할 수 없습니다.', 'error');
      return;
    }
    const quantity = Number($('#scan-quantity').value);

    if (!quantity || quantity <= 0) {
      toast('올바른 수량을 입력하세요.', 'error');
      return;
    }
    if (state.scanType === 'OUT' && !state.scanZone) {
      toast('출고 라인을 선택하세요.', 'error');
      return;
    }

    const item = state.currentScanItem;
    state.cart.push({
      uid: 'c' + Date.now() + Math.floor(Math.random() * 1000),
      itemId: item.ItemID,
      itemName: item.ItemName,
      spec: item.Spec,
      unit: item.Unit,
      quantity,
      zone: state.scanType === 'OUT' ? state.scanZone : ''
    });
    renderCart();
    toast(`${item.ItemName} 담았습니다.`, 'success');
    resetScanCard();
  }

  // 자재 정보 화면만 초기화하고 다음 스캔 대기 상태로 복귀 (담은 목록에는 추가하지 않음)
  function resetScanCard() {
    state.currentScanItem = null;
    $('#scan-result-card').classList.add('hidden');
    $('#scan-quantity').value = '';
    $('#manual-code-input').value = '';
  }

  function cancelScan() {
    if (!state.currentScanItem) return;
    resetScanCard();
  }

  function renderCart() {
    const cart = state.cart;
    $('#cart-count').textContent = cart.length;
    $('#cart-submit-count').textContent = cart.length;
    $('#cart-submit-label').textContent = state.scanType === 'IN' ? '입고 완료' : '출고 완료';

    $('#scan-cart-section').classList.toggle('hidden', cart.length === 0);
    $('#cart-footer').classList.toggle('hidden', cart.length === 0);
    $('#view-container').classList.toggle('has-cart-footer', cart.length > 0 || state.purchaseCart.length > 0 || state.returnCart.length > 0);

    const listEl = $('#cart-list');
    listEl.innerHTML = cart.map((c) => `
      <div class="cart-row${c.error ? ' cart-row-error' : ''}" data-uid="${c.uid}">
        <div class="row-main">
          <span class="primary">${escapeHtml(c.itemName)}${c.spec ? ' / ' + escapeHtml(c.spec) : ''}</span>
          <span class="secondary">${escapeHtml(c.itemId)} · 수량 ${Number(c.quantity).toLocaleString()}${escapeHtml(c.unit || '')}</span>
          ${c.error ? `<span class="cart-error-msg">${escapeHtml(c.error)}</span>` : ''}
        </div>
        <button class="cart-delete-btn" data-uid="${c.uid}" aria-label="삭제">🗑️</button>
      </div>
    `).join('');

    $$('.cart-delete-btn', listEl).forEach((btn) => {
      btn.addEventListener('click', () => removeFromCart(btn.dataset.uid));
    });
  }

  function removeFromCart(uid) {
    state.cart = state.cart.filter((c) => c.uid !== uid);
    renderCart();
  }

  function showBatchLoading(current, total) {
    $('#batch-loading-overlay').classList.remove('hidden');
    $('#batch-loading-text').textContent = `처리 중... (${current}/${total})`;
  }

  function hideBatchLoading() {
    $('#batch-loading-overlay').classList.add('hidden');
  }

  // stockIn 응답의 allocations(FIFO로 채워진 발주별 내역)를 사람이 읽을 문장으로 만든다.
  // 예: "TRANSMITTER: 1월 발주 3개 완료 + 3월 발주 2개 부분입고"
  function formatReceiptBreakdown(itemName, data) {
    const parts = (data.allocations || []).map((a) => {
      const label = formatPoLabel(a);
      const statusWord = a.status === '입고완료' ? '완료' : (a.status === '부분입고' ? '부분입고' : '미입고');
      return `${label} ${Number(a.appliedQty).toLocaleString()}개 ${statusWord}`;
    });
    if (data.unmatchedQty > 0) {
      parts.push(`발주없음 ${Number(data.unmatchedQty).toLocaleString()}개 직접입고`);
    }
    if (!parts.length) return null;
    return `${itemName}: ${parts.join(' + ')}`;
  }

  async function submitCart() {
    if (!state.cart.length) return;
    if (!state.site) { toast('사이트를 선택하세요.', 'error'); return; }

    stopScanning();

    const btn = $('#cart-submit-btn');
    btn.disabled = true;
    showBatchLoading(0, state.cart.length);

    const finishedUids = [];
    let successCount = 0;
    let queuedCount = 0;
    let failCount = 0;

    for (let i = 0; i < state.cart.length; i++) {
      const c = state.cart[i];
      showBatchLoading(i + 1, state.cart.length);
      try {
        const action = state.scanType === 'IN' ? 'stockIn' : 'stockOut';
        const payload = { itemId: c.itemId, site: state.site, quantity: c.quantity, pin: state.user.pin };
        if (state.scanType === 'OUT') payload.zone = c.zone;

        const result = await Api.postWithQueue(action, payload);
        if (result.queued) {
          queuedCount++;
        } else {
          successCount++;
          if (state.scanType === 'IN' && result.data) {
            const breakdown = formatReceiptBreakdown(c.itemName, result.data);
            if (breakdown) toast(breakdown, 'success');
          }
        }
        finishedUids.push(c.uid);
      } catch (err) {
        failCount++;
        c.error = err.message || '처리 실패';
      }
    }

    hideBatchLoading();
    btn.disabled = false;
    updateOfflineBadge();

    // 성공/오프라인 대기 처리된 항목은 목록에서 제거하고, 실패한 항목만 남겨 재시도할 수 있게 함
    state.cart = state.cart.filter((c) => !finishedUids.includes(c.uid));
    renderCart();

    const typeLabel = state.scanType === 'IN' ? '입고' : '출고';
    const parts = [];
    if (successCount) parts.push(`${successCount}건 성공`);
    if (queuedCount) parts.push(`${queuedCount}건 오프라인 대기`);
    if (failCount) parts.push(`${failCount}건 실패`);
    toast(`${typeLabel} 일괄 처리: ${parts.join(', ')}`, failCount ? 'error' : 'success');
  }

  // ------------------------- 구매요청(Purchase) -------------------------

  function bindPurchase() {
    $('#purchase-back-btn').addEventListener('click', () => {
      switchView('line');
      if (state.currentView === 'line') renderLineButtons();
    });
    $('#purchase-search-input').addEventListener('input', debounce(searchMaterials, 300));
    $('#purchase-select-all').addEventListener('change', (e) => togglePurchaseSelectAll(e.target.checked));
    $('#purchase-bulk-add-btn').addEventListener('click', openPurchaseBulkQuantityModal);
    $('#purchase-add-btn').addEventListener('click', addToPurchaseCart);
    $('#purchase-cancel-btn').addEventListener('click', cancelPurchaseSelection);
    $('#purchase-cart-clear-btn').addEventListener('click', () => {
      if (!state.purchaseCart.length) return;
      if (!confirm('담아둔 목록을 모두 삭제할까요?')) return;
      state.purchaseCart = [];
      renderPurchaseCart();
    });
    $('#purchase-submit-btn').addEventListener('click', submitPurchaseCart);
  }

  function goToPurchase() {
    state.currentPurchaseItem = null;
    state.purchaseCart = [];
    state.purchaseSearchRows = [];
    state.purchaseSelectedIdx = new Set();
    $('#purchase-result-card').classList.add('hidden');
    $('#purchase-search-input').value = '';
    $('#purchase-search-results').innerHTML = '';
    $('#purchase-required-date').value = '';
    switchView('purchase');
    $('#purchase-context-label').textContent = `${state.site} · ${state.scanZone} · 구매요청`;
    renderPurchaseCart();
    renderPurchaseBulkUI();
  }

  async function searchMaterials() {
    const q = $('#purchase-search-input').value.trim();
    const resultsEl = $('#purchase-search-results');
    state.purchaseSearchRows = [];
    state.purchaseSelectedIdx = new Set();
    if (!q) {
      resultsEl.innerHTML = '';
      renderPurchaseBulkUI();
      return;
    }
    resultsEl.innerHTML = `<div class="empty-state">검색 중...</div>`;
    renderPurchaseBulkUI();
    try {
      const rows = await Api.get('searchMaterials', { site: state.site, query: q });
      state.purchaseSearchRows = rows;
      renderPurchaseSearchList(rows);
    } catch (err) {
      resultsEl.innerHTML = `<div class="empty-state">오류: ${escapeHtml(err.message)}</div>`;
      renderPurchaseBulkUI();
    }
  }

  function renderPurchaseSearchList(rows) {
    const resultsEl = $('#purchase-search-results');
    if (!rows.length) {
      resultsEl.innerHTML = `<div class="empty-state">검색 결과가 없습니다.</div>`;
      renderPurchaseBulkUI();
      return;
    }
    resultsEl.innerHTML = rows.map((m, i) => `
      <div class="item-row" data-idx="${i}">
        <label class="item-checkbox-wrap">
          <input type="checkbox" class="purchase-item-checkbox" data-idx="${i}" />
        </label>
        <div class="row-main purchase-item-main" data-idx="${i}">
          <span class="primary">${escapeHtml(m.itemName)}</span>
          <span class="secondary">${escapeHtml(m.itemId)}${m.bqms ? ' · ' + escapeHtml(m.bqms) : ''}${m.spec ? ' · ' + escapeHtml(m.spec) : ''}${m.equipment ? ' · ' + escapeHtml(m.equipment) : ''}</span>
        </div>
        <button type="button" class="item-photo-btn" data-idx="${i}" title="사진 보기" aria-label="사진 보기">📷</button>
      </div>
    `).join('');
    $$('.purchase-item-main', resultsEl).forEach((el, i) => {
      el.addEventListener('click', () => selectPurchaseMaterial(rows[i]));
    });
    $$('.purchase-item-checkbox', resultsEl).forEach((cb, i) => {
      cb.addEventListener('click', (e) => e.stopPropagation());
      cb.addEventListener('change', (e) => {
        if (e.target.checked) state.purchaseSelectedIdx.add(i);
        else state.purchaseSelectedIdx.delete(i);
        renderPurchaseBulkUI();
      });
    });
    $$('.item-photo-btn', resultsEl).forEach((btn, i) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openMaterialPhoto(rows[i]);
      });
    });
    renderPurchaseBulkUI();
  }

  function togglePurchaseSelectAll(checked) {
    state.purchaseSelectedIdx = checked
      ? new Set(state.purchaseSearchRows.map((_, i) => i))
      : new Set();
    $$('.purchase-item-checkbox', $('#purchase-search-results')).forEach((cb, i) => {
      cb.checked = state.purchaseSelectedIdx.has(i);
    });
    renderPurchaseBulkUI();
  }

  function renderPurchaseBulkUI() {
    const total = state.purchaseSearchRows.length;
    const selected = state.purchaseSelectedIdx.size;

    $('#purchase-select-all-row').classList.toggle('hidden', total === 0);
    $('#purchase-selected-count').textContent = selected > 0 ? `${selected}개 선택됨` : '';
    $('#purchase-bulk-add-btn').classList.toggle('hidden', selected === 0);

    const selectAllCb = $('#purchase-select-all');
    selectAllCb.checked = total > 0 && selected === total;
    selectAllCb.indeterminate = selected > 0 && selected < total;
  }

  function openPurchaseBulkQuantityModal() {
    const items = state.purchaseSearchRows
      .map((m, i) => ({ ...m, idx: i }))
      .filter((m) => state.purchaseSelectedIdx.has(m.idx));
    if (!items.length) return;

    const html = `
      <div class="modal-sheet">
        <h3>선택한 자재 수량 입력 (${items.length}개)</h3>
        <div class="list">
          ${items.map((m) => `
            <div class="bulk-qty-row" data-idx="${m.idx}">
              <div class="row-main">
                <span class="primary">${escapeHtml(m.itemName)}</span>
                <span class="secondary">${escapeHtml(m.itemId)}${m.bqms ? ' · ' + escapeHtml(m.bqms) : ''}${m.spec ? ' · ' + escapeHtml(m.spec) : ''}${m.equipment ? ' · ' + escapeHtml(m.equipment) : ''}</span>
              </div>
              <input type="number" class="input bulk-qty-input" data-idx="${m.idx}" min="1" step="1" placeholder="수량" inputmode="numeric" />
            </div>
          `).join('')}
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="bulk-qty-cancel">취소</button>
          <button class="btn btn-primary" id="bulk-qty-confirm">확인</button>
        </div>
      </div>
    `;
    openModal(html);
    $('#bulk-qty-cancel').addEventListener('click', closeModal);
    $('#bulk-qty-confirm').addEventListener('click', () => {
      const qtyByIdx = new Map();
      for (const el of $$('.bulk-qty-input')) {
        const idx = Number(el.dataset.idx);
        const qty = Number(el.value);
        if (!qty || qty <= 0) {
          const m = state.purchaseSearchRows[idx];
          toast(`${m.itemName}의 수량을 입력하세요.`, 'error');
          return;
        }
        qtyByIdx.set(idx, qty);
      }

      qtyByIdx.forEach((qty, idx) => {
        const m = state.purchaseSearchRows[idx];
        state.purchaseCart.push({
          uid: 'p' + Date.now() + Math.floor(Math.random() * 1000) + idx,
          itemId: m.itemId,
          bqms: m.bqms,
          itemName: m.itemName,
          spec: m.spec,
          quantity: qty
        });
      });
      renderPurchaseCart();
      closeModal();
      toast(`${qtyByIdx.size}개 자재를 담았습니다.`, 'success');

      state.purchaseSelectedIdx = new Set();
      state.purchaseSearchRows = [];
      $('#purchase-search-input').value = '';
      $('#purchase-search-results').innerHTML = '';
      renderPurchaseBulkUI();
      $('#purchase-search-input').focus();
    });
  }

  // 사진 아이콘 클릭: 로딩 → getPhotoUrl 조회 → 사진 또는 "등록된 사진이 없습니다" 표시.
  async function openMaterialPhoto(material) {
    const html = `
      <div class="modal-sheet photo-modal">
        <h3>${escapeHtml(material.itemName)}</h3>
        <p class="muted">${escapeHtml(material.itemId)}${material.bqms ? ' · ' + escapeHtml(material.bqms) : ''}</p>
        <div id="photo-modal-body" class="photo-modal-body">
          <div class="empty-state">불러오는 중...</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary btn-block" id="photo-modal-close">닫기</button>
        </div>
      </div>
    `;
    openModal(html);
    $('#photo-modal-close').addEventListener('click', closeModal);

    try {
      const url = await Api.get('getPhotoUrl', { itemId: material.itemId });
      const bodyEl = $('#photo-modal-body');
      if (!bodyEl) return; // 응답 오기 전에 팝업이 닫힌 경우
      bodyEl.innerHTML = url
        ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(material.itemName)}" class="photo-modal-img" />`
        : `<div class="empty-state">등록된 사진이 없습니다.</div>`;
    } catch (err) {
      const bodyEl = $('#photo-modal-body');
      if (bodyEl) bodyEl.innerHTML = `<div class="empty-state">오류: ${escapeHtml(err.message)}</div>`;
    }
  }

  function selectPurchaseMaterial(material) {
    state.currentPurchaseItem = material;
    $('#purchase-result-card').classList.remove('hidden');
    $('#purchase-item-code').textContent = material.itemId;
    $('#purchase-item-bqms').textContent = material.bqms || '-';
    $('#purchase-item-name').textContent = material.itemName;
    $('#purchase-item-spec').textContent = material.spec || '-';
    $('#purchase-item-equipment').textContent = material.equipment || '-';
    $('#purchase-quantity').value = '';
    $('#purchase-search-results').innerHTML = '';
    state.purchaseSelectedIdx = new Set();
    renderPurchaseBulkUI();
  }

  function cancelPurchaseSelection() {
    state.currentPurchaseItem = null;
    $('#purchase-result-card').classList.add('hidden');
    $('#purchase-quantity').value = '';
    renderPurchaseSearchList(state.purchaseSearchRows);
  }

  function addToPurchaseCart() {
    if (!state.currentPurchaseItem) return;
    const quantity = Number($('#purchase-quantity').value);
    if (!quantity || quantity <= 0) {
      toast('올바른 수량을 입력하세요.', 'error');
      return;
    }

    const m = state.currentPurchaseItem;
    state.purchaseCart.push({
      uid: 'p' + Date.now() + Math.floor(Math.random() * 1000),
      itemId: m.itemId,
      bqms: m.bqms,
      itemName: m.itemName,
      spec: m.spec,
      quantity
    });
    renderPurchaseCart();
    toast(`${m.itemName} 담았습니다.`, 'success');

    // 다음 자재를 바로 검색할 수 있도록 검색창/선택 카드를 초기화한다.
    state.currentPurchaseItem = null;
    $('#purchase-result-card').classList.add('hidden');
    $('#purchase-search-input').value = '';
    $('#purchase-search-results').innerHTML = '';
    $('#purchase-search-input').focus();
  }

  function renderPurchaseCart() {
    const cart = state.purchaseCart;
    $('#purchase-cart-count').textContent = cart.length;
    $('#purchase-submit-count').textContent = cart.length;

    $('#purchase-cart-section').classList.toggle('hidden', cart.length === 0);
    $('#purchase-cart-footer').classList.toggle('hidden', cart.length === 0);
    $('#view-container').classList.toggle('has-cart-footer', cart.length > 0 || state.cart.length > 0 || state.returnCart.length > 0);

    const listEl = $('#purchase-cart-list');
    listEl.innerHTML = cart.map((c) => `
      <div class="cart-row" data-uid="${c.uid}">
        <div class="row-main">
          <span class="primary">${escapeHtml(c.itemName)}${c.spec ? ' / ' + escapeHtml(c.spec) : ''}</span>
          <span class="secondary">${escapeHtml(c.itemId)}${c.bqms ? ' · ' + escapeHtml(c.bqms) : ''} · 수량 ${Number(c.quantity).toLocaleString()}</span>
        </div>
        <button class="cart-delete-btn" data-uid="${c.uid}" aria-label="삭제">🗑️</button>
      </div>
    `).join('');
    $$('.cart-delete-btn', listEl).forEach((btn) => {
      btn.addEventListener('click', () => removeFromPurchaseCart(btn.dataset.uid));
    });
  }

  function removeFromPurchaseCart(uid) {
    state.purchaseCart = state.purchaseCart.filter((c) => c.uid !== uid);
    renderPurchaseCart();
  }

  async function submitPurchaseCart() {
    if (!state.purchaseCart.length) return;
    if (!state.site || !state.scanZone) {
      toast('사이트/라인을 확인하세요.', 'error');
      return;
    }

    const btn = $('#purchase-submit-btn');
    btn.disabled = true;
    try {
      const payload = {
        site: state.site,
        zone: state.scanZone,
        pin: state.user.pin,
        requiredDate: $('#purchase-required-date').value,
        items: state.purchaseCart.map((c) => ({
          itemId: c.itemId, bqms: c.bqms, itemName: c.itemName, spec: c.spec, quantity: c.quantity
        }))
      };
      const result = await Api.postWithQueue('submitPurchase', payload);
      if (result.queued) {
        toast('오프라인 상태입니다. 온라인 복귀 시 자동으로 등록됩니다.', '');
      } else {
        toast(`구매요청 ${state.purchaseCart.length}건이 등록되었습니다.`, 'success');
      }
      state.purchaseCart = [];
      $('#purchase-required-date').value = '';
      renderPurchaseCart();
      updateOfflineBadge();
    } catch (err) {
      toast(err.message || '구매요청 처리 중 오류가 발생했습니다.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------- 반납(Return) -------------------------

  function bindReturn() {
    $('#return-back-btn').addEventListener('click', () => switchView('actions'));
    $('#return-scan-toggle-btn').addEventListener('click', toggleReturnScanning);
    $('#return-manual-lookup-btn').addEventListener('click', () => {
      const code = $('#return-manual-code-input').value.trim();
      if (code) handleReturnScannedCode(code);
    });
    $('#return-search-input').addEventListener('input', debounce(searchReturnMaterials, 300));
    $('#return-add-btn').addEventListener('click', addToReturnCart);
    $('#return-cancel-btn').addEventListener('click', cancelReturnSelection);
    $('#return-cart-clear-btn').addEventListener('click', () => {
      if (!state.returnCart.length) return;
      if (!confirm('담아둔 목록을 모두 삭제할까요?')) return;
      state.returnCart = [];
      renderReturnCart();
    });
    $('#return-submit-btn').addEventListener('click', submitReturnCart);
  }

  function goToReturn() {
    state.currentReturnItem = null;
    state.returnCart = [];
    $('#return-result-card').classList.add('hidden');
    $('#return-search-input').value = '';
    $('#return-search-results').innerHTML = '';
    $('#return-manual-code-input').value = '';
    clearReturnScanError();
    clearReturnLookupError();
    switchView('return');
    $('#return-context-label').textContent = `${state.site} · 반납`;
    renderReturnCart();
  }

  function toggleReturnScanning() {
    if (state.returnScanning) {
      stopReturnScanning();
    } else {
      startReturnScanning();
    }
  }

  function showReturnScanError(message) {
    const el = $('#return-scan-error-text');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearReturnScanError() {
    const el = $('#return-scan-error-text');
    el.textContent = '';
    el.classList.add('hidden');
  }

  function showReturnLookupError(message) {
    const el = $('#return-lookup-error');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearReturnLookupError() {
    const el = $('#return-lookup-error');
    el.textContent = '';
    el.classList.add('hidden');
  }

  // 입고 화면의 QR 스캔(startScanning)과 동일한 방식: html5-qrcode로 카메라를 켜고,
  // 인식되면 콜백으로 원본 텍스트를 넘긴다. 카메라는 계속 켜둔 채 연속으로 스캔하되,
  // 이미 조회 중이거나 결과 카드가 떠 있는 동안에는 새 스캔을 무시한다.
  function startReturnScanning() {
    clearReturnScanError();

    if (typeof Html5Qrcode === 'undefined') {
      showReturnScanError('QR 스캐너 라이브러리를 불러오지 못했습니다. 앱을 새로고침해 주세요.');
      toast('QR 스캐너 라이브러리를 불러오지 못했습니다.', 'error');
      return;
    }

    const isSecureContext = window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showReturnScanError('카메라를 사용하려면 HTTPS 주소로 접속해야 합니다. 자재코드를 직접 입력해 주세요.');
      toast('보안 연결(HTTPS)이 아니어서 카메라를 사용할 수 없습니다.', 'error');
      return;
    }

    $('#return-qr-reader').classList.remove('hidden');

    state.returnHtml5QrCode = new Html5Qrcode('return-qr-reader');
    state.returnHtml5QrCode
      .start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
            const size = Math.max(150, Math.min(edge, 300));
            return { width: size, height: size };
          }
        },
        (decodedText) => {
          if (state.returnScanBusy || state.currentReturnItem) return;
          handleReturnScannedCode(decodedText);
        },
        () => {} // 프레임마다 실패하는 것은 정상 (인식 전까지)
      )
      .then(() => {
        state.returnScanning = true;
        $('#return-scan-toggle-btn').textContent = '스캔 중지';
      })
      .catch((err) => {
        $('#return-qr-reader').classList.add('hidden');
        state.returnScanning = false;
        $('#return-scan-toggle-btn').textContent = '카메라 스캔 시작';
        const message = String((err && err.message) || err || '');
        let friendly = '카메라를 시작할 수 없습니다.';
        if (/NotAllowedError|Permission/i.test(message)) {
          friendly = '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라 접근을 허용해 주세요.';
        } else if (/NotFoundError|no camera/i.test(message)) {
          friendly = '사용 가능한 카메라를 찾을 수 없습니다.';
        } else if (/NotReadableError/i.test(message)) {
          friendly = '카메라가 다른 앱에서 사용 중입니다. 다른 앱을 종료한 후 다시 시도해 주세요.';
        }
        showReturnScanError(friendly + ' 자재코드를 직접 입력해도 됩니다.');
        toast(friendly, 'error');
      });
  }

  function stopReturnScanning() {
    if (state.returnHtml5QrCode && state.returnScanning) {
      state.returnHtml5QrCode.stop().then(() => state.returnHtml5QrCode.clear()).catch(() => {});
    }
    state.returnScanning = false;
    $('#return-qr-reader').classList.add('hidden');
    $('#return-scan-toggle-btn').textContent = '카메라 스캔 시작';
  }

  // QR/수동 입력으로 들어온 코드를 Items 시트에서 정확히 일치하는 자재코드로 조회한다.
  // 발주(구매발주및입고) 이력은 전혀 확인하지 않는다 - 반납은 발주 유무와 무관하게 처리된다.
  async function handleReturnScannedCode(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code) return;
    clearReturnLookupError();
    if (DEBUG_QR) toast(`스캔된 코드: ${code}`, '');
    state.returnScanBusy = true;
    try {
      const item = await Api.get('itemByCode', { code });
      selectReturnMaterial(item);
      $('#return-manual-code-input').value = '';
    } catch (err) {
      showReturnLookupError(err.message);
      toast(err.message, 'error');
    } finally {
      state.returnScanBusy = false;
    }
  }

  // 자재명/자재코드 검색도 Items 시트(전체 자재 마스터)를 대상으로 한다 (발주 이력과 무관).
  async function searchReturnMaterials() {
    const q = $('#return-search-input').value.trim();
    const resultsEl = $('#return-search-results');
    if (!q) {
      resultsEl.innerHTML = '';
      return;
    }
    resultsEl.innerHTML = `<div class="empty-state">검색 중...</div>`;
    try {
      const rows = await Api.get('items', { q });
      if (!rows.length) {
        resultsEl.innerHTML = `<div class="empty-state">검색 결과가 없습니다.</div>`;
        return;
      }
      resultsEl.innerHTML = rows.map((it, i) => `
        <div class="item-row" data-idx="${i}">
          <div class="row-main">
            <span class="primary">${escapeHtml(it.ItemName)}</span>
            <span class="secondary">${escapeHtml(it.ItemID)}${it.Spec ? ' · ' + escapeHtml(it.Spec) : ''}</span>
          </div>
        </div>
      `).join('');
      $$('.item-row', resultsEl).forEach((row, i) => {
        row.addEventListener('click', () => selectReturnMaterial(rows[i]));
      });
    } catch (err) {
      resultsEl.innerHTML = `<div class="empty-state">오류: ${escapeHtml(err.message)}</div>`;
    }
  }

  function selectReturnMaterial(item) {
    state.currentReturnItem = item;
    $('#return-result-card').classList.remove('hidden');
    $('#return-item-code').textContent = item.ItemID;
    $('#return-item-name').textContent = item.ItemName;
    $('#return-item-spec').textContent = item.Spec || '-';
    $('#return-quantity').value = '';
    $('#return-search-results').innerHTML = '';
  }

  function cancelReturnSelection() {
    state.currentReturnItem = null;
    $('#return-result-card').classList.add('hidden');
    $('#return-quantity').value = '';
    $('#return-manual-code-input').value = '';
  }

  function addToReturnCart() {
    if (!state.currentReturnItem) return;
    const quantity = Number($('#return-quantity').value);
    if (!quantity || quantity <= 0) {
      toast('올바른 수량을 입력하세요.', 'error');
      return;
    }

    const item = state.currentReturnItem;
    state.returnCart.push({
      uid: 'r' + Date.now() + Math.floor(Math.random() * 1000),
      itemId: item.ItemID,
      itemName: item.ItemName,
      spec: item.Spec,
      quantity
    });
    renderReturnCart();
    toast(`${item.ItemName} 담았습니다.`, 'success');

    // 다음 자재를 바로 검색할 수 있도록 검색창/선택 카드를 초기화한다.
    state.currentReturnItem = null;
    $('#return-result-card').classList.add('hidden');
    $('#return-search-input').value = '';
    $('#return-search-results').innerHTML = '';
    $('#return-manual-code-input').value = '';
    $('#return-search-input').focus();
  }

  function renderReturnCart() {
    const cart = state.returnCart;
    $('#return-cart-count').textContent = cart.length;
    $('#return-submit-count').textContent = cart.length;

    $('#return-cart-section').classList.toggle('hidden', cart.length === 0);
    $('#return-cart-footer').classList.toggle('hidden', cart.length === 0);
    $('#view-container').classList.toggle('has-cart-footer', cart.length > 0 || state.cart.length > 0 || state.purchaseCart.length > 0);

    const listEl = $('#return-cart-list');
    listEl.innerHTML = cart.map((c) => `
      <div class="cart-row" data-uid="${c.uid}">
        <div class="row-main">
          <span class="primary">${escapeHtml(c.itemName)}${c.spec ? ' / ' + escapeHtml(c.spec) : ''}</span>
          <span class="secondary">${escapeHtml(c.itemId)} · 수량 ${Number(c.quantity).toLocaleString()}</span>
        </div>
        <button class="cart-delete-btn" data-uid="${c.uid}" aria-label="삭제">🗑️</button>
      </div>
    `).join('');
    $$('.cart-delete-btn', listEl).forEach((btn) => {
      btn.addEventListener('click', () => removeFromReturnCart(btn.dataset.uid));
    });
  }

  function removeFromReturnCart(uid) {
    state.returnCart = state.returnCart.filter((c) => c.uid !== uid);
    renderReturnCart();
  }

  async function submitReturnCart() {
    if (!state.returnCart.length) return;
    if (!state.site) {
      toast('사이트를 확인하세요.', 'error');
      return;
    }

    const btn = $('#return-submit-btn');
    btn.disabled = true;
    try {
      const payload = {
        site: state.site,
        pin: state.user.pin,
        items: state.returnCart.map((c) => ({
          itemId: c.itemId, itemName: c.itemName, spec: c.spec, quantity: c.quantity
        }))
      };
      const result = await Api.postWithQueue('stockReturn', payload);
      if (result.queued) {
        toast('오프라인 상태입니다. 온라인 복귀 시 자동으로 등록됩니다.', '');
      } else {
        toast(`반납 ${state.returnCart.length}건이 처리되었습니다.`, 'success');
      }
      state.returnCart = [];
      renderReturnCart();
      updateOfflineBadge();
    } catch (err) {
      toast(err.message || '반납 처리 중 오류가 발생했습니다.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------- 건별 출고 (기흥 전용) -------------------------

  function bindOrderOut() {
    $('#order-out-back-btn').addEventListener('click', () => switchView('out-mode'));
    $('#order-out-lookup-btn').addEventListener('click', lookupOrderOutItems);
    $('#order-out-no-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') lookupOrderOutItems();
    });
    $('#order-out-scan-toggle-btn').addEventListener('click', toggleOrderOutScanning);
    $('#order-out-submit-btn').addEventListener('click', submitOrderOut);
  }

  function goToOrderOut() {
    state.orderOutNo = '';
    state.orderOutItems = [];
    $('#order-out-no-input').value = '';
    $('#order-out-list-section').classList.add('hidden');
    clearOrderOutLookupError();
    clearOrderOutScanError();
    switchView('order-out');
    $('#order-out-context-label').textContent = `${state.site} · ${state.scanZone} · 건별 출고`;
    renderOrderOutSubmitUI();
  }

  function showOrderOutLookupError(message) {
    const el = $('#order-out-lookup-error');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearOrderOutLookupError() {
    const el = $('#order-out-lookup-error');
    el.textContent = '';
    el.classList.add('hidden');
  }

  async function lookupOrderOutItems() {
    const orderNo = $('#order-out-no-input').value.trim();
    if (!orderNo) return;
    clearOrderOutLookupError();
    $('#order-out-list-section').classList.add('hidden');
    try {
      const rows = await Api.get('getByLineOrderNo', { site: state.site, orderNo });
      state.orderOutNo = orderNo;
      state.orderOutItems = rows.map((r) => ({
        itemId: r.itemId,
        itemName: r.itemName,
        spec: r.spec,
        bqms: r.bqms,
        requestedQty: r.requestedQty,
        quantity: r.requestedQty,
        checked: false
      }));
      $('#order-out-list-title').textContent = `${orderNo} · 자재 ${rows.length}건`;
      $('#order-out-list-section').classList.remove('hidden');
      renderOrderOutItems();
    } catch (err) {
      showOrderOutLookupError(err.message);
      toast(err.message, 'error');
    }
  }

  function renderOrderOutItems() {
    const items = state.orderOutItems;
    const listEl = $('#order-out-items');
    listEl.innerHTML = items.map((it, i) => `
      <div class="item-row" data-idx="${i}">
        <label class="item-checkbox-wrap">
          <input type="checkbox" class="order-out-item-checkbox" data-idx="${i}" ${it.checked ? 'checked' : ''} />
        </label>
        <div class="row-main">
          <span class="primary">${escapeHtml(it.itemName)}${it.spec ? ' / ' + escapeHtml(it.spec) : ''}</span>
          <span class="secondary">${escapeHtml(it.itemId)}${it.bqms ? ' · ' + escapeHtml(it.bqms) : ''} · 요청수량 ${Number(it.requestedQty).toLocaleString()}</span>
        </div>
        <input type="number" class="input order-out-item-qty" data-idx="${i}" min="1" step="1" inputmode="numeric" value="${it.quantity}" />
      </div>
    `).join('');

    $$('.order-out-item-checkbox', listEl).forEach((cb, i) => {
      cb.addEventListener('change', (e) => {
        state.orderOutItems[i].checked = e.target.checked;
        renderOrderOutSubmitUI();
      });
    });
    $$('.order-out-item-qty', listEl).forEach((input, i) => {
      input.addEventListener('input', (e) => {
        state.orderOutItems[i].quantity = Number(e.target.value) || 0;
      });
    });

    renderOrderOutSubmitUI();
  }

  function renderOrderOutSubmitUI() {
    const checkedCount = state.orderOutItems.filter((it) => it.checked).length;
    $('#order-out-submit-count').textContent = checkedCount;
    $('#order-out-cart-footer').classList.toggle('hidden', checkedCount === 0);
    $('#view-container').classList.toggle('has-cart-footer',
      checkedCount > 0 || state.cart.length > 0 || state.purchaseCart.length > 0 || state.returnCart.length > 0);
  }

  function showOrderOutScanError(message) {
    const el = $('#order-out-scan-error-text');
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function clearOrderOutScanError() {
    const el = $('#order-out-scan-error-text');
    el.textContent = '';
    el.classList.add('hidden');
  }

  function toggleOrderOutScanning() {
    if (state.orderOutScanning) {
      stopOrderOutScanning();
    } else {
      startOrderOutScanning();
    }
  }

  // QR로 스캔된 자재코드를 이미 조회된 목록(state.orderOutItems)에서 찾아 체크만 한다.
  // 반납/입고/출고 스캔과 달리 서버 조회가 필요 없어 동기적으로 즉시 처리한다.
  function startOrderOutScanning() {
    clearOrderOutScanError();

    if (typeof Html5Qrcode === 'undefined') {
      showOrderOutScanError('QR 스캐너 라이브러리를 불러오지 못했습니다. 앱을 새로고침해 주세요.');
      toast('QR 스캐너 라이브러리를 불러오지 못했습니다.', 'error');
      return;
    }

    const isSecureContext = window.isSecureContext || ['localhost', '127.0.0.1'].includes(location.hostname);
    if (!isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showOrderOutScanError('카메라를 사용하려면 HTTPS 주소로 접속해야 합니다. 체크박스로 직접 확인해 주세요.');
      toast('보안 연결(HTTPS)이 아니어서 카메라를 사용할 수 없습니다.', 'error');
      return;
    }

    $('#order-out-qr-reader').classList.remove('hidden');

    state.orderOutHtml5QrCode = new Html5Qrcode('order-out-qr-reader');
    state.orderOutHtml5QrCode
      .start(
        { facingMode: 'environment' },
        {
          fps: 10,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const edge = Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7);
            const size = Math.max(150, Math.min(edge, 300));
            return { width: size, height: size };
          }
        },
        (decodedText) => handleOrderOutScannedCode(decodedText),
        () => {} // 프레임마다 실패하는 것은 정상 (인식 전까지)
      )
      .then(() => {
        state.orderOutScanning = true;
        $('#order-out-scan-toggle-btn').textContent = '스캔 중지';
      })
      .catch((err) => {
        $('#order-out-qr-reader').classList.add('hidden');
        state.orderOutScanning = false;
        $('#order-out-scan-toggle-btn').textContent = 'QR 스캔으로 확인';
        const message = String((err && err.message) || err || '');
        let friendly = '카메라를 시작할 수 없습니다.';
        if (/NotAllowedError|Permission/i.test(message)) {
          friendly = '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라 접근을 허용해 주세요.';
        } else if (/NotFoundError|no camera/i.test(message)) {
          friendly = '사용 가능한 카메라를 찾을 수 없습니다.';
        } else if (/NotReadableError/i.test(message)) {
          friendly = '카메라가 다른 앱에서 사용 중입니다. 다른 앱을 종료한 후 다시 시도해 주세요.';
        }
        showOrderOutScanError(friendly + ' 체크박스로 직접 확인해 주세요.');
        toast(friendly, 'error');
      });
  }

  function stopOrderOutScanning() {
    if (state.orderOutHtml5QrCode && state.orderOutScanning) {
      state.orderOutHtml5QrCode.stop().then(() => state.orderOutHtml5QrCode.clear()).catch(() => {});
    }
    state.orderOutScanning = false;
    $('#order-out-qr-reader').classList.add('hidden');
    $('#order-out-scan-toggle-btn').textContent = 'QR 스캔으로 확인';
  }

  function handleOrderOutScannedCode(rawCode) {
    const code = String(rawCode || '').trim();
    if (!code) return;
    const idx = state.orderOutItems.findIndex((it) => it.itemId === code);
    if (idx === -1) {
      toast(`목록에 없는 자재코드입니다: ${code}`, 'error');
      return;
    }
    if (state.orderOutItems[idx].checked) return; // 이미 체크된 자재는 조용히 무시
    state.orderOutItems[idx].checked = true;
    renderOrderOutItems();
    toast(`${state.orderOutItems[idx].itemName} 확인됨`, 'success');
  }

  async function submitOrderOut() {
    const items = state.orderOutItems.filter((it) => it.checked && it.quantity > 0);
    if (!items.length) return;
    if (!confirm(`선택한 ${items.length}건을 출고 처리할까요?`)) return;

    stopOrderOutScanning();

    const btn = $('#order-out-submit-btn');
    btn.disabled = true;
    try {
      const result = await Api.post('stockOutByOrder', {
        site: state.site,
        zone: state.scanZone,
        pin: state.user.pin,
        orderNo: state.orderOutNo,
        items: items.map((it) => ({ itemId: it.itemId, quantity: it.quantity }))
      });
      toast(`${result.count}건 출고 완료`, 'success');
      state.orderOutNo = '';
      state.orderOutItems = [];
      $('#order-out-no-input').value = '';
      $('#order-out-list-section').classList.add('hidden');
      renderOrderOutSubmitUI();
    } catch (err) {
      toast(err.message || '출고 처리 중 오류가 발생했습니다.', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ------------------------- 자재 목록 -------------------------

  function bindItems() {
    $('#items-search').addEventListener('input', debounce(loadItems, 300));
    $('#new-item-btn').addEventListener('click', openNewItemModal);
  }

  async function loadItems() {
    const listEl = $('#items-list');
    listEl.innerHTML = `<div class="empty-state">불러오는 중...</div>`;
    try {
      const items = await Api.get('items', { q: $('#items-search').value });
      if (!items.length) {
        listEl.innerHTML = `<div class="empty-state">등록된 자재가 없습니다.</div>`;
        return;
      }
      listEl.innerHTML = items.map((it) => `
        <div class="item-row" data-id="${escapeHtml(it.ItemID)}" data-name="${escapeHtml(it.ItemName)}">
          <div class="row-main">
            <span class="primary">${escapeHtml(it.ItemName)}</span>
            <span class="secondary">${escapeHtml(it.ItemID)}${it.Spec ? ' · ' + escapeHtml(it.Spec) : ''}${it.Category ? ' · ' + escapeHtml(it.Category) : ''}</span>
          </div>
          <button class="btn btn-secondary btn-small qr-view-btn">QR 라벨</button>
        </div>
      `).join('');
      $$('.qr-view-btn', listEl).forEach((btn) => {
        btn.addEventListener('click', (e) => {
          const row = e.target.closest('.item-row');
          openQrLabelModal(row.dataset.id, row.dataset.name);
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state">오류: ${escapeHtml(err.message)}</div>`;
    }
  }

  function openNewItemModal() {
    const html = `
      <div class="modal-sheet">
        <h3>신규 자재 등록</h3>
        <label class="field-label">자재명 *</label>
        <input type="text" id="ni-name" class="input" placeholder="예: 6mm 볼트" />
        <label class="field-label">규격</label>
        <input type="text" id="ni-spec" class="input" placeholder="예: M6x20" />
        <label class="field-label">단위</label>
        <input type="text" id="ni-unit" class="input" placeholder="예: EA, box, kg" />
        <label class="field-label">분류</label>
        <input type="text" id="ni-category" class="input" placeholder="예: 볼트류" />
        <div class="modal-actions">
          <button class="btn btn-secondary" id="ni-cancel">취소</button>
          <button class="btn btn-primary" id="ni-save">등록</button>
        </div>
      </div>
    `;
    const overlay = openModal(html);
    $('#ni-cancel').addEventListener('click', closeModal);
    $('#ni-save').addEventListener('click', async () => {
      const itemName = $('#ni-name').value.trim();
      if (!itemName) { toast('자재명을 입력하세요.', 'error'); return; }
      const payload = {
        itemName,
        spec: $('#ni-spec').value.trim(),
        unit: $('#ni-unit').value.trim(),
        category: $('#ni-category').value.trim()
      };
      try {
        const { itemId } = await Api.post('addItem', payload);
        closeModal();
        toast('자재가 등록되었습니다.', 'success');
        loadItems();
        openQrLabelModal(itemId, itemName);
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function openQrLabelModal(itemId, itemName) {
    const html = `
      <div class="modal-sheet">
        <h3>QR 라벨</h3>
        <div class="qr-label-preview">
          <canvas id="qr-canvas"></canvas>
          <div class="qr-item-name">${escapeHtml(itemName)}</div>
          <div class="qr-item-id">${escapeHtml(itemId)}</div>
        </div>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="qr-download">다운로드</button>
          <button class="btn btn-secondary" id="qr-print">인쇄</button>
        </div>
        <div class="modal-actions">
          <button class="btn btn-primary btn-block" id="qr-close">닫기</button>
        </div>
      </div>
    `;
    openModal(html);
    const canvas = $('#qr-canvas');
    QRCode.toCanvas(canvas, itemId, { width: 220, margin: 1 }, (err) => {
      if (err) toast('QR 생성 실패: ' + err, 'error');
    });
    $('#qr-close').addEventListener('click', closeModal);
    $('#qr-download').addEventListener('click', () => {
      const link = document.createElement('a');
      link.download = `qr-${itemId}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    });
    $('#qr-print').addEventListener('click', () => {
      const dataUrl = canvas.toDataURL('image/png');
      const w = window.open('', '_blank');
      w.document.write(`
        <html><head><title>${escapeHtml(itemId)}</title></head>
        <body style="text-align:center;font-family:sans-serif;padding:20px;">
          <img src="${dataUrl}" style="width:220px;" />
          <p style="font-weight:bold;">${escapeHtml(itemName)}</p>
          <p style="font-family:monospace;">${escapeHtml(itemId)}</p>
          <script>window.onload = () => window.print();</script>
        </body></html>
      `);
      w.document.close();
    });
  }

  // ------------------------- 입고확인 -------------------------

  // 상단 건수 표시 순서 + 각 상태의 배지/타일 색상 접미사(css의 po-status-*, summary-* 클래스와 대응).
  const INBOUND_STATUS_KEYS = ['재고확인중', '신청대기', '신청완료', '미입고', '부분입고', '입고완료', '재고사용', '부분출고', '출고완료'];
  const INBOUND_STATUS_SUFFIX = {
    '재고확인중': 'checking',
    '신청대기': 'waiting',
    '신청완료': 'applied',
    '미입고': 'none',
    '부분입고': 'partial',
    '입고완료': 'done',
    '재고사용': 'stock',
    '부분출고': 'partial-out',
    '출고완료': 'shipped',
    '취소': 'cancelled'
  };

  function canManageInbound() {
    return !!(state.user && (state.user.role === '자재담당자' || state.user.role === '관리자'));
  }

  function bindInboundCheck() {
    $('#inbound-search-btn').addEventListener('click', loadInboundCheck);
    ['#inbound-search-input', '#inbound-date-start', '#inbound-date-end'].forEach((sel) => {
      $(sel).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') loadInboundCheck();
      });
    });
  }

  // 라인 드롭다운은 사이트마다 목록이 달라서, 입고확인 화면에 들어갈 때마다(사이트가 바뀌었을
  // 수 있으므로) 현재 사이트 기준으로 다시 채운다.
  function populateInboundZoneOptions() {
    const sel = $('#inbound-zone-select');
    if (!sel) return;
    const zones = ZONES[state.site] || [];
    const current = sel.value;
    sel.innerHTML = `<option value="">전체 라인</option>` +
      zones.map((z) => `<option value="${escapeHtml(z)}">${escapeHtml(z)}</option>`).join('');
    sel.value = zones.includes(current) ? current : '';
  }

  // 검색 버튼/Enter로 호출: 새 검색이므로 상태 필터를 초기화한다.
  async function loadInboundCheck() {
    if (!state.site) return;
    state.inboundFilter = null;
    await fetchInboundRows();
  }

  // 서버에서 다시 불러와 현재 상태 필터를 유지한 채 화면을 갱신한다.
  // 재고사용/구매필요/입고/출고완료/취소 처리 직후에도 이 함수로 최신 상태를 반영한다.
  // 이름/날짜/라인을 모두 비워두면(= 전체 라인) 조건 없이 전체 데이터를 검색하며,
  // 결과가 많을 경우 서버에서 최근 100건으로 제한해 돌려준다.
  async function fetchInboundRows() {
    if (!state.site) return;
    const name = $('#inbound-search-input').value.trim();
    const startDate = $('#inbound-date-start').value;
    const endDate = $('#inbound-date-end').value;
    const zone = $('#inbound-zone-select').value;
    const listEl = $('#inbound-list');
    listEl.innerHTML = `<div class="empty-state">불러오는 중...</div>`;
    $('#inbound-summary').classList.add('hidden');
    try {
      state.inboundRows = await Api.get('checkInbound', { site: state.site, name, startDate, endDate, zone });
      renderInboundSummary();
      renderInboundList();
    } catch (err) {
      state.inboundRows = [];
      listEl.innerHTML = `<div class="empty-state">오류: ${escapeHtml(err.message)}</div>`;
    }
  }

  function renderInboundSummary() {
    const summaryEl = $('#inbound-summary');
    const rows = state.inboundRows;
    if (!rows.length) {
      summaryEl.classList.add('hidden');
      summaryEl.innerHTML = '';
      return;
    }

    const counts = {};
    INBOUND_STATUS_KEYS.forEach((k) => (counts[k] = 0));
    rows.forEach((r) => { if (counts[r.category] !== undefined) counts[r.category]++; });

    summaryEl.innerHTML = INBOUND_STATUS_KEYS.map((key) => {
      const suffix = INBOUND_STATUS_SUFFIX[key] || 'none';
      const active = state.inboundFilter === key ? ' is-active' : '';
      return `
        <button type="button" class="inbound-summary-item summary-${suffix}${active}" data-status="${escapeHtml(key)}">
          <span class="label">${escapeHtml(key)}</span><span class="value">${counts[key]}건</span>
        </button>
      `;
    }).join('');
    summaryEl.classList.remove('hidden');

    $$('.inbound-summary-item', summaryEl).forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.status;
        state.inboundFilter = state.inboundFilter === key ? null : key;
        renderInboundSummary();
        renderInboundList();
      });
    });
  }

  function renderInboundList() {
    const listEl = $('#inbound-list');
    const rows = state.inboundFilter
      ? state.inboundRows.filter((r) => r.category === state.inboundFilter)
      : state.inboundRows;

    if (!rows.length) {
      listEl.innerHTML = `<div class="empty-state">${state.inboundRows.length ? '해당 상태의 요청이 없습니다.' : '검색 결과가 없습니다.'}</div>`;
      return;
    }

    listEl.innerHTML = rows.map((r) => renderInboundCard(r)).join('');
    bindInboundCardActions(listEl);
  }

  // 카드(들)에 담긴 관리 버튼에 이벤트를 연결한다. 목록 전체를 새로 그릴 때뿐 아니라
  // updateInboundRowInPlace()가 카드 하나만 다시 그릴 때도 재사용한다.
  function bindInboundCardActions(container) {
    $$('.inbound-stock-btn', container).forEach((btn) => btn.addEventListener('click', onInboundStockUsageClick));
    $$('.inbound-receive-btn', container).forEach((btn) => btn.addEventListener('click', onInboundReceiveClick));
    $$('.inbound-outbound-btn', container).forEach((btn) => btn.addEventListener('click', onInboundOutboundClick));
    $$('.inbound-cancel-btn', container).forEach((btn) => btn.addEventListener('click', onInboundCancelClick));
  }

  function statusBadgeClass(status) {
    return 'po-status-' + (INBOUND_STATUS_SUFFIX[status] || 'none');
  }

  // 라인담당자/작업자: 본인이 신청했고 아직 재고확인중 상태인 건만 취소할 수 있다.
  // (재고사용/구매필요(신청대기)/신청완료로 넘어간 건은 이미 절차가 진행된 것으로 보고 취소를 막는다.)
  // 관리자/자재담당자: 재고확인중/재고사용/구매필요(신청대기) 건까지는 취소할 수 있고,
  // 신청완료(미입고/부분입고/입고완료)·출고완료로 넘어간 건은 취소할 수 없다.
  function canCancelInbound(r) {
    if (canManageInbound()) {
      return r.status === '재고확인중' || r.status === '신청대기' || r.status === '재고사용';
    }
    const isOwner = !!(state.user && r.requester && String(state.user.name).trim() === String(r.requester).trim());
    return isOwner && r.status === '재고확인중';
  }

  function renderInboundCard(r) {
    const stockUseUpper = String(r.stockUse || '').trim().toUpperCase();
    const isStockUsed = stockUseUpper === 'O';
    const isPurchaseNeeded = stockUseUpper === 'X';
    // 입고 버튼은 신청완료(구매요청번호 등록) 상태 중 미입고/부분입고일 때만 활성화한다.
    // 재고확인중/신청대기/재고사용/입고완료/부분출고/출고완료는 모두 비활성화.
    const canReceive = r.status === '미입고' || r.status === '부분입고';
    // 출고 진행 상태(부분출고/출고완료)가 status 표시를 덮어쓸 수 있으므로, 출고완료 버튼 활성화
    // 여부는 status 문자열이 아니라 원본 입고 완료 여부(누적입고수량 >= 요청수량)로 판단한다.
    const isInboundDone = r.requestedQty > 0 && r.cumulativeQty >= r.requestedQty;
    const canShipOut = !r.outboundDone && (stockUseUpper === 'O' || isInboundDone);

    // 재고사용/구매필요는 토글: 이미 선택된 쪽은 비활성화(선택됨 표시)하고, 반대쪽은 활성 상태로
    // 남겨 두어 언제든 다시 눌러 전환할 수 있게 한다.
    const managerActionsHtml = canManageInbound() ? `
      <button type="button" class="btn btn-small btn-secondary inbound-stock-btn${isStockUsed ? ' is-selected' : ''}" data-row-index="${r.rowIndex}" data-value="O" ${(r.outboundDone || isStockUsed) ? 'disabled' : ''}>재고사용${isStockUsed ? ' ✓' : ''}</button>
      <button type="button" class="btn btn-small btn-secondary inbound-stock-btn${isPurchaseNeeded ? ' is-selected' : ''}" data-row-index="${r.rowIndex}" data-value="X" ${(r.outboundDone || isPurchaseNeeded) ? 'disabled' : ''}>구매필요${isPurchaseNeeded ? ' ✓' : ''}</button>
      <button type="button" class="btn btn-small btn-secondary inbound-receive-btn" data-row-index="${r.rowIndex}" ${canReceive ? '' : 'disabled'}>입고</button>
      <button type="button" class="btn btn-small btn-primary inbound-outbound-btn" data-row-index="${r.rowIndex}" ${canShipOut ? '' : 'disabled'}>출고완료</button>
    ` : '';

    const cancelHtml = canCancelInbound(r)
      ? `<button type="button" class="btn btn-small inbound-cancel-btn btn-danger" data-row-index="${r.rowIndex}">취소</button>`
      : '';

    const actionsHtml = (managerActionsHtml || cancelHtml) ? `
      <div class="inbound-card-actions">
        ${managerActionsHtml}
        ${cancelHtml}
      </div>
    ` : '';

    return `
      <div class="card inbound-card" data-row-index="${r.rowIndex}">
        <div class="inbound-card-meta">
          ${r.requestDate ? `<span>요청일자 ${formatPoDate(r.requestDate)}</span>` : ''}
          ${r.zone ? `<span>· ${escapeHtml(r.zone)}</span>` : ''}
          ${r.requester ? `<span>· ${escapeHtml(r.requester)}</span>` : ''}
        </div>
        <div class="inbound-card-top">
          <div class="row-main">
            <span class="primary">${escapeHtml(r.itemName)}</span>
            <span class="secondary">${escapeHtml(r.itemId)}${r.spec ? ' · ' + escapeHtml(r.spec) : ''}</span>
          </div>
          <span class="po-status-tag ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span>
        </div>
        <div class="inbound-card-qty">
          <div class="iq-item"><span class="iq-label">요청수량</span><span class="iq-value">${Number(r.requestedQty).toLocaleString()}</span></div>
          <div class="iq-item"><span class="iq-label">재고수량</span><span class="iq-value">${Number(r.stockQty).toLocaleString()}</span></div>
          <div class="iq-item"><span class="iq-label">누적입고수량</span><span class="iq-value">${Number(r.cumulativeQty).toLocaleString()}</span></div>
          <div class="iq-item"><span class="iq-label">잔여수량</span><span class="iq-value">${Number(r.remainingQty).toLocaleString()}</span></div>
        </div>
        ${actionsHtml}
      </div>
    `;
  }

  // "재고사용"/"구매필요" 버튼: 재고사용(O,X) 컬럼을 O 또는 X로 바꾼다.
  // 서버가 돌려준 최신 행 데이터로 그 카드만 갱신하고(updateInboundRowInPlace), 전체 목록을
  // 다시 불러오지(fetchInboundRows) 않는다 — 다른 카드나 스크롤 위치를 건드리지 않기 위함.
  async function onInboundStockUsageClick(e) {
    const btn = e.currentTarget;
    const rowIndex = Number(btn.dataset.rowIndex);
    const value = btn.dataset.value;
    const label = value === 'O' ? '재고사용' : '구매필요';
    if (!confirm(`${label}(으)로 처리하시겠습니까?`)) return;

    btn.disabled = true;
    try {
      const updatedRow = await Api.post('updateStockUsage', { site: state.site, rowIndex, value, pin: state.user.pin });
      toast(`${label} 처리되었습니다.`, 'success');
      updateInboundRowInPlace(updatedRow);
    } catch (err) {
      btn.disabled = false;
      toast(err.message || '처리 중 오류가 발생했습니다.', 'error');
    }
  }

  // updateStockUsage 처리 직후 서버가 돌려준 최신 행 하나로 state.inboundRows와 화면(요약 건수 +
  // 그 카드)만 갱신한다. 필터에 더 이상 맞지 않게 된 경우 카드를 제거하고, 목록이 비면
  // (검색 결과 없음 메시지 등을 위해) renderInboundList()로 전체를 다시 그린다.
  function updateInboundRowInPlace(updatedRow) {
    const idx = state.inboundRows.findIndex((r) => r.rowIndex === updatedRow.rowIndex);
    if (idx !== -1) state.inboundRows[idx] = updatedRow;
    renderInboundSummary();

    const listEl = $('#inbound-list');
    const cardEl = listEl.querySelector(`.inbound-card[data-row-index="${updatedRow.rowIndex}"]`);
    if (!cardEl) {
      renderInboundList();
      return;
    }

    const stillVisible = !state.inboundFilter || updatedRow.category === state.inboundFilter;
    if (!stillVisible) {
      cardEl.remove();
      if (!listEl.querySelector('.inbound-card')) renderInboundList();
      return;
    }

    const temp = document.createElement('div');
    temp.innerHTML = renderInboundCard(updatedRow);
    const newCardEl = temp.firstElementChild;
    cardEl.replaceWith(newCardEl);
    bindInboundCardActions(newCardEl);
  }

  function onInboundReceiveClick(e) {
    const rowIndex = Number(e.currentTarget.dataset.rowIndex);
    const row = state.inboundRows.find((r) => r.rowIndex === rowIndex);
    if (row) openInboundReceiveModal(row);
  }

  // "입고" 버튼: 수량 입력 팝업을 띄우고, 확인 시 그 요청 건에 직접 입고수량을 누적한다.
  function openInboundReceiveModal(row) {
    const html = `
      <div class="modal-sheet">
        <h3>입고 처리</h3>
        <p class="muted">${escapeHtml(row.itemName)} (${escapeHtml(row.itemId)})</p>
        <p class="muted">요청수량 ${Number(row.requestedQty).toLocaleString()} · 잔여수량 ${Number(row.remainingQty).toLocaleString()}</p>
        <label class="field-label">입고 수량</label>
        <input type="number" id="inbound-receive-qty" class="input" min="1" step="1" inputmode="numeric" placeholder="수량" />
        <div class="modal-actions">
          <button class="btn btn-secondary" id="inbound-receive-cancel">취소</button>
          <button class="btn btn-primary" id="inbound-receive-confirm">확인</button>
        </div>
      </div>
    `;
    openModal(html);
    $('#inbound-receive-cancel').addEventListener('click', closeModal);
    $('#inbound-receive-confirm').addEventListener('click', async () => {
      const qty = Number($('#inbound-receive-qty').value);
      if (!qty || qty <= 0) {
        toast('올바른 수량을 입력하세요.', 'error');
        return;
      }
      try {
        await Api.post('inboundByManager', { site: state.site, rowIndex: row.rowIndex, quantity: qty, pin: state.user.pin });
        toast('입고 처리되었습니다.', 'success');
        closeModal();
        await fetchInboundRows();
      } catch (err) {
        toast(err.message || '입고 처리 중 오류가 발생했습니다.', 'error');
      }
    });
  }

  function onInboundOutboundClick(e) {
    const rowIndex = Number(e.currentTarget.dataset.rowIndex);
    const row = state.inboundRows.find((r) => r.rowIndex === rowIndex);
    if (row) openInboundShipModal(row);
  }

  // "출고완료" 버튼: 수량 입력 팝업을 띄우고, 확인 시 그 요청 건에만(다른 건은 건드리지 않고)
  // 입력한 수량만큼 누적출고수량을 더한다. 선입선출은 적용하지 않는다(QR 스캔 출고 전용 로직).
  function openInboundShipModal(row) {
    const remaining = Number(row.remainingShipQty);
    const html = `
      <div class="modal-sheet">
        <h3>출고완료 처리</h3>
        <p class="muted">${escapeHtml(row.itemName)} (${escapeHtml(row.itemId)})</p>
        <p class="muted">요청수량 ${Number(row.requestedQty).toLocaleString()} · 누적출고수량 ${Number(row.shippedQty).toLocaleString()} · 잔여출고수량 ${remaining.toLocaleString()}</p>
        <label class="field-label">출고 수량</label>
        <input type="number" id="inbound-ship-qty" class="input" min="1" step="1" inputmode="numeric" placeholder="수량" />
        <div class="modal-actions">
          <button class="btn btn-secondary" id="inbound-ship-cancel">취소</button>
          <button class="btn btn-primary" id="inbound-ship-confirm">확인</button>
        </div>
      </div>
    `;
    openModal(html);
    $('#inbound-ship-cancel').addEventListener('click', closeModal);
    $('#inbound-ship-confirm').addEventListener('click', async () => {
      const qty = Number($('#inbound-ship-qty').value);
      if (!qty || qty <= 0) {
        toast('올바른 수량을 입력하세요.', 'error');
        return;
      }
      try {
        await Api.post('outboundComplete', { site: state.site, rowIndex: row.rowIndex, quantity: qty, pin: state.user.pin });
        toast('출고완료 처리되었습니다.', 'success');
        closeModal();
        await fetchInboundRows();
      } catch (err) {
        toast(err.message || '출고완료 처리 중 오류가 발생했습니다.', 'error');
      }
    });
  }

  async function onInboundCancelClick(e) {
    const btn = e.currentTarget;
    const rowIndex = Number(btn.dataset.rowIndex);
    if (!confirm('구매 요청을 취소하시겠습니까?')) return;

    btn.disabled = true;
    try {
      await Api.post('cancelPurchase', { site: state.site, rowIndex, pin: state.user.pin });
      toast('구매 요청이 취소되었습니다.', 'success');
      await fetchInboundRows();
    } catch (err) {
      btn.disabled = false;
      toast(err.message || '취소 처리 중 오류가 발생했습니다.', 'error');
    }
  }

  // ------------------------- 이력 -------------------------

  function bindHistory() {
    $('#history-type-filter').addEventListener('change', loadHistory);
  }

  async function loadHistory() {
    if (!state.site) return;
    const listEl = $('#history-list');
    listEl.innerHTML = `<div class="empty-state">불러오는 중...</div>`;
    try {
      const rows = await Api.get('transactions', {
        site: state.site,
        type: $('#history-type-filter').value,
        limit: 50
      });
      if (!rows.length) {
        listEl.innerHTML = `<div class="empty-state">이력이 없습니다.</div>`;
        return;
      }
      const typeMeta = {
        IN: { label: '입고', tag: 'tag-in', qty: 'qty-in', sign: '+' },
        OUT: { label: '출고', tag: 'tag-out', qty: 'qty-out', sign: '-' }
      };
      listEl.innerHTML = rows.map((r) => {
        const meta = typeMeta[r.Type] || typeMeta.IN;
        return `
          <div class="tx-row">
            <div class="row-main">
              <span class="primary"><span class="tag ${meta.tag}">${meta.label}</span> ${escapeHtml(r.ItemName)}</span>
              <span class="secondary">${r.Zone ? escapeHtml(r.Zone) + ' · ' : ''}${escapeHtml(r.Worker)} · ${formatDateTime(r.Timestamp)}${r.Note ? ' · ' + escapeHtml(r.Note) : ''}</span>
            </div>
            <div class="row-qty ${meta.qty}">${meta.sign}${Number(r.Quantity).toLocaleString()}</div>
          </div>
        `;
      }).join('');
    } catch (err) {
      listEl.innerHTML = `<div class="empty-state">오류: ${escapeHtml(err.message)}</div>`;
    }
  }

  // ------------------------- 모달 -------------------------

  function openModal(innerHtml) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-overlay" id="modal-overlay">${innerHtml}</div>`;
    $('#modal-overlay').addEventListener('click', (e) => {
      if (e.target.id === 'modal-overlay') closeModal();
    });
    return root;
  }

  function closeModal() {
    $('#modal-root').innerHTML = '';
  }

  // ------------------------- 오프라인 큐 -------------------------

  function updateOfflineBadge() {
    const count = OfflineQueue.count();
    const badge = $('#offline-badge');
    if (count > 0) {
      badge.textContent = `오프라인 대기 ${count}건`;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }

  async function flushQueue(notify) {
    if (!navigator.onLine) return;
    if (OfflineQueue.count() === 0) return;
    const results = await OfflineQueue.flush();
    updateOfflineBadge();
    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;
    if (notify && results.length) {
      if (succeeded) toast(`대기 중이던 ${succeeded}건이 처리되었습니다.`, 'success');
      if (failed) toast(`${failed}건 처리 실패 (재고 확인 필요)`, 'error');
    }
    if (succeeded && !$('#view-home').classList.contains('hidden')) loadStock();
  }

})();
