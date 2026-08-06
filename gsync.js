// Google Calendar 양방향 동기화.
//
// 흐름은 한 번의 sync 안에서 pull → 삭제 push → 변경 push 순서로 돈다.
// pull 을 먼저 하는 이유는 "나중에 고친 쪽이 이긴다"를 판정하기 위해서다. 구글 쪽이
// 더 최신이면 로컬을 덮어쓰고, 로컬이 더 최신이면 dirty 로 남겨 뒤이은 push 가 올린다.
//
// 이 파일은 화면을 모르고, 저장소·토큰·렌더링은 전부 deps 로 주입받는다.
// 덕분에 브라우저 없이도 가짜 fetch 로 동작을 검증할 수 있다.
(function (global) {
  "use strict";

  const API = "https://www.googleapis.com/calendar/v3/calendars";
  const FULL_SYNC_DAYS = 90;          // 처음 동기화할 때 거슬러 올라가는 기간
  const PAGE_SIZE = 250;

  // 우리 색 ↔ 구글 colorId. 블루는 구글 기본색(colorId 없음)에 대응시킨다.
  const COLOR_TO_GOOGLE = {
    blue: "", green: "2", red: "11", orange: "6",
    yellow: "5", purple: "3", indigo: "9", graphite: "8"
  };
  const GOOGLE_TO_COLOR = {
    "1": "indigo", "2": "green", "3": "purple", "4": "red", "5": "yellow", "6": "orange",
    "7": "blue", "8": "graphite", "9": "indigo", "10": "green", "11": "red"
  };

  const pad = (n) => String(n).padStart(2, "0");
  const dateKeyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split("-").map(Number);
    return dateKeyOf(new Date(y, m - 1, d + n));
  }

  function plusHour(t) {
    const [h, m] = String(t).split(":").map(Number);
    if (Number.isNaN(h)) return "10:00";
    if (h >= 23) return "23:59";
    return `${pad(h + 1)}:${pad(m || 0)}`;
  }

  // ---------- 변환 ----------
  function localToGoogle(ev, timeZone) {
    const body = {
      summary: ev.title || "(제목 없음)",
      description: ev.desc || ""
    };
    if (ev.allDay) {
      // 구글의 종일 일정은 종료일이 배타적이라 하루를 더해야 같은 날 하루가 된다.
      body.start = { date: ev.date };
      body.end = { date: addDays(ev.date, 1) };
    } else {
      const start = ev.start || "09:00";
      let end = ev.end || plusHour(start);
      if (end <= start) end = plusHour(start);
      body.start = { dateTime: `${ev.date}T${start}:00`, timeZone };
      body.end = { dateTime: `${ev.date}T${end}:00`, timeZone };
    }
    const colorId = COLOR_TO_GOOGLE[ev.color];
    if (colorId) body.colorId = colorId;
    return body;
  }

  function googleToLocal(item, calendarId, prev, uid) {
    const start = item.start || {};
    const end = item.end || {};
    const allDay = Boolean(start.date);

    let date, startTime = "", endTime = "";
    if (allDay) {
      date = start.date;
    } else {
      // dateTime 은 일정 자신의 시간대로 오므로, Date 로 파싱해 보는 사람의 시간대로 옮긴다.
      const sd = new Date(start.dateTime);
      date = dateKeyOf(sd);
      startTime = hhmm(sd);
      if (end.dateTime) {
        const ed = new Date(end.dateTime);
        // 하루 한 칸 모델이라 자정을 넘기는 일정은 그날 끝으로 자른다.
        endTime = dateKeyOf(ed) === date ? hhmm(ed) : "23:59";
      }
    }

    return {
      id: (prev && prev.id) || uid(),
      title: item.summary || "(제목 없음)",
      date,
      allDay,
      start: allDay ? "" : startTime,
      end: allDay ? "" : endTime,
      color: GOOGLE_TO_COLOR[item.colorId] || "blue",
      desc: item.description || item.location || "",
      googleEventId: item.id,
      googleCalendarId: calendarId,
      googleUpdated: item.updated || "",
      updatedAt: item.updated || new Date().toISOString(),
      dirty: false
    };
  }

  // ---------- 컨트롤러 ----------
  function create(deps) {
    const {
      store,                 // getEvents/setEvents/getPending/setPending/getSyncState/setSyncState/persist
      getCalendarId,
      getAccessToken,
      refreshAccessToken,    // 만료 시 조용히 새 토큰을 받아온다. 실패하면 null
      onStatus,              // (message, kind) kind: idle|working|ok|error
      onChanged,             // 로컬 일정이 바뀌었을 때 다시 그리기
      uid
    } = deps;

    const doFetch = deps.fetch || global.fetch.bind(global);
    const timeZone = deps.timeZone ||
      (global.Intl && Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";

    let running = false;
    let queued = false;
    let timer = null;
    let debounce = null;

    async function api(path, options, retried) {
      let token = getAccessToken();
      if (!token && !retried && refreshAccessToken) {
        // 토큰이 만료돼 비어 있는 경우다. 조용히 받아 오고 다시 시도한다.
        token = await refreshAccessToken();
        if (token) return api(path, options, true);
      }
      if (!token) throw Object.assign(new Error("인증 토큰이 없습니다."), { status: 401 });

      const res = await doFetch(API + path, Object.assign({}, options, {
        headers: Object.assign(
          { Authorization: `Bearer ${token}` },
          options && options.body ? { "Content-Type": "application/json" } : {},
          (options && options.headers) || {}
        )
      }));

      if (res.status === 401 && !retried && refreshAccessToken) {
        const fresh = await refreshAccessToken();
        if (fresh) return api(path, options, true);
      }
      if (res.status === 204) return {};
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw Object.assign(
          new Error((data.error && data.error.message) || `요청 실패 (${res.status})`),
          { status: res.status }
        );
      }
      return data;
    }

    const enc = encodeURIComponent;

    // ---------- 구글 → 로컬 ----------
    async function pull(calendarId) {
      let state = store.getSyncState() || {};
      if (state.calendarId !== calendarId) state = {};   // 캘린더를 바꾸면 처음부터 받는다

      const timeMin = state.timeMin ||
        new Date(Date.now() - FULL_SYNC_DAYS * 86400000).toISOString();

      let syncToken = state.syncToken || null;
      let pageToken = null;
      let items = [];
      let nextSyncToken = null;

      // do…while 로 두면 410 재시도의 continue 가 조건 검사로 빠져나가 버린다. 명시적으로 돈다.
      for (;;) {
        const p = new URLSearchParams({
          singleEvents: "true",
          showDeleted: "true",
          maxResults: String(PAGE_SIZE)
        });
        if (syncToken) p.set("syncToken", syncToken);
        else p.set("timeMin", timeMin);
        if (pageToken) p.set("pageToken", pageToken);

        let data;
        try {
          data = await api(`/${enc(calendarId)}/events?${p.toString()}`);
        } catch (err) {
          // 토큰이 너무 오래됐거나 조건이 바뀌면 구글이 410 을 준다. 전체를 다시 받는다.
          if (err.status === 410 && syncToken) {
            syncToken = null;
            pageToken = null;
            items = [];
            nextSyncToken = null;
            store.setSyncState({});
            continue;
          }
          throw err;
        }

        items = items.concat(data.items || []);
        nextSyncToken = data.nextSyncToken || nextSyncToken;
        pageToken = data.nextPageToken || null;
        if (!pageToken) break;
      }

      const events = store.getEvents().slice();
      const pendingIds = new Set(store.getPending().map((t) => t.googleEventId));
      let changed = 0;

      for (const item of items) {
        if (!item || !item.id) continue;
        if (pendingIds.has(item.id)) continue;          // 지우기로 한 일정은 되살리지 않는다

        const idx = events.findIndex((e) => e.googleEventId === item.id);

        if (item.status === "cancelled") {
          if (idx >= 0) { events.splice(idx, 1); changed++; }
          continue;
        }

        const prev = idx >= 0 ? events[idx] : null;
        if (prev && prev.dirty) {
          // 양쪽이 모두 바뀐 경우. 로컬이 더 최신이면 그대로 두고 push 단계에서 올린다.
          const theirs = new Date(item.updated || 0).getTime();
          const ours = new Date(prev.updatedAt || 0).getTime();
          if (theirs <= ours) continue;
        }

        const mapped = googleToLocal(item, calendarId, prev, uid);
        if (prev) events[idx] = Object.assign({}, prev, mapped);
        else events.push(mapped);
        changed++;
      }

      store.setEvents(events);
      store.setSyncState({ calendarId, timeMin, syncToken: nextSyncToken || syncToken || null });
      return changed;
    }

    // ---------- 로컬 → 구글 ----------
    async function pushDeletes(calendarId) {
      const pending = store.getPending();
      if (!pending.length) return 0;

      const left = [];
      let done = 0;
      for (const t of pending) {
        try {
          await api(`/${enc(t.googleCalendarId || calendarId)}/events/${enc(t.googleEventId)}`, { method: "DELETE" });
          done++;
        } catch (err) {
          // 이미 사라진 일정이면 목표를 이룬 것이다. 그 외에는 다음 기회에 다시 시도한다.
          if (err.status === 404 || err.status === 410) done++;
          else left.push(t);
        }
      }
      store.setPending(left);
      return done;
    }

    async function pushChanges(calendarId) {
      const events = store.getEvents();
      const dirty = events.filter((e) => e.dirty);
      let done = 0;

      for (const ev of dirty) {
        const body = JSON.stringify(localToGoogle(ev, timeZone));
        const target = ev.googleCalendarId || calendarId;
        try {
          let saved;
          if (ev.googleEventId) {
            try {
              saved = await api(`/${enc(target)}/events/${enc(ev.googleEventId)}`, { method: "PATCH", body });
            } catch (err) {
              // 구글에서 지워진 일정을 고친 경우엔 새로 만들어 준다.
              if (err.status === 404 || err.status === 410) {
                ev.googleEventId = null;
                saved = await api(`/${enc(calendarId)}/events`, { method: "POST", body });
              } else throw err;
            }
          } else {
            saved = await api(`/${enc(calendarId)}/events`, { method: "POST", body });
          }
          ev.googleEventId = saved.id || ev.googleEventId;
          ev.googleCalendarId = saved.id ? calendarId : target;
          ev.googleUpdated = saved.updated || "";
          ev.dirty = false;
          done++;
        } catch (err) {
          // 한 건이 실패해도 나머지는 계속 올린다. dirty 로 남으니 다음에 다시 시도한다.
          console.error("일정 올리기 실패:", ev.title, err.message);
        }
      }
      return done;
    }

    // ---------- 전체 흐름 ----------
    async function syncNow(opts) {
      const calendarId = getCalendarId();
      if (!calendarId) return { skipped: true };

      if (running) { queued = true; return { queued: true }; }
      running = true;
      onStatus("동기화 중…", "working");

      try {
        // 토큰은 한 시간이면 만료된다. 여기서 되살려 두지 않으면 주기 동기화가 조용히 멎는다.
        if (!getAccessToken()) {
          const fresh = refreshAccessToken ? await refreshAccessToken() : null;
          if (!fresh) {
            onStatus("Google 인증이 만료되었습니다. 설정에서 다시 연결해 주세요.", "error");
            return { skipped: true };
          }
        }

        if (opts && opts.full) store.setSyncState({});
        const pulled = await pull(calendarId);
        const removed = await pushDeletes(calendarId);
        const pushed = await pushChanges(calendarId);

        store.persist();
        if (pulled || pushed || removed) onChanged();

        const at = new Date();
        onStatus(`동기화 완료 · ${pad(at.getHours())}:${pad(at.getMinutes())}` +
          (pulled || pushed || removed ? ` (받음 ${pulled} · 보냄 ${pushed} · 삭제 ${removed})` : ""), "ok");
        return { pulled, pushed, removed };
      } catch (err) {
        onStatus(err.status === 401
          ? "인증이 만료되었습니다. 다시 연결해 주세요."
          : `동기화 실패: ${err.message}`, "error");
        return { error: err };
      } finally {
        running = false;
        if (queued) { queued = false; setTimeout(() => syncNow(), 0); }
      }
    }

    // 편집이 이어질 때마다 요청을 보내지 않도록 잠깐 모았다가 한 번에 올린다.
    function scheduleSync(delay) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { debounce = null; syncNow(); }, delay == null ? 1500 : delay);
    }

    function start(intervalMs) {
      stop();
      timer = setInterval(() => syncNow(), intervalMs || 60000);
      global.addEventListener("focus", onWake);
      global.addEventListener("online", onWake);
    }

    function stop() {
      if (timer) clearInterval(timer);
      timer = null;
      if (debounce) clearTimeout(debounce);
      debounce = null;
      global.removeEventListener("focus", onWake);
      global.removeEventListener("online", onWake);
    }

    function onWake() { syncNow(); }

    return {
      syncNow, scheduleSync, start, stop,
      isRunning: () => running
    };
  }

  global.GCalSync = { create, localToGoogle, googleToLocal, COLOR_TO_GOOGLE, GOOGLE_TO_COLOR };
})(window);
