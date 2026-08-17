(() => {
  const loginSection = document.getElementById('loginSection');
  const appSection = document.getElementById('appSection');
  const statusArea = document.getElementById('statusArea');

  const quickLoginArea = document.getElementById('quickLoginArea');
  const quickLoginBtn = document.getElementById('quickLoginBtn');
  const quickLoginEmail = document.getElementById('quickLoginEmail');

  const loginForm = document.getElementById('loginForm');
  const loginBtn = document.getElementById('loginBtn');
  const loginError = document.getElementById('loginError');

  const filterForm = document.getElementById('filterForm');
  const searchBtn = document.getElementById('searchBtn');
  const queryError = document.getElementById('queryError');
  const loadingIndicator = document.getElementById('loadingIndicator');
  const resultsArea = document.getElementById('resultsArea');
  const resultsSummary = document.getElementById('resultsSummary');
  const tableWrap = document.getElementById('tableWrap');
  const tableHeadRow = document.getElementById('tableHeadRow');
  const tableBody = document.getElementById('tableBody');
  const pagination = document.getElementById('pagination');
  const emptyState = document.getElementById('emptyState');
  const toggleJsonBtn = document.getElementById('toggleJsonBtn');
  const jsonView = document.getElementById('jsonView');
  const exportCsvBtn = document.getElementById('exportCsvBtn');
  const debugPanel = document.getElementById('debugPanel');
  const debugList = document.getElementById('debugList');

  // 優先顯示的欄位順序；其餘欄位（若有）會自動附加在後面
  const PREFERRED_COLUMNS = [
    'id', 'serial_number', 'imei', 'eld_id', 'model_code',
    'org_id', 'iccid', 'is_active',
  ];

  let showingJson = false;
  let lastDevicesPayload = null;

  function setStatus(loggedIn) {
    statusArea.innerHTML = '';
    if (loggedIn) {
      const span = document.createElement('span');
      span.textContent = '已登入';
      const btn = document.createElement('button');
      btn.textContent = '登出';
      btn.onclick = handleLogout;
      statusArea.appendChild(span);
      statusArea.appendChild(btn);
    } else {
      statusArea.textContent = '尚未登入';
    }
  }

  function showSection(loggedIn) {
    loginSection.hidden = loggedIn;
    appSection.hidden = !loggedIn;
    setStatus(loggedIn);
  }

  async function checkStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      if (data.hasDefaultCredentials) {
        quickLoginArea.hidden = false;
        quickLoginEmail.textContent = data.defaultEmailMasked;
      } else {
        quickLoginArea.hidden = true;
      }
      showSection(!!data.loggedIn);
      if (data.loggedIn) fetchDevices(1);
    } catch (err) {
      showSection(false);
    }
  }

  async function doLogin(email, password, remember) {
    loginError.hidden = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, remember }),
      });
      const data = await res.json();
      if (!data.ok) {
        loginError.textContent = data.message || '登入失敗';
        loginError.hidden = false;
        return false;
      }
      showSection(true);
      fetchDevices(1);
      return true;
    } catch (err) {
      loginError.textContent = '無法連線到本機服務，請確認後端是否已啟動。';
      loginError.hidden = false;
      return false;
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginBtn.disabled = true;
    loginBtn.textContent = '登入中…';
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;
    const remember = document.getElementById('remember').checked;
    await doLogin(email, password, remember);
    loginBtn.disabled = false;
    loginBtn.textContent = '登入';
  });

  quickLoginBtn.addEventListener('click', async () => {
    quickLoginBtn.disabled = true;
    quickLoginBtn.textContent = '登入中…';
    await doLogin('', '', false); // 留空，後端會用 .env 的預設帳密
    quickLoginBtn.disabled = false;
    quickLoginBtn.textContent = `使用預設帳號登入（${quickLoginEmail.textContent}）`;
  });

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' });
    showSection(false);
  }

  filterForm.addEventListener('submit', (e) => {
    e.preventDefault();
    fetchDevices(1);
  });

  toggleJsonBtn.addEventListener('click', () => {
    showingJson = !showingJson;
    tableWrap.hidden = showingJson;
    jsonView.hidden = !showingJson;
    toggleJsonBtn.textContent = showingJson ? '檢視表格' : '檢視原始 JSON';
    if (showingJson && lastDevicesPayload) {
      jsonView.textContent = JSON.stringify(lastDevicesPayload, null, 2);
    }
  });

  function buildQuery(page) {
    const params = new URLSearchParams();
    params.set('device_kind', document.getElementById('device_kind').value || 'eld');
    const serial = document.getElementById('serial_number').value.trim();
    if (serial) params.set('serial_number', serial);
    params.set('sort_by', document.getElementById('sort_by').value);
    params.set('sort_order', document.getElementById('sort_order').value);
    params.set('per_page', document.getElementById('per_page').value);
    params.set('page', String(page));
    return params;
  }

  async function fetchDevices(page) {
    queryError.hidden = true;
    emptyState.hidden = true;
    resultsArea.hidden = true;
    loadingIndicator.hidden = false;
    searchBtn.disabled = true;

    try {
      const params = buildQuery(page);
      const res = await fetch('/api/devices?' + params.toString());
      const data = await res.json();

      if (!data.ok) {
        if (res.status === 401) {
          showSection(false);
          return;
        }
        queryError.textContent = data.message || '查詢失敗';
        queryError.hidden = false;
        return;
      }

      renderResults(data.devices);
      renderDebug(data.debug, res.status);
    } catch (err) {
      queryError.textContent = '無法連線到本機服務，請確認後端是否已啟動。';
      queryError.hidden = false;
    } finally {
      loadingIndicator.hidden = true;
      searchBtn.disabled = false;
    }
  }

  function renderDebug(debug, httpStatus) {
    if (!debug) {
      debugPanel.hidden = true;
      return;
    }
    debugList.innerHTML = '';
    const rows = [
      ['本機 API 回應狀態', String(httpStatus)],
      ['DMS 回應狀態 (X-Inertia)', String(debug.httpStatus ?? '—')],
      ['是否觸發過 409 版本重試', debug.versionRetried ? '是' : '否'],
      ['目前 X-Inertia-Version', debug.inertiaVersion || '—'],
      ['查詢路徑', debug.path || '—'],
      ['DMS Base URL', debug.baseUrl || '—'],
      ['最後查詢時間', debug.fetchedAt ? new Date(debug.fetchedAt).toLocaleString() : '—'],
    ];
    rows.forEach(([label, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      debugList.appendChild(dt);
      debugList.appendChild(dd);
    });
    debugPanel.hidden = false;
  }

  function toCsv(rows, columns) {
    const escape = (v) => {
      if (v === null || v === undefined) return '';
      const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
      if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    const lines = [columns.join(',')];
    rows.forEach((row) => {
      lines.push(columns.map((c) => escape(row[c])).join(','));
    });
    return lines.join('\r\n');
  }

  exportCsvBtn.addEventListener('click', () => {
    if (!lastDevicesPayload || !lastDevicesPayload.data || !lastDevicesPayload.data.length) return;
    const rows = lastDevicesPayload.data;
    const allKeys = Object.keys(rows[0]);
    const columns = [
      ...PREFERRED_COLUMNS.filter((k) => allKeys.includes(k)),
      ...allKeys.filter((k) => !PREFERRED_COLUMNS.includes(k)),
    ];
    const csv = '﻿' + toCsv(rows, columns); // 加 BOM，Excel 開啟中文才不會亂碼
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = `dms-devices-${ts}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  function renderResults(paginator) {
    lastDevicesPayload = paginator;
    const rows = (paginator && paginator.data) || [];

    if (!rows.length) {
      emptyState.hidden = false;
      resultsArea.hidden = true;
      return;
    }

    // 決定欄位順序：常見欄位優先，其餘依原始順序附加在後面
    const allKeys = Object.keys(rows[0]);
    const columns = [
      ...PREFERRED_COLUMNS.filter((k) => allKeys.includes(k)),
      ...allKeys.filter((k) => !PREFERRED_COLUMNS.includes(k)),
    ];

    tableHeadRow.innerHTML = '';
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.textContent = col;
      tableHeadRow.appendChild(th);
    });

    tableBody.innerHTML = '';
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      columns.forEach((col) => {
        const td = document.createElement('td');
        const val = row[col];
        if (typeof val === 'boolean') {
          td.textContent = val ? 'true' : 'false';
          td.className = val ? 'bool-true' : 'bool-false';
        } else if (val === null || val === undefined) {
          td.textContent = '—';
        } else if (typeof val === 'object') {
          td.textContent = JSON.stringify(val);
        } else {
          td.textContent = String(val);
        }
        tr.appendChild(td);
      });
      tableBody.appendChild(tr);
    });

    resultsSummary.textContent =
      `共 ${paginator.total} 筆，第 ${paginator.current_page} / ${paginator.last_page} 頁`;

    renderPagination(paginator);

    if (showingJson) {
      jsonView.textContent = JSON.stringify(paginator, null, 2);
    }

    resultsArea.hidden = false;
    emptyState.hidden = true;
  }

  function renderPagination(paginator) {
    pagination.innerHTML = '';

    const prevBtn = document.createElement('button');
    prevBtn.textContent = '← 上一頁';
    prevBtn.disabled = !paginator.prev_page_url;
    prevBtn.onclick = () => fetchDevices(paginator.current_page - 1);
    pagination.appendChild(prevBtn);

    const pageInfo = document.createElement('span');
    pageInfo.textContent = `第 ${paginator.current_page} 頁，共 ${paginator.last_page} 頁`;
    pagination.appendChild(pageInfo);

    const nextBtn = document.createElement('button');
    nextBtn.textContent = '下一頁 →';
    nextBtn.disabled = !paginator.next_page_url;
    nextBtn.onclick = () => fetchDevices(paginator.current_page + 1);
    pagination.appendChild(nextBtn);
  }

  checkStatus();
})();
