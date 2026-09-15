(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const statuses = {
    new: "새 접수",
    contacted: "상담 중",
    completed: "상담 완료",
    archived: "보관함",
  };
  const kinds = {
    visit: "방문상담",
    trial: "무료체험 신청",
    pricing: "비용 문의",
  };
  const branches = { anyang: "더비다 안양점", incheon: "더비다 인천점" };
  const fields = {
    branch: "희망 지점",
    date: "희망 방문일",
    time: "희망 시간",
    elderName: "어르신 성함",
    guardianName: "보호자 성함",
    guardianPhone: "연락처",
    relationship: "관계",
    inquiryType: "상담 유형",
    name: "신청자",
    organization: "기관명",
    phone: "연락처",
  };
  const drafts = new Map();
  const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFormatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  let page = 1,
    total = 0,
    items = [],
    selectedId = null,
    loading = false,
    saving = false,
    loadVersion = 0;
  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const applicant = (item) => item.data.guardianName || item.data.name;
  const dateText = (value) => dateFormatter.format(new Date(value));
  const timeText = (value) => timeFormatter.format(new Date(value));
  const statusBadge = (status) =>
    make("span", "badge status-" + status, statuses[status]);
  function message(text, error = false) {
    $("message").textContent = text;
    $("message").classList.toggle("error", error);
  }
  function updateBusy() {
    const busy = loading || saving;
    $("request-board").setAttribute("aria-busy", String(busy));
    $("filters").querySelector("button").disabled = busy;
    $("previous").disabled = busy || page <= 1;
    $("next").disabled = busy || page * 30 >= total;
    $("logout").disabled = saving;
    $("request-rows")
      .querySelectorAll("button")
      .forEach((button) => {
        button.disabled = saving;
      });
    $("request-detail")
      .querySelectorAll("button,input,select,textarea")
      .forEach((control) => {
        control.disabled = saving;
      });
  }
  function auth(signedIn) {
    $("workspace").hidden = !signedIn;
    $("login-section").hidden = signedIn;
    $("logout").hidden = !signedIn;
    if (!signedIn) {
      loadVersion++;
      loading = false;
      items = [];
      selectedId = null;
      drafts.clear();
      $("request-rows").replaceChildren();
      $("counts").replaceChildren();
      $("result-count").textContent = "";
      renderDetail();
    }
  }
  async function api(path, body) {
    const response = await fetch("/api/support/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) auth(false);
      throw new Error(data.error || "요청을 처리하지 못했습니다.");
    }
    return data;
  }
  async function action(fn, button) {
    if (button) button.disabled = true;
    try {
      message("");
      await fn();
    } catch (e) {
      message(
        e.name === "TimeoutError"
          ? "연결 시간이 초과되었습니다. 다시 시도해 주세요."
          : e.message,
        true,
      );
    } finally {
      if (button) button.disabled = false;
    }
  }
  function renderRows() {
    $("request-rows").replaceChildren(
      ...items.map((item, index) => {
        const row = make("tr", selectedId === item.id ? "is-selected" : "");
        row.dataset.requestId = item.id;
        const titleCell = make("td"),
          title = make("button", "request-title", kinds[item.kind]);
        title.type = "button";
        title.dataset.requestId = item.id;
        title.setAttribute(
          "aria-label",
          applicant(item) + " · " + kinds[item.kind] + " 상세 보기",
        );
        title.setAttribute("aria-controls", "request-detail");
        if (selectedId === item.id) title.setAttribute("aria-current", "true");
        title.addEventListener("click", () => selectItem(item.id));
        titleCell.append(
          title,
          make(
            "span",
            "request-subtitle",
            item.kind === "visit"
              ? branches[item.data.branch]
              : item.data.organization,
          ),
        );
        const nameCell = make("td", "applicant-cell");
        nameCell.append(
          make("span", "", applicant(item)),
          make("span", "mobile-date", dateText(item.created)),
        );
        const dateCell = make("td", "date-cell", dateText(item.created));
        dateCell.append(make("span", "request-time", timeText(item.created)));
        const stateCell = make("td", "status-cell");
        stateCell.append(statusBadge(item.status));
        const siteCell = make("td", "site-cell");
        siteCell.append(
          make(
            "span",
            "site-label " + item.environment,
            item.environment === "dev" ? "개발" : "운영",
          ),
        );
        row.append(
          make("td", "number-cell", String(total - (page - 1) * 30 - index)),
          titleCell,
          nameCell,
          dateCell,
          stateCell,
          siteCell,
        );
        row.addEventListener("click", (event) => {
          if (!event.target.closest("button") && !saving) selectItem(item.id);
        });
        return row;
      }),
    );
    $("list-empty").hidden = items.length > 0;
    updateBusy();
  }
  function selectItem(id) {
    if (saving) return;
    selectedId = id;
    renderRows();
    renderDetail();
    $("detail-heading").focus({ preventScroll: true });
    if (window.matchMedia("(max-width:960px)").matches)
      $("request-detail").scrollIntoView({ block: "start" });
  }
  function closeDetail() {
    const previousId = selectedId;
    selectedId = null;
    renderRows();
    renderDetail();
    const trigger = [...$("request-rows").querySelectorAll("button")].find(
      (button) => button.dataset.requestId === previousId,
    );
    (trigger || $("list-heading")).focus({ preventScroll: true });
    if (window.matchMedia("(max-width:960px)").matches)
      (trigger || $("list-heading")).scrollIntoView({ block: "center" });
  }
  function renderDetail() {
    const panel = $("request-detail"),
      item = items.find((entry) => entry.id === selectedId);
    panel.replaceChildren();
    $("request-board").classList.toggle("detail-open", Boolean(item));
    if (!item) {
      const empty = make("div", "detail-placeholder"),
        mark = make("span", "placeholder-mark", "≡");
      mark.setAttribute("aria-hidden", "true");
      empty.append(
        mark,
        make("h2", "", "신청 내용을 확인하세요"),
        make(
          "p",
          "",
          "목록에서 신청을 선택하면 상세 내용과 처리 상태를 확인할 수 있습니다.",
        ),
      );
      panel.append(empty);
      return;
    }
    const topbar = make("div", "detail-topbar"),
      close = make("button", "detail-close", "목록으로");
    close.type = "button";
    close.addEventListener("click", closeDetail);
    topbar.append(make("span", "", "신청 상세"), close);
    const body = make("div", "detail-body"),
      meta = make("div", "detail-meta");
    meta.append(
      make("span", "badge", kinds[item.kind]),
      statusBadge(item.status),
      make(
        "span",
        "badge " + item.environment,
        item.environment === "dev" ? "개발 사이트" : "운영 사이트",
      ),
    );
    const heading = make("h2", "", applicant(item));
    heading.id = "detail-heading";
    heading.tabIndex = -1;
    body.append(
      meta,
      heading,
      make(
        "p",
        "detail-date",
        dateText(item.created) + " " + timeText(item.created) + " 접수",
      ),
    );
    const dl = make("dl", "detail-fields");
    for (const [key, label] of Object.entries(fields))
      if (item.data[key]) {
        let value = item.data[key];
        if (key === "branch") value = branches[value];
        if (key === "inquiryType")
          value =
            { demo: "무료체험 신청", pricing: "비용 문의" }[value] || value;
        const dd = make("dd");
        if (key === "phone" || key === "guardianPhone") {
          const link = make("a", "", value);
          link.href = "tel:" + value.replace(/[^\d+]/g, "");
          dd.append(link);
        } else dd.textContent = value;
        dl.append(make("dt", "", label), dd);
      }
    body.append(dl);
    if (item.data.message)
      body.append(
        make("h3", "detail-section-title", "문의 내용"),
        make("p", "inquiry-message", item.data.message),
      );
    body.append(
      make("p", "detail-consent", "개인정보 수집·이용에 동의한 신청입니다."),
    );
    const draft = drafts.get(item.id) || item;
    const controls = make("form", "detail-actions"),
      statusLabel = make("label", "", "처리 상태"),
      select = make("select");
    select.id = "detail-status";
    for (const [value, label] of Object.entries(statuses))
      select.add(new Option(label, value));
    select.value = draft.status;
    statusLabel.append(select);
    const noteLabel = make("label", "", "담당자 메모"),
      note = make("textarea");
    note.id = "detail-note";
    note.maxLength = 2000;
    note.placeholder = "상담 내용이나 다음에 확인할 사항을 남겨 주세요.";
    note.value = draft.note;
    noteLabel.append(note);
    const saveRow = make("div", "save-row"),
      dirty = make("span", "draft-indicator", "저장 전 변경사항");
    dirty.hidden = !drafts.has(item.id);
    const save = make("button", "save", "상태·메모 저장");
    save.type = "submit";
    saveRow.append(dirty, save);
    const feedback = make("p", "save-feedback");
    feedback.id = "detail-feedback";
    feedback.setAttribute("role", "status");
    function remember() {
      const changed = select.value !== item.status || note.value !== item.note;
      if (changed)
        drafts.set(item.id, { status: select.value, note: note.value });
      else drafts.delete(item.id);
      dirty.hidden = !changed;
      feedback.textContent = "";
    }
    select.addEventListener("change", remember);
    note.addEventListener("input", remember);
    controls.append(
      statusLabel,
      noteLabel,
      saveRow,
      feedback,
      make(
        "p",
        "detail-updated",
        "마지막 저장 · " +
          dateText(item.updated) +
          " " +
          timeText(item.updated),
      ),
    );
    controls.addEventListener("submit", (event) => {
      event.preventDefault();
      if (saving) return;
      action(async () => {
        saving = true;
        updateBusy();
        try {
          const result = await api("website-requests/status", {
            id: item.id,
            status: select.value,
            note: note.value,
          });
          if (!result.saved)
            throw new Error(
              "저장 결과를 확인하지 못했습니다. 다시 시도해 주세요.",
            );
          item.status = select.value;
          item.note = note.value;
          drafts.delete(item.id);
          message("처리 상태와 메모를 저장했습니다.");
          await load();
          if (selectedId === item.id && $("detail-feedback"))
            $("detail-feedback").textContent =
              "처리 상태와 메모를 저장했습니다.";
        } finally {
          saving = false;
          updateBusy();
        }
      });
    });
    body.append(controls);
    panel.append(topbar, body);
    updateBusy();
  }
  async function load() {
    const version = ++loadVersion;
    loading = true;
    updateBusy();
    try {
      const query = new URLSearchParams(new FormData($("filters")));
      query.set("page", String(page));
      const data = await api("website-requests?" + query);
      if (version !== loadVersion) return;
      total = data.total;
      if (page > 1 && !data.cards.length) {
        page = Math.max(1, Math.ceil(total / 30));
        return await load();
      }
      items = data.cards;
      const removedSelection =
        selectedId && !items.some((item) => item.id === selectedId);
      if (removedSelection) selectedId = null;
      $("counts").replaceChildren(
        ...Object.entries(statuses).map(([key, label]) => {
          const n = make("div", "count", label);
          n.append(make("strong", "", String(data.counts[key] || 0)));
          return n;
        }),
      );
      $("result-count").textContent = "총 " + total + "건";
      $("page").textContent = page + " / " + Math.max(1, Math.ceil(total / 30));
      renderRows();
      renderDetail();
      if (removedSelection) $("list-heading").focus({ preventScroll: true });
    } finally {
      if (version === loadVersion) {
        loading = false;
        updateBusy();
      }
    }
  }
  $("login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    action(async () => {
      await api("login", { key: $("access-key").value });
      $("access-key").value = "";
      auth(true);
      await load();
    }, event.submitter);
  });
  $("logout").addEventListener("click", (event) =>
    action(async () => {
      await api("logout", {});
      auth(false);
      message("로그아웃했습니다.");
    }, event.currentTarget),
  );
  $("filters").addEventListener("submit", (event) => {
    event.preventDefault();
    if (loading || saving) return;
    page = 1;
    action(load);
  });
  $("previous").addEventListener("click", () => {
    if (loading || saving || page <= 1) return;
    page--;
    action(load);
  });
  $("next").addEventListener("click", () => {
    if (loading || saving || page * 30 >= total) return;
    page++;
    action(load);
  });
  window.addEventListener("beforeunload", (event) => {
    if (drafts.size) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  action(async () => {
    const session = await api("session");
    auth(session.authenticated);
    if (session.authenticated) await load();
  });
})();
