// Recordle front end. Talks to the Flask API in app.py.
(() => {
  // ---------- helpers ----------
  // Each score maps to one fixed color: 1 = red, about 5 = amber, 10 = green.
  function ratingColor(r) {
    const v = Math.min(10, Math.max(0.5, Number(r)));
    const hue = Math.max(0, 2 + (v - 1) * (128 / 9));
    const light = 50 + Math.sin(((v - 1) / 9) * Math.PI) * 6;
    return `hsl(${hue.toFixed(1)} 72% ${light.toFixed(1)}%)`;
  }
  const fmt = n => { const r = Math.round(n * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
  // Averages always show one decimal ("8.0"); song scores stay as typed ("8", "7.5").
  const reduceMotionPref = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const fmtAvg = n => (Math.round(n * 10) / 10).toFixed(1);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = s => document.querySelector(s);
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  // "owner" = your own board (editable); "public" = someone's shared page (read-only)
  const MB = window.MB || { mode: "owner" };
  const RO = MB.mode === "public";

  // A short message at the bottom of the screen that fades in, stays a few seconds, then fades out.
  function toast(msg) {
    const t = document.createElement("div"); t.className = "toast"; t.textContent = msg;
    t.setAttribute("role", "status");
    document.body.appendChild(t);
    requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add("shown")));
    setTimeout(() => {
      t.classList.remove("shown");
      t.addEventListener("transitionend", () => t.remove(), { once: true });
      setTimeout(() => t.remove(), 600);  // in case the fade doesn't run (e.g. reduced motion)
    }, 2800);
  }
  const setStatus = msg => { $("#status").textContent = msg; };

  // quiet: for background saves the viewer didn't ask for; failures don't pop up a message.
  async function api(method, url, body, { quiet = false } = {}) {
    const say = msg => { if (!quiet) toast(msg); };
    const opts = { method };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers = { "Content-Type": "application/json" }; }
    let res;
    try { res = await fetch(url, opts); }
    catch (e) { say("Couldn't reach Recordle. Check your internet connection and try again."); throw e; }
    if (res.status === 401) { location.href = "/login"; throw new Error("Logged out"); }
    if (!res.ok) {
      let msg = "Something went wrong saving that.";
      try { msg = (await res.json()).error || msg; } catch (_) { }
      say(msg); throw new Error(msg);
    }
    return res.status === 204 ? null : res.json();
  }

  $("#scaleCells").innerHTML = Array.from({ length: 10 }, (_, i) =>
    `<span style="background:${ratingColor(i + 1)}">${i + 1}</span>`).join("");

  // ---------- state ----------
  const state = { artists: [], albums: new Map(), arrange: false, openId: null, ready: false };

  async function load() {
    const data = await api("GET", RO ? `/api/u/${encodeURIComponent(MB.username)}/library` : "/api/library");
    state.artists = data.artists;
    state.albums = new Map(data.albums.map(a => [a.id, a]));
    state.ready = true;
    renderDashboard();
    openFromHash();
  }
  // A link like /amy#album-12 opens that album (notifications link straight to the album).
  function openFromHash() {
    const m = location.hash.match(/^#album-(\d+)$/);
    if (m && state.albums.has(Number(m[1])) && state.openId !== Number(m[1])) openAlbum(Number(m[1]));
  }
  window.addEventListener("hashchange", openFromHash);

  function albumAvg(a) {
    const rs = a.songs.map(s => s.rating).filter(r => typeof r === "number");
    return rs.length ? rs.reduce((x, y) => x + y, 0) / rs.length : null;
  }
  // Albums grouped by artist, in the saved artist order, each group in saved album order.
  function groups() {
    const artists = [...state.artists].sort((a, b) => a.position - b.position || a.id - b.id);
    return artists.map(ar => ({
      ...ar,
      albums: [...state.albums.values()].filter(a => a.artist_id === ar.id)
        .sort((x, y) => x.position - y.position || x.created_at - y.created_at),
    })).filter(g => g.albums.length);
  }
  // Keep the local artist list in step after an album is created or moved.
  function syncArtist(album) {
    if (!state.artists.some(a => a.id === album.artist_id)) {
      const pos = state.artists.reduce((m, a) => Math.max(m, a.position), -1) + 1;
      state.artists.push({ id: album.artist_id, name: album.artist, position: pos });
    }
    pruneArtists();
  }
  function pruneArtists() {
    const used = new Set([...state.albums.values()].map(a => a.artist_id));
    state.artists = state.artists.filter(a => used.has(a.id));
  }

  // ---------- dashboard ----------
  function sleeveHtml(a) {
    const initial = esc((a.title || "?").trim().charAt(0).toUpperCase() || "?");
    return a.cover_url ? `<img src="${esc(a.cover_url)}" alt="">` : `<div class="ph">${initial}</div>`;
  }
  function cardHtml(a, ai, n) {
    const avg = albumAvg(a);
    const songs = a.songs.filter(s => s.name || s.rating != null);
    const bar = songs.length ? `<div class="mini-bar" aria-hidden="true">${songs.map(s =>
      `<i style="background:${s.rating != null ? ratingColor(s.rating) : "var(--surface-2)"}"></i>`).join("")}</div>` : "";
    return `<button class="card" type="button" data-id="${a.id}" ${state.arrange ? 'draggable="true"' : ""} aria-label="${esc(a.title)} by ${esc(a.artist)}">
      <div class="sleeve">${sleeveHtml(a)}${avg != null ? `<span class="avg" style="background:${ratingColor(avg)}">${fmtAvg(avg)}</span>` : ""}</div>
      ${state.arrange ? `<div class="card-move">
        <span class="icon-btn" role="button" tabindex="0" data-act="left" data-id="${a.id}" aria-label="Move left" ${ai === 0 ? 'style="visibility:hidden"' : ""}>◀</span>
        <span class="icon-btn" role="button" tabindex="0" data-act="right" data-id="${a.id}" aria-label="Move right" ${ai === n - 1 ? 'style="visibility:hidden"' : ""}>▶</span></div>` : ""}
      ${bar}
      <div class="card-title">${esc(a.title || "Untitled")}</div>
      <div class="card-sub">${plural(songs.length, "track")}</div>
    </button>`;
  }
  // The 5 highest-rated albums. Ties (on the average as shown, e.g. 8.3) go to the album rated most
  // recently; albums not rated since that was tracked count from when they were added.
  function topAlbums() {
    return [...state.albums.values()]
      .map(a => ({ a, avg: albumAvg(a) }))
      .filter(x => x.avg != null)
      .sort((x, y) => Number(fmtAvg(y.avg)) - Number(fmtAvg(x.avg))
        || (y.a.rated_at || y.a.created_at || 0) - (x.a.rated_at || x.a.created_at || 0))
      .slice(0, 5);
  }
  function renderTopAlbums() {
    const box = $("#topAlbums"), top = topAlbums();
    box.hidden = !top.length;
    if (!top.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="top-head"><h2 id="topAlbumsH">Top albums</h2>
        <button class="btn all-songs-btn" type="button" id="allSongsBtn">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M4 6h11M4 12h11M4 18h7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="18.5" cy="16.5" r="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M21 16.5V6l-2 1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          All songs</button></div>
      <ol class="top-list">${top.map(({ a, avg }, i) => `<li>
        <button class="top-item" type="button" data-id="${a.id}" aria-label="Number ${i + 1}: ${esc(a.title)} by ${esc(a.artist)}, average ${fmtAvg(avg)}">
          <div class="sleeve">${sleeveHtml(a)}<span class="rank" aria-hidden="true">${i + 1}</span>
            <span class="avg" style="background:${ratingColor(avg)}">${fmtAvg(avg)}</span></div>
          <div class="card-title">${esc(a.title)}</div>
          <div class="card-sub">${esc(a.artist)}${a.year ? ` · ${a.year}` : ""}</div>
        </button></li>`).join("")}</ol>`;
  }

  // ---------- All songs: every rated song in one list ----------
  // Score: highest first, ties go to the song rated most recently. A–Z by song name. Recent: newest
  // rating first. "Reverse" flips whichever order is chosen.
  const songSort = { by: "score", reverse: false };
  const ratedTime = (s, a) => s.rated_at || a.rated_at || a.created_at || 0;  // older ratings: fall back to the album's time
  function allRatedSongs() {
    const rows = [];
    for (const a of state.albums.values()) for (const s of listedSongs(a)) if (s.rating != null) rows.push({ s, a, t: ratedTime(s, a) });
    const byName = (x, y) => x.s.name.localeCompare(y.s.name, undefined, { sensitivity: "base", numeric: true }) || y.t - x.t;
    const sorters = { score: (x, y) => y.s.rating - x.s.rating || y.t - x.t, alpha: byName, recent: (x, y) => y.t - x.t || y.s.rating - x.s.rating };
    rows.sort(sorters[songSort.by]);
    return songSort.reverse ? rows.reverse() : rows;
  }
  const SORT_LABELS = { score: ["Highest first", "Lowest first"], alpha: ["A to Z", "Z to A"], recent: ["Newest first", "Oldest first"] };
  function openAllSongs() {
    closeOverlay();
    const ov = document.createElement("div"); ov.className = "overlay";
    ov.innerHTML = `<div class="sheet all-songs" role="dialog" aria-modal="true" aria-labelledby="allSongsH"><div class="sheet-body">
      <div class="all-songs-head"><h3 id="allSongsH">All songs</h3><button class="icon-btn" type="button" id="allSongsClose" aria-label="Close">✕</button></div>
      <div class="song-sort" role="group" aria-label="Sort songs">
        <div class="seg" role="radiogroup" aria-label="Sort by">${[["score", "Score"], ["alpha", "A–Z"], ["recent", "Recent"]].map(([k, label]) =>
          `<button type="button" role="radio" data-by="${k}" aria-checked="${songSort.by === k}">${label}</button>`).join("")}</div>
        <button class="btn small" type="button" id="songReverse"></button>
      </div>
      <div class="scroll" id="allSongsList"></div></div></div>`;
    document.body.appendChild(ov);
    ov.onEscape = closeOverlay;
    ov.addEventListener("mousedown", e => { if (e.target === ov) closeOverlay(); });
    $("#allSongsClose").onclick = closeOverlay;
    const render = () => {
      const rows = allRatedSongs(), now = Date.now() / 1000;
      ov.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-checked", String(b.dataset.by === songSort.by)));
      $("#songReverse").innerHTML = `<span aria-hidden="true">⇅</span> ${SORT_LABELS[songSort.by][songSort.reverse ? 1 : 0]}`;
      $("#allSongsH").textContent = `All songs (${rows.length} rated)`;
      $("#allSongsList").innerHTML = rows.length ? `<ol class="song-list">${rows.map(({ s, a, t }, i) => `<li>
          <button class="song-row" type="button" data-album="${a.id}">
            <span class="song-rank">${i + 1}</span>
            ${a.cover_url ? `<img class="note-thumb" src="${esc(smallCover(a.cover_url))}" alt="" loading="lazy">` : `<span class="note-thumb" aria-hidden="true"></span>`}
            <span class="song-info"><span class="song-name">${esc(s.name)}</span>
              <span class="song-sub">${esc(a.title)} · ${esc(a.artist)}${t ? ` · ${timeAgo(t, now)}` : ""}</span></span>
            <span class="cmp-score" style="background:${ratingColor(s.rating)}">${fmt(s.rating)}</span>
          </button></li>`).join("")}</ol>`
        : `<p class="panel-empty">No rated songs yet. Open an album and give its songs a score.</p>`;
    };
    ov.querySelector(".seg").addEventListener("click", e => {
      const b = e.target.closest("button[data-by]"); if (!b) return;
      songSort.by = b.dataset.by; songSort.reverse = false; render();
    });
    $("#songReverse").onclick = () => { songSort.reverse = !songSort.reverse; render(); };
    $("#allSongsList").addEventListener("click", e => {
      const row = e.target.closest(".song-row"); if (row) openAlbum(Number(row.dataset.album));
    });
    render();
    setTimeout(() => ov.querySelector('.seg [aria-checked="true"]')?.focus(), 0);
  }

  function renderDashboard() {
    const el = $("#shelves");
    const arrangeBtn = $("#arrangeBtn");
    if (arrangeBtn) {
      arrangeBtn.hidden = state.albums.size < 2;
      arrangeBtn.classList.toggle("on", state.arrange);
      arrangeBtn.textContent = state.arrange ? "Done arranging" : "Arrange";
    }
    el.classList.toggle("arranging", state.arrange);
    if (!state.ready) return;

    const gs = groups();
    const rated = [...state.albums.values()].reduce((n, a) => n + a.songs.filter(s => s.rating != null).length, 0);
    $("#summary").textContent = state.albums.size
      ? `${plural(state.albums.size, "album")} · ${plural(gs.length, "artist")} · ${plural(rated, "track")} rated`
      : "";
    setStatus(RO ? "View only" : state.arrange ? "Drag albums or artists, or use the arrows." : "Saved automatically");
    renderTopAlbums();

    if (!state.albums.size && RO) {
      el.innerHTML = `<div class="empty"><h2>Nothing on the shelf yet</h2><p>@${esc(MB.username)} hasn't added any albums.</p></div>`;
      return;
    }
    if (!state.albums.size) {
      el.innerHTML = `<div class="empty"><h2>Your shelf is empty</h2>
        <p>Search for an album and it's added with its cover and full tracklist. Then rate each track from 0.5 to 10 and watch the colors fill in. Albums by the same artist line up together.</p>
        <button class="btn primary" type="button" data-act="add">+ Add your first album</button></div>`;
      return;
    }
    // keep each row's sideways scroll position when the shelf redraws (after a score change, etc.)
    const scrolled = new Map([...el.querySelectorAll(".group")].map(sec => [sec.dataset.group, sec.querySelector(".grid")?.scrollLeft || 0]));
    el.innerHTML = gs.map((g, gi) => {
      const avgs = g.albums.map(albumAvg).filter(v => v != null);
      const gAvg = avgs.length ? avgs.reduce((a, b) => a + b, 0) / avgs.length : null;
      return `<section class="group" data-group="${g.id}" ${state.arrange ? 'draggable="true"' : ""}>
        <div class="group-head">
          <h2>${esc(g.name)}</h2>
          ${gAvg != null ? `<span class="group-avg" style="background:${ratingColor(gAvg)}" title="Average of ${esc(g.name)}'s albums">${fmtAvg(gAvg)}</span>` : ""}
          <span class="meta">${plural(g.albums.length, "album")}</span>
          ${state.arrange ? `<div class="group-tools">
            <button class="icon-btn" type="button" data-act="gup" data-key="${g.id}" ${gi === 0 ? "disabled" : ""} aria-label="Move ${esc(g.name)} up">▲</button>
            <button class="icon-btn" type="button" data-act="gdown" data-key="${g.id}" ${gi === gs.length - 1 ? "disabled" : ""} aria-label="Move ${esc(g.name)} down">▼</button></div>` : ""}
        </div>
        <div class="row-wrap">
          <button class="row-arrow prev" type="button" data-scroll="-1" aria-label="Previous albums by ${esc(g.name)}" hidden>‹</button>
          <div class="grid">${g.albums.map((a, ai) => cardHtml(a, ai, g.albums.length)).join("")}</div>
          <button class="row-arrow next" type="button" data-scroll="1" aria-label="More albums by ${esc(g.name)}" hidden>›</button>
        </div>
      </section>`;
    }).join("");
    el.querySelectorAll(".group").forEach(sec => {
      const grid = sec.querySelector(".grid");
      grid.scrollLeft = scrolled.get(sec.dataset.group) || 0;
      grid.addEventListener("scroll", () => updateRowArrows(grid), { passive: true });
      updateRowArrows(grid);
    });
  }
  // One row per artist, 6 albums in view; the ‹ › arrows appear only when there are more to slide to.
  function updateRowArrows(grid) {
    const wrap = grid.parentElement, max = grid.scrollWidth - grid.clientWidth;
    wrap.querySelector(".prev").hidden = grid.scrollLeft <= 2;
    wrap.querySelector(".next").hidden = grid.scrollLeft >= max - 2;
  }
  window.addEventListener("resize", () => document.querySelectorAll("#shelves .grid").forEach(updateRowArrows));

  // ---------- reordering ----------
  function saveAlbumOrder(ids) {
    ids.forEach((id, i) => { state.albums.get(id).position = i; });
    renderDashboard();
    api("PUT", "/api/order", { albums: ids }).catch(() => { });
  }
  function saveArtistOrder(ids) {
    ids.forEach((id, i) => { const a = state.artists.find(x => x.id === id); if (a) a.position = i; });
    renderDashboard();
    api("PUT", "/api/order", { artists: ids }).catch(() => { });
  }
  const groupOf = albumId => groups().find(g => g.id === state.albums.get(albumId).artist_id);

  function shiftAlbum(id, delta) {
    const ids = groupOf(id).albums.map(x => x.id); const i = ids.indexOf(id); const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    saveAlbumOrder(ids);
  }
  function shiftGroup(key, delta) {
    const ids = groups().map(g => g.id); const i = ids.indexOf(key); const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    saveArtistOrder(ids);
  }

  // ---------- dashboard events ----------
  const shelves = $("#shelves");
  shelves.addEventListener("click", e => {
    const arrow = e.target.closest(".row-arrow");
    if (arrow) {
      const grid = arrow.parentElement.querySelector(".grid");
      grid.scrollBy({ left: Number(arrow.dataset.scroll) * grid.clientWidth, behavior: reduceMotionPref() ? "auto" : "smooth" });
      return;
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      e.stopPropagation();
      const a = act.dataset.act;
      if (a === "add") openAddAlbum();
      if (a === "left") shiftAlbum(Number(act.dataset.id), -1);
      if (a === "right") shiftAlbum(Number(act.dataset.id), 1);
      if (a === "gup") shiftGroup(Number(act.dataset.key), -1);
      if (a === "gdown") shiftGroup(Number(act.dataset.key), 1);
      return;
    }
    const card = e.target.closest(".card");
    if (card && !state.arrange) openAlbum(Number(card.dataset.id));
  });
  shelves.addEventListener("keydown", e => {
    const act = e.target.closest("span[data-act]");
    if (act && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); act.click(); }
  });

  // ---------- drag to rearrange (iPhone-home-screen style) ----------
  // While you drag, the album (or artist row) moves into the spot under your cursor and the others
  // slide out of the way. Letting go keeps that order; cancelling slides everything back.
  let drag = null;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Where an element sits in the layout, ignoring any slide animation still running on it.
  function layoutBox(el) {
    const parent = el.parentElement, pr = parent.getBoundingClientRect();
    // (rows scroll sideways now, so take the row's scroll position into account)
    const left = pr.left + el.offsetLeft - parent.offsetLeft - parent.scrollLeft, top = pr.top + el.offsetTop - parent.offsetTop - parent.scrollTop;
    return { left, top, right: left + el.offsetWidth, bottom: top + el.offsetHeight, cx: left + el.offsetWidth / 2, cy: top + el.offsetHeight / 2 };
  }
  // Move `el` before/after `target`, animating every sibling from where it was to where it lands.
  function slideMove(el, target, after) {
    const items = [...el.parentElement.children];
    const before = new Map(items.map(n => [n, n.getBoundingClientRect()]));
    target.parentElement.insertBefore(el, after ? target.nextSibling : target);
    if (reduceMotion) return;
    for (const n of items) {
      const a = before.get(n), b = n.getBoundingClientRect();
      const dx = a.left - b.left, dy = a.top - b.top;
      if (dx || dy) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,.7,.3,1)" });
    }
  }
  // The album (in the dragged album's own row) nearest the cursor, counting the dragged one itself,
  // so hovering over the gap it left behind changes nothing.
  function nearestCard(e) {
    const group = e.target.closest(".group");
    if (!group || group.dataset.group !== drag.group) return null;
    const boxes = [...group.querySelectorAll(".card")].map(c => ({ c, r: layoutBox(c) }));
    const rowDist = b => e.clientY < b.r.top ? b.r.top - e.clientY : e.clientY > b.r.bottom ? e.clientY - b.r.bottom : 0;
    const nearestRow = Math.min(...boxes.map(rowDist));
    return boxes.filter(b => rowDist(b) === nearestRow)
      .reduce((a, b) => Math.abs(e.clientX - b.r.cx) < Math.abs(e.clientX - a.r.cx) ? b : a).c;
  }
  function nearestGroup(e) {
    const rows = [...shelves.querySelectorAll(".group")];
    return rows.reduce((a, b) => Math.abs(e.clientY - layoutBox(b).cy) < Math.abs(e.clientY - layoutBox(a).cy) ? b : a, rows[0]);
  }
  // Swap places with the target, the way icons do: moving right/down lands after it, left/up before it.
  function slideTo(el, target) {
    if (!target || target === el) return;
    const items = [...el.parentElement.children];
    slideMove(el, target, items.indexOf(target) > items.indexOf(el));
  }

  shelves.addEventListener("dragstart", e => {
    if (!state.arrange) return;
    const card = e.target.closest(".card");
    const el = card || e.target.closest(".group");
    if (!el) return;
    drag = card ? { type: "album", el, id: Number(card.dataset.id), group: card.closest(".group").dataset.group }
                : { type: "group", el, key: Number(el.dataset.group) };
    drag.dropped = false;
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", "x"); } catch (_) { }
    // style the spot it left as a placeholder after the browser has taken its drag picture
    requestAnimationFrame(() => drag?.el.classList.add("dragging"));
  });
  shelves.addEventListener("dragover", e => {
    if (!drag) return;
    if (drag.type === "album") {
      const target = nearestCard(e);
      if (!target) return;  // outside its artist's row
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      slideTo(drag.el, target);
    } else {
      e.preventDefault(); e.dataTransfer.dropEffect = "move";
      slideTo(drag.el, nearestGroup(e));
    }
  });
  shelves.addEventListener("drop", e => {
    if (!drag) return;
    e.preventDefault();
    // Finish here, not in dragend: saving redraws the shelf, and the browser then sends dragend to
    // the old, removed element, where it never reaches this page.
    const { type, el } = drag;
    drag = null;
    el.classList.remove("dragging");
    if (type === "album") saveAlbumOrder([...el.parentElement.querySelectorAll(".card")].map(c => Number(c.dataset.id)));
    else saveArtistOrder([...shelves.querySelectorAll(".group")].map(g => Number(g.dataset.group)));
  });
  shelves.addEventListener("dragend", () => {
    if (!drag) return;  // already handled by drop
    // Let go somewhere that isn't a spot, or pressed Escape: put everything back where it was.
    drag.el.classList.remove("dragging");
    drag = null;
    renderDashboard();
  });

  $("#topAlbums").addEventListener("click", e => {
    if (e.target.closest("#allSongsBtn")) { openAllSongs(); return; }
    const item = e.target.closest(".top-item");
    if (item) openAlbum(Number(item.dataset.id));
  });
  $("#arrangeBtn")?.addEventListener("click", () => { state.arrange = !state.arrange; renderDashboard(); });
  $("#addAlbumBtn")?.addEventListener("click", openAddAlbum);

  // ---------- album search (Apple's iTunes catalog, called from your browser) ----------
  // Searching from the browser means Apple's limit (about 20 requests a minute) applies to each
  // visitor separately, instead of everyone sharing the server's limit.
  const ITUNES = "https://itunes.apple.com";
  class SearchError extends Error {}
  async function itunes(path, params, signal) {
    const url = `${ITUNES}/${path}?${new URLSearchParams({ country: "US", ...params })}`;
    let res;
    try { res = await fetch(url, { signal }); }
    catch (err) {
      if (err.name === "AbortError") throw err;
      throw new SearchError("Search isn't reachable right now. Check your internet connection and try again.");
    }
    if (res.status === 403 || res.status === 429) throw new SearchError("Apple's music search is busy. Wait a minute and try again.");
    if (!res.ok) throw new SearchError("Album search isn't working right now. Try again in a moment.");
    try { return (await res.json()).results || []; }
    catch (_) { throw new SearchError("Apple's music search is busy. Wait a minute and try again."); }
  }
  const wordsOf = text => (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
  const JUNK_WORDS = ["tribute", "karaoke", "instrumental", "lullaby", "relaxing", "piano versions", "made famous", "cover versions"];
  // Apple's search ranks lots of singles and tribute albums first. Put full albums whose title
  // matches the search on top, and boost albums that several matching songs come from.
  function rankAlbums(items, query, songHits) {
    const q = query.toLowerCase();
    const words = wordsOf(query).filter(w => w.length > 1);
    const score = r => {
      const title = (r.collectionName || "").toLowerCase(), artist = (r.artistName || "").toLowerCase();
      let points = words.filter(w => title.includes(w)).length * 2 + words.filter(w => artist.includes(w)).length;
      if (words.length && words.every(w => title.includes(w) || artist.includes(w))) points += 3;
      const bareTitle = wordsOf(title.replace(/[(\[].*?[)\]]/g, "")).join(" ");  // drop "(Deluxe)" etc.
      const artistWords = artist.split(/\s+/);
      const typed = words.join(" "), typedWithoutArtist = words.filter(w => !artistWords.includes(w)).join(" ");
      if (bareTitle && (bareTitle === typed || bareTitle === typedWithoutArtist)) points += 3;
      if (JUNK_WORDS.some(j => title.includes(j) && !q.includes(j))) points -= 5;
      points += Math.min(3, songHits.get(r.collectionId) || 0);
      if (title.endsWith(" - single") || (r.trackCount || 0) <= 2) points -= 4;
      else if (title.endsWith(" - ep")) points -= 1;
      return points;
    };
    return items.map((r, i) => ({ r, i, s: score(r) })).sort((a, b) => b.s - a.s || a.i - b.i).map(x => x.r);
  }
  async function searchAlbums(query, signal) {
    // Album search can miss an artist's own albums (searching "blonde" skips Frank Ocean's Blonde),
    // but song search finds them, so use both.
    const [albums, songs] = await Promise.all([
      itunes("search", { term: query, entity: "album", limit: 100 }, signal),
      itunes("search", { term: query, entity: "song", limit: 100 }, signal),
    ]);
    const songHits = new Map();
    const fromSongs = songs.filter(r => r.collectionId).map(r => {
      songHits.set(r.collectionId, (songHits.get(r.collectionId) || 0) + 1);
      return { collectionId: r.collectionId, collectionName: r.collectionName, artistName: r.collectionArtistName || r.artistName,
               releaseDate: r.releaseDate, trackCount: r.trackCount, collectionExplicitness: r.collectionExplicitness, artworkUrl100: r.artworkUrl100 };
    });
    const seen = new Set(), unique = [];
    for (const r of [...albums, ...fromSongs]) if (r.collectionId && !seen.has(r.collectionId)) { seen.add(r.collectionId); unique.push(r); }
    return rankAlbums(unique, query, songHits).slice(0, 15)
      .filter(r => r.collectionType === undefined || r.collectionType === "Album")
      .map(r => ({ id: r.collectionId, title: r.collectionName || "", artist: r.artistName || "", year: (r.releaseDate || "").slice(0, 4),
                   tracks: r.trackCount, explicit: r.collectionExplicitness === "explicit", artwork: r.artworkUrl100 }));
  }
  async function lookupAlbum(id) {
    const found = await itunes("lookup", { id, entity: "song" });
    const album = found.find(r => r.wrapperType === "collection");
    if (!album) throw new SearchError("That album couldn't be found anymore. Try searching again.");
    const tracks = found.filter(r => r.wrapperType === "track" && (r.kind || "song") === "song")
      .sort((a, b) => (a.discNumber || 1) - (b.discNumber || 1) || (a.trackNumber || 0) - (b.trackNumber || 0));
    return { id: album.collectionId, title: album.collectionName || "Untitled", artist: album.artistName || "Unknown artist",
             year: Number((album.releaseDate || "").slice(0, 4)) || null, released: (album.releaseDate || "").slice(0, 10) || null,
             artwork: album.artworkUrl100 || null, tracks: tracks.map(t => (t.trackName || "").trim()) };
  }

  // ---------- add album ----------
  const closeOverlay = () => document.querySelector(".overlay")?.remove();
  // Escape closes whichever window is open (album, Add album, visibility), wherever the focus is.
  // Each window sets ov.onEscape to its own close step, so the album view still saves pending scores.
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (document.activeElement?.id === "commentBox" && document.activeElement.value.trim()) { document.activeElement.blur(); return; }
    const ov = document.querySelector(".overlay");
    if (ov?.onEscape) { e.preventDefault(); ov.onEscape(); }
  });
  function openAddAlbum() {
    closeOverlay();
    const ov = document.createElement("div"); ov.className = "overlay";
    ov.innerHTML = `<div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="addH">
      <div class="sheet-body">
        <h3 id="addH">Add album</h3>
        <div class="field"><label for="albumSearch">Search for an album</label>
          <input class="text" id="albumSearch" type="search" autocomplete="off" placeholder="Album or artist, e.g. Blonde Frank Ocean"></div>
        <div class="results" id="searchResults" aria-live="polite"></div>
        <div class="row"><button class="btn" type="button" id="newCancel">Cancel</button></div>
      </div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener("mousedown", e => { if (e.target === ov) closeOverlay(); });
    ov.onEscape = closeOverlay;
    $("#newCancel").onclick = closeOverlay;

    // --- search ---
    // Already added: the same Apple album, or (for albums added before IDs were saved) same title and artist.
    const same = (x, y) => x.trim().toLowerCase() === y.trim().toLowerCase();
    const onShelf = r => [...state.albums.values()].some(a =>
      a.itunes_id ? a.itunes_id === r.id : same(a.title, r.title) && same(a.artist, r.artist));
    let searchTimer = null, searchCtl = null, lastResults = [];
    const resultsEl = $("#searchResults");
    function showResults(results, q) {
      lastResults = results;
      if (!q) { resultsEl.innerHTML = ""; return; }
      if (!results.length) { resultsEl.innerHTML = `<p class="results-note">No albums found for “${esc(q)}”. Try different words, like the album and the artist's name.</p>`; return; }
      resultsEl.innerHTML = results.map((r, i) => `<button class="result" type="button" data-i="${i}" ${onShelf(r) ? 'disabled title="Already on your shelf"' : ""}>
        ${r.artwork ? `<img src="${esc(r.artwork)}" alt="" loading="lazy">` : `<span class="result-ph"></span>`}
        <span class="result-text"><span class="result-title">${esc(r.title)}${r.explicit ? ' <span class="e-badge" title="Explicit">E</span>' : ""}</span>
          <span class="result-sub">${esc(r.artist)}${r.year ? ` · ${esc(r.year)}` : ""}${r.tracks ? ` · ${plural(r.tracks, "track")}` : ""}</span></span>
        ${onShelf(r) ? '<span class="result-tag">On your shelf</span>' : ""}
      </button>`).join("");
    }
    $("#albumSearch").addEventListener("input", e => {
      const q = e.target.value.trim();
      clearTimeout(searchTimer); searchCtl?.abort();
      if (q.length < 2) { showResults([], ""); return; }
      resultsEl.innerHTML = `<p class="results-note">Searching…</p>`;
      searchTimer = setTimeout(async () => {
        searchCtl = new AbortController();
        try {
          showResults(await searchAlbums(q, searchCtl.signal), q);
        } catch (err) {
          if (err.name === "AbortError") return;
          resultsEl.innerHTML = `<p class="results-note">${esc(err instanceof SearchError ? err.message : "Search failed. Try again.")}</p>`;
        }
      }, 300);
    });
    $("#albumSearch").addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); resultsEl.querySelector(".result:not(:disabled)")?.click(); }
    });
    resultsEl.addEventListener("click", async e => {
      const btn = e.target.closest(".result"); if (!btn || btn.disabled) return;
      const r = lastResults[Number(btn.dataset.i)];
      resultsEl.querySelectorAll(".result").forEach(b => { b.disabled = true; });
      btn.classList.add("loading"); btn.querySelector(".result-sub").textContent = "Adding album and tracklist…";
      try {
        const details = await lookupAlbum(r.id);
        const album = await api("POST", "/api/albums/import", details);
        // reload the shelf: the new album may have slotted in among the artist's others (release order)
        await load().catch(() => { state.albums.set(album.id, album); syncArtist(album); renderDashboard(); });
        openAlbum(album.id, "rate");
      } catch (err) {
        if (err instanceof SearchError) toast(err.message);
        showResults(lastResults, $("#albumSearch").value.trim());
      }
    });
    setTimeout(() => $("#albumSearch")?.focus(), 0);
  }

  // ---------- album sheet ----------
  const songTimers = {};
  function saveSongSoon(songId, fields) {
    clearTimeout(songTimers[songId]?.t);
    const merged = { ...(songTimers[songId]?.fields || {}), ...fields };
    songTimers[songId] = { fields: merged, t: setTimeout(() => { delete songTimers[songId]; api("PATCH", `/api/songs/${songId}`, merged).catch(() => { }); }, 400) };
  }
  function flushSongs() {
    for (const [id, p] of Object.entries(songTimers)) { clearTimeout(p.t); api("PATCH", `/api/songs/${id}`, p.fields).catch(() => { }); delete songTimers[id]; }
  }

  function openAlbum(id, focusFirst) {
    closeOverlay();
    const a = state.albums.get(id); if (!a) return;
    state.openId = id;
    const ov = document.createElement("div"); ov.className = "overlay";
    ov.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(a.title)}">
      <button class="icon-btn close-x" type="button" id="closeAlbum" aria-label="Close">✕</button>
      <div class="album-head">
        <div class="sleeve">${sleeveHtml(a)}</div>
        <div class="album-meta">
          <h2 class="t-title">${esc(a.title)}</h2>
          <p class="t-artist">${esc(a.artist)}<span id="albYear">${a.year ? ` · ${a.year}` : ""}</span></p>
          <div class="stats" id="albStats"></div>
        </div>
      </div>
      <div class="tracks" id="tracks"></div>
      ${RO ? "" : `<p class="tip">'Enter' key moves to the next song's score. Scores run up to 10, halves allowed.</p>`}
      <section class="comments" aria-labelledby="commentsH">
        <h4 id="commentsH">Comments</h4>
        <div id="commentList"><p class="panel-empty">Loading comments…</p></div>
        <div id="commentForm"></div>
      </section>
      <div class="sheet-foot" id="foot">
        ${RO ? "<span></span>" : `<button class="btn danger" type="button" id="delAlbum">Delete album</button>`}
        <button class="btn primary" type="button" id="doneAlbum">Done</button>
      </div></div>`;
    document.body.appendChild(ov);
    renderTracks(); renderStats();

    const close = () => {
      flushSongs(); state.openId = null; closeOverlay(); renderDashboard();
      if (/^#album-\d+$/.test(location.hash)) history.replaceState(null, "", location.pathname);  // don't reopen on reload
    };
    ov.addEventListener("mousedown", e => { if (e.target === ov) close(); });
    $("#closeAlbum").onclick = close; $("#doneAlbum").onclick = close;
    ov.onEscape = close;
    a._showAllComments = false;  // each time an album opens, start with just the newest comments
    loadComments(a);
    if (RO) return;
    if (!a.year) fillInYear(a);
    a._compare = null; a._comparing = false;
    loadCompare(a);

    $("#delAlbum").onclick = () => {
      const n = a.songs.filter(s => s.name).length;
      $("#foot").innerHTML = `<div class="confirm"><span>Delete “${esc(a.title)}”${n ? ` and its ${plural(n, "song")}` : ""}?</span>
        <button class="btn danger solid" type="button" id="yesDel">Delete</button><button class="btn" type="button" id="noDel">Keep it</button></div>`;
      $("#noDel").onclick = () => openAlbum(id);
      $("#yesDel").onclick = async () => {
        try {
          await api("DELETE", `/api/albums/${id}`);
          state.albums.delete(id); pruneArtists();
          state.openId = null; closeOverlay(); renderDashboard(); toast("Album deleted");
        } catch (_) { }
      };
    };
    if (focusFirst) setTimeout(() => document.querySelector(".track .rate")?.focus(), 0);
  }

  // ---------- comments on an album ----------
  // The board's owner and their friends can comment; anyone who can see the board can read them.
  async function loadComments(a) {
    let data;
    try { data = await api("GET", `/api/albums/${a.id}/comments`, undefined, { quiet: true }); }
    catch (_) { if ($("#commentList")) $("#commentList").innerHTML = `<p class="panel-empty">Comments couldn't load.</p>`; return; }
    if (state.openId !== a.id) return;
    a._comments = data;
    renderComments(a);
    const form = $("#commentForm");
    if (!data.can_post) { form.innerHTML = `<p class="panel-empty">Only ${esc(data.owner)} and their friends can comment.</p>`; return; }
    form.innerHTML = `<div class="comment-box">
        <textarea class="text" id="commentBox" rows="2" maxlength="500" placeholder="Add a comment…" aria-label="Write a comment"></textarea>
        <div class="comment-actions"><span class="comment-count" id="commentCount">0/500</span>
          <button class="btn primary small" type="button" id="commentPost" disabled>Post</button></div></div>`;
    const box = $("#commentBox"), post = $("#commentPost");
    box.addEventListener("input", () => { $("#commentCount").textContent = `${box.value.length}/500`; post.disabled = !box.value.trim(); });
    box.addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); post.click(); } });
    post.addEventListener("click", async () => {
      const body = box.value.trim(); if (!body) return;
      post.disabled = true;
      try {
        const c = await api("POST", `/api/albums/${a.id}/comments`, { body });
        a._comments.comments.push(c); a._comments.now = Date.now() / 1000;
        box.value = ""; $("#commentCount").textContent = "0/500";
        renderComments(a);
        $("#commentList").lastElementChild?.scrollIntoView({ block: "nearest" });
      } catch (_) { post.disabled = false; }
    });
  }
  // Up to 6 comments show at first (the most recent ones); "Show all" reveals the older ones.
  const COMMENTS_SHOWN = 6;
  function renderComments(a) {
    const list = $("#commentList"), data = a._comments; if (!list || !data) return;
    const all = data.comments, hidden = a._showAllComments ? 0 : Math.max(0, all.length - COMMENTS_SHOWN);
    $("#commentsH").textContent = all.length ? `Comments (${all.length})` : "Comments";
    list.innerHTML = (hidden ? `<button class="link-btn show-all-comments" type="button" id="showAllComments">Show all ${all.length} comments</button>` : "") +
      (all.length ? `<ul class="comment-list">${all.slice(hidden).map(c => `<li data-id="${c.id}">
        ${avatar(c.author)}<div class="comment-main">
          <div class="comment-meta"><b>${esc(c.author)}</b>${c.is_owner ? '<span class="comment-tag">Owner</span>' : ""}
            <time datetime="${new Date(c.created_at * 1000).toISOString()}">${timeAgo(c.created_at, data.now)}</time></div>
          <p class="comment-body">${esc(c.body)}</p></div>
        ${c.can_delete ? `<button class="icon-btn comment-del" type="button" data-del-comment="${c.id}" aria-label="Delete comment" title="Delete">✕</button>` : ""}
      </li>`).join("")}</ul>` : `<p class="panel-empty">No comments yet.${data.can_post ? " Say what you think of it." : ""}</p>`);
    $("#showAllComments")?.addEventListener("click", () => {
      a._showAllComments = true; renderComments(a);
      $("#commentList .comment-list li")?.querySelector(".comment-meta b")?.scrollIntoView({ block: "nearest" });
    });
  }
  // deleting asks first: the first click turns the ✕ into "Delete?"
  document.addEventListener("click", async e => {
    const b = e.target.closest("[data-del-comment]"); if (!b) return;
    const a = state.albums.get(state.openId); if (!a?._comments) return;
    if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Delete?"; b.classList.add("confirming"); return; }
    try {
      await api("DELETE", `/api/comments/${b.dataset.delComment}`);
      a._comments.comments = a._comments.comments.filter(c => c.id !== Number(b.dataset.delComment));
      renderComments(a);
    } catch (_) { }
  });

  // Albums added before release years were saved: look the year up once and keep it. Albums that
  // remember Apple's ID are looked up by it; older ones by an exact match on title and artist.
  async function fillInYear(a) {
    const same = (x, y) => (x || "").trim().toLowerCase() === (y || "").trim().toLowerCase();
    try {
      const term = `${a.title} ${a.artist}`;
      const match = r => same(r.collectionName, a.title) && (same(r.artistName, a.artist) || same(r.collectionArtistName, a.artist));
      let found = a.itunes_id
        ? (await itunes("lookup", { id: a.itunes_id })).filter(r => r.wrapperType === "collection")
        : (await itunes("search", { term, entity: "album", limit: 25 })).filter(match);
      // Apple's album search misses some albums (like Blonde); its song search still finds their songs.
      if (!found.length && !a.itunes_id) found = (await itunes("search", { term, entity: "song", limit: 25 })).filter(match);
      const year = Number((found[0]?.releaseDate || "").slice(0, 4));
      if (!year || !state.albums.has(a.id)) return;  // nothing found, or the album was deleted meanwhile
      a.year = (await api("POST", `/api/albums/${a.id}/year`, { year }, { quiet: true })).year;
      if (state.openId === a.id) $("#albYear").textContent = ` · ${a.year}`;
    } catch (_) { /* no year shown; that's fine */ }
  }

  function renderStats() {
    const a = state.albums.get(state.openId); if (!a) return;
    const avg = albumAvg(a);
    const rated = a.songs.filter(s => s.rating != null);
    const top = rated.length ? Math.max(...rated.map(s => s.rating)) : null;
    const tied = rated.filter(s => s.rating === top && s.name.trim());
    // When several songs share the highest score, you pick which one is the top track.
    const best = tied.find(s => s.id === a.top_song_id) || tied[0] || null;
    let topHtml = "";
    if (best && tied.length > 1 && !RO) {
      topHtml = `<div class="v"><select class="top-pick" id="topPick" aria-label="Top track (${tied.length} songs scored ${fmt(top)})">
        ${tied.map(s => `<option value="${s.id}" ${s === best ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>`;
    } else if (best) {
      topHtml = `<div class="v"><span class="v-text" title="${esc(best.name)}">${esc(best.name)}</span></div>`;
    }
    $("#albStats").innerHTML = `
      <div class="stat"><div class="k">Average</div><div class="v">${avg != null ? `<span class="big-avg" style="background:${ratingColor(avg)}">${fmtAvg(avg)}</span>` : "—"}</div></div>
      <div class="stat"><div class="k">Rated</div><div class="v">${rated.length}/${a.songs.filter(s => s.name || s.rating != null).length}</div></div>
      ${topHtml ? `<div class="stat"><div class="k">Top track${tied.length > 1 ? ` · ${tied.length}-way tie` : ""}</div>${topHtml}</div>` : ""}
      ${a._compare?.length ? `<div class="stat"><div class="k">Friends</div><div class="v">
        <button class="btn compare-btn${a._comparing ? " on" : ""}" type="button" id="compareBtn">${a._comparing ? "Back to my scores"
          : `Compare <span class="compare-count">${a._compare.length}</span>`}</button></div></div>` : ""}`;
    $("#compareBtn")?.addEventListener("click", () => { a._comparing = !a._comparing; renderStats(); a._comparing ? renderCompare(a) : renderTracks(); });
    $("#topPick")?.addEventListener("change", async e => {
      const songId = Number(e.target.value), before = a.top_song_id;
      a.top_song_id = songId;
      try { await api("PUT", `/api/albums/${a.id}/top`, { song_id: songId }); }
      catch (_) { a.top_song_id = before; renderStats(); }
    });
  }
  function trackHtml(s, i) {
    const filled = s.rating != null;
    return `<div class="track" data-sid="${s.id}">
      <span class="no">${i + 1}</span>
      <span class="name">${esc(s.name)}</span>
      <input class="rate${filled ? " filled" : ""}" id="r-${s.id}" value="${filled ? fmt(s.rating) : ""}" placeholder="–/10" inputmode="decimal"
        aria-label="Score for ${esc(s.name)} out of 10" autocomplete="off" style="${filled ? `background:${ratingColor(s.rating)}` : ""}" ${RO ? "readonly" : ""}>
    </div>`;
  }
  // Songs on the album's tracklist. Blank rows left over from the old "+ Add song" button are hidden.
  const listedSongs = a => a.songs.filter(s => s.name.trim() || s.rating != null);
  function renderTracks() {
    const a = state.albums.get(state.openId); if (!a) return;
    $("#tracks").innerHTML = listedSongs(a).map((s, i) => trackHtml(s, i)).join("");
    const tip = $(".sheet .tip"); if (tip) tip.hidden = false;
  }

  // ---------- compare an album's scores with friends ----------
  // Only friends who have this album with at least one song rated; up to 4 side by side.
  async function loadCompare(a) {
    try {
      const res = await api("GET", `/api/albums/${a.id}/compare`, undefined, { quiet: true });
      if (state.openId !== a.id) return;
      a._compare = res.friends;
      a._compareSel = res.friends.slice(0, 4).map(f => f.username);
      if (res.friends.length) renderStats();
    } catch (_) { /* no compare button; nothing else changes */ }
  }
  const scoreBox = r => r == null ? `<span class="cmp-score cmp-none" title="Not rated">–</span>`
    : `<span class="cmp-score" style="background:${ratingColor(r)}">${fmt(r)}</span>`;
  function renderCompare(a) {
    const box = $("#tracks"); if (!box) return;
    const tip = $(".sheet .tip"); if (tip) tip.hidden = true;
    const chosen = a._compare.filter(f => a._compareSel.includes(f.username));
    const myAvg = albumAvg(a);
    const avgBox = v => v == null ? `<span class="cmp-score cmp-none">–</span>` : `<span class="cmp-score cmp-avg" style="background:${ratingColor(v)}">${fmtAvg(v)}</span>`;
    box.innerHTML = `<div class="compare-pick" role="group" aria-label="Friends to compare with (up to 4)">
        <span class="compare-hint">${a._compare.length > 4 ? "Pick up to 4" : "Compare with"}</span>
        ${a._compare.map(f => { const on = a._compareSel.includes(f.username), full = !on && a._compareSel.length >= 4;
          return `<button class="chip${on ? " on" : ""}" type="button" data-friend="${esc(f.username)}" aria-pressed="${on}" ${full ? 'disabled title="You can compare up to 4 friends at once"' : ""}>
            ${esc(f.username)} <span class="chip-avg" style="background:${ratingColor(f.average)}">${fmtAvg(f.average)}</span></button>`; }).join("")}
      </div>
      <div class="compare-wrap"><table class="compare">
        <thead><tr><th class="no" scope="col">#</th><th scope="col">Song</th><th scope="col">You</th>
          ${chosen.map(f => `<th scope="col" title="${esc(f.username)}"><span class="cmp-name">${esc(f.username)}</span></th>`).join("")}</tr></thead>
        <tbody>${listedSongs(a).map((s, i) => `<tr><td class="no">${i + 1}</td><th scope="row" class="cmp-song">${esc(s.name)}</th>
          <td>${scoreBox(s.rating)}</td>${chosen.map(f => `<td>${scoreBox(f.scores[String(s.id)])}</td>`).join("")}</tr>`).join("")}</tbody>
        <tfoot><tr><td></td><th scope="row" class="cmp-song">Average</th><td>${avgBox(myAvg)}</td>
          ${chosen.map(f => `<td>${avgBox(f.average)}</td>`).join("")}</tr></tfoot>
      </table></div>`;
    box.querySelector(".compare-pick").addEventListener("click", e => {
      const chip = e.target.closest(".chip"); if (!chip || chip.disabled) return;
      const name = chip.dataset.friend;
      a._compareSel = a._compareSel.includes(name) ? a._compareSel.filter(n => n !== name) : [...a._compareSel, name].slice(0, 4);
      renderCompare(a);
      box.querySelector(`.chip[data-friend="${CSS.escape(name)}"]`)?.focus();
    });
  }
  function parseRating(v) {
    const t = String(v).trim().replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    if (!isFinite(n)) return undefined;
    return Math.round(Math.min(10, Math.max(0.5, n)) * 2) / 2;
  }
  const songFromEvent = e => {
    const a = state.albums.get(state.openId); const row = e.target.closest?.(".track");
    if (!a || !row) return null;
    return { a, s: a.songs.find(x => x.id === Number(row.dataset.sid)) };
  };
  document.addEventListener("input", e => {
    if (RO) return;
    const hit = songFromEvent(e); if (!hit || !hit.s) return;
    const { a, s } = hit;
    if (e.target.classList.contains("rate")) {
      const r = parseRating(e.target.value);
      if (r === undefined) return;
      if (s.rating !== r) a.rated_at = s.rated_at = Date.now() / 1000;  // newest-rated wins ties (Top albums, All songs)
      s.rating = r;
      e.target.classList.toggle("filled", r != null);
      e.target.style.background = r != null ? ratingColor(r) : "";
      saveSongSoon(s.id, { rating: r }); renderStats();
    }
  });
  // Clicking into a score selects it, so typing replaces the old score instead of adding to it.
  // (A click's mouseup would undo a selection made on focus, so select again on that mouseup.)
  let justFocused = null;
  document.addEventListener("focusin", e => {
    if (!e.target.classList?.contains("rate") || RO) return;
    justFocused = e.target; e.target.select();
  });
  document.addEventListener("mouseup", e => {
    if (e.target === justFocused) { e.preventDefault(); e.target.select(); }
    justFocused = null;
  });
  document.addEventListener("focusout", e => {
    if (!e.target.classList?.contains("rate")) return;
    const hit = songFromEvent(e); if (!hit || !hit.s) return;
    e.target.value = hit.s.rating != null ? fmt(hit.s.rating) : "";
  });
  document.addEventListener("keydown", e => {
    if (RO) return;
    const hit = songFromEvent(e); if (!hit || !hit.s) return;
    const { a, s } = hit;
    if (!e.target.classList.contains("rate")) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const songs = listedSongs(a), next = songs[songs.indexOf(s) + 1];
      if (next) document.getElementById("r-" + next.id).select(); else $("#doneAlbum").focus();  // last song: on to Done
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const up = e.key === "ArrowUp";
      const cur = s.rating ?? (up ? 0 : 11);
      const step = up ? Math.floor(cur) + 1 : Math.ceil(cur) - 1;   // whole numbers, with 0.5 at the bottom
      e.target.value = Math.min(10, Math.max(0.5, step));
      e.target.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  window.addEventListener("beforeunload", flushSongs);

  // ---------- friends & notifications ----------
  const bellBtn = $("#bellBtn"), friendsBtn = $("#friendsBtn");
  function timeAgo(then, now = Date.now() / 1000) {
    const s = Math.max(0, now - then);
    if (s < 60) return "just now";
    const units = [["minute", 60], ["hour", 3600], ["day", 86400], ["week", 604800]];
    if (s < 2592000) {
      const [name, size] = units.filter(([, size]) => s >= size).pop();
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
    return new Date(then * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  const smallCover = url => url ? url.replace(/\/\d+x\d+bb\.jpg$/, "/100x100bb.jpg") : null;
  const avatar = name => `<span class="avatar" aria-hidden="true">${esc((name || "?")[0].toUpperCase())}</span>`;
  function setBadge(el, n) { if (!el) return; el.hidden = !n; el.textContent = n > 99 ? "99+" : String(n || ""); }
  async function refreshBadges() {
    if (!bellBtn) return;
    try {
      const c = await api("GET", "/api/notifications/unread", undefined, { quiet: true });
      setBadge($("#bellBadge"), c.unread); setBadge($("#friendsBadge"), c.requests);
      bellBtn.setAttribute("aria-label", c.unread ? `Notifications, ${c.unread} unread` : "Notifications");
    } catch (_) { }
  }
  // Check for new notifications every 2 minutes, but only while this tab is visible, so the
  // database can sleep when nobody is looking.
  if (bellBtn) {
    refreshBadges();
    setInterval(() => { if (document.visibilityState === "visible") refreshBadges(); }, 120000);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshBadges(); });
  }

  function noteText(n) {
    const who = `<b>${esc(n.actor)}</b>`, album = `<b>${esc(n.album_title || "an album")}</b>`;
    return { friend_request: `${who} sent you a friend request`, friend_accepted: `${who} accepted your friend request`,
             album_added: `${who} added ${album} to their shelf`, album_edited: `${who} rated songs on ${album}`,
             comment: n.on_your_album ? `${who} commented on your album ${album}`
               : n.album_owner === n.actor ? `${who} replied on their album ${album}`
               : `${who} also commented on ${n.album_owner ? `${esc(n.album_owner)}'s album ` : ""}${album}` }[n.kind] || who;
  }
  async function openNotifications() {
    closeOverlay();
    const ov = document.createElement("div"); ov.className = "overlay";
    ov.innerHTML = `<div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="notesH"><div class="sheet-body">
      <h3 id="notesH">Notifications</h3><div class="scroll" id="notesList"><p class="panel-empty">Loading…</p></div>
      <div class="row"><button class="btn primary" type="button" id="notesDone">Done</button></div></div></div>`;
    document.body.appendChild(ov);
    ov.onEscape = closeOverlay;
    ov.addEventListener("mousedown", e => { if (e.target === ov) closeOverlay(); });
    $("#notesDone").onclick = closeOverlay;
    let data;
    try { data = await api("GET", "/api/notifications"); } catch (_) { $("#notesList").innerHTML = `<p class="panel-empty">Couldn't load notifications. Try again.</p>`; return; }
    const list = data.notifications;
    if (!$("#notesList")) return;  // closed while loading
    $("#notesList").innerHTML = list.length ? `<ul class="panel-list">${list.map((n, i) => {
      const thumb = n.album_cover ? `<img class="note-thumb" src="${esc(smallCover(n.album_cover))}" alt="">`
        : n.album_title ? `<span class="note-thumb" aria-hidden="true"></span>` : avatar(n.actor);
      const goes = n.kind === "friend_request" || !!n.link;
      return `<li class="${goes ? "clickable" : ""}" data-i="${i}" ${goes ? 'tabindex="0" role="button"' : ""}>${thumb}
        <span class="note">${noteText(n)}<time datetime="${new Date(n.created_at * 1000).toISOString()}">${timeAgo(n.created_at, data.now)}</time></span>
        ${n.read ? "" : '<span class="note-unread" title="New"></span>'}</li>`;
    }).join("")}</ul>` : `<p class="panel-empty">No notifications yet. When friends add or rate albums, you'll see it here.</p>`;
    const go = li => {
      const n = list[Number(li.dataset.i)];
      if (n.kind === "friend_request") openFriends();
      else if (n.link) {
        closeOverlay();
        location.href = n.link;  // same page with a new #album-… just opens that album
      }
    };
    $("#notesList").addEventListener("click", e => { const li = e.target.closest("li.clickable"); if (li) go(li); });
    $("#notesList").addEventListener("keydown", e => { const li = e.target.closest("li.clickable"); if (li && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); go(li); } });
    if (list.some(n => !n.read)) { try { await api("POST", "/api/notifications/read", {}, { quiet: true }); } catch (_) { } }
    refreshBadges();
  }

  function openFriends() {
    closeOverlay();
    const ov = document.createElement("div"); ov.className = "overlay";
    ov.innerHTML = `<div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="friendsH"><div class="sheet-body">
      <h3 id="friendsH">Friends</h3>
      <div class="field"><label for="userSearch">Find people</label>
        <input class="text" id="userSearch" type="search" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Search by username"></div>
      <div id="userResults"></div>
      <div class="scroll" id="friendsLists"><p class="panel-empty">Loading…</p></div>
      <div class="row"><button class="btn primary" type="button" id="friendsDone">Done</button></div></div></div>`;
    document.body.appendChild(ov);
    ov.onEscape = closeOverlay;
    ov.addEventListener("mousedown", e => { if (e.target === ov) closeOverlay(); });
    $("#friendsDone").onclick = closeOverlay;

    // a name links to their board when you can open it: public boards, and any friend's board
    const personLine = (r, extra = "") => `${avatar(r.username)}<span class="person">${r.can_view
      ? `<a href="/${encodeURIComponent(r.username)}">${esc(r.username)}</a>` : esc(r.username)}<small>${extra ||
      (r.is_public ? "Public board" : r.can_view ? "Private board · you can see it as a friend" : "Private board")}</small></span>`;
    const actionFor = r => ({
      none: `<button class="btn small primary" type="button" data-do="request" data-user="${esc(r.username)}">Add friend</button>`,
      request_sent: `<button class="btn small" type="button" data-do="remove" data-user="${esc(r.username)}" title="Cancel request">Requested</button>`,
      request_received: `<button class="btn small primary" type="button" data-do="request" data-user="${esc(r.username)}">Accept</button>`,
      friend: `<span class="person" style="flex:none"><small>Friends</small></span>`,
    })[r.relation];

    async function loadLists() {
      let f;
      try { f = await api("GET", "/api/friends"); } catch (_) { return; }
      const box = $("#friendsLists"); if (!box) return;
      const section = (title, items, render, empty) => `<div class="panel-section"><h4>${title}</h4>${items.length
        ? `<ul class="panel-list">${items.map(render).join("")}</ul>` : `<p class="panel-empty">${empty}</p>`}</div>`;
      box.innerHTML =
        (f.received.length ? section(`Friend requests (${f.received.length})`, f.received, r => `<li>${personLine(r, `Sent ${timeAgo(r.since)}`)}
          <button class="btn small primary" type="button" data-do="accept" data-id="${r.id}">Accept</button>
          <button class="btn small" type="button" data-do="decline" data-id="${r.id}">Decline</button></li>`, "") : "") +
        section(`Your friends (${f.friends.length})`, f.friends, r => `<li>${personLine(r)}
          <button class="btn small" type="button" data-do="unfriend" data-user="${esc(r.username)}">Remove</button></li>`,
          "No friends yet. Search for someone's username above.") +
        (f.sent.length ? section("Requests you sent", f.sent, r => `<li>${personLine(r, `Waiting since ${timeAgo(r.since)}`)}
          <button class="btn small" type="button" data-do="remove" data-user="${esc(r.username)}">Cancel</button></li>`, "") : "");
    }

    let searchTimer = null, lastQuery = "";
    async function runSearch() {
      const q = $("#userSearch")?.value.trim() || "", box = $("#userResults");
      lastQuery = q;
      if (!box) return;
      if (q.length < 2) { box.innerHTML = ""; return; }
      let res;
      try { res = await api("GET", `/api/users/search?q=${encodeURIComponent(q)}`, undefined, { quiet: true }); } catch (_) { box.innerHTML = `<p class="panel-empty">Search isn't working right now.</p>`; return; }
      if (q !== lastQuery || !$("#userResults")) return;
      box.innerHTML = res.results.length ? `<ul class="panel-list">${res.results.map(r => `<li>${personLine(r)}${actionFor(r)}</li>`).join("")}</ul>`
        : `<p class="panel-empty">Nobody with a username like “${esc(q)}”.</p>`;
    }
    $("#userSearch").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 250); });

    // one handler for every button in the window; the unfriend button asks before removing
    ov.addEventListener("click", async e => {
      const b = e.target.closest("button[data-do]"); if (!b || b.disabled) return;
      const act = b.dataset.do, user = b.dataset.user, id = b.dataset.id;
      if (act === "unfriend" && b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Remove?"; b.classList.add("danger"); return; }
      b.disabled = true;
      try {
        if (act === "request") { const r = await api("POST", "/api/friends/request", { username: user }); toast(r.relation === "friend" ? `You and ${user} are now friends` : `Friend request sent to ${user}`); }
        if (act === "accept") { await api("POST", `/api/friends/${id}/accept`); toast("Friend request accepted"); }
        if (act === "decline") await api("POST", `/api/friends/${id}/decline`);
        if (act === "remove" || act === "unfriend") await api("DELETE", `/api/friends/${encodeURIComponent(user)}`);
      } catch (_) { b.disabled = false; return; }
      await Promise.all([loadLists(), runSearch()]);
      refreshBadges();
    });
    loadLists();
    setTimeout(() => $("#userSearch")?.focus(), 0);
  }
  bellBtn?.addEventListener("click", openNotifications);
  friendsBtn?.addEventListener("click", openFriends);

  // ---------- a friend's friends (shown on a friend's board) ----------
  async function loadBoardFriends() {
    const el = $("#friendStats"); if (!el) return;
    let data;
    try { data = await api("GET", `/api/u/${encodeURIComponent(MB.username)}/friends`, undefined, { quiet: true }); } catch (_) { return; }
    el.innerHTML = `<button class="link-btn" type="button" data-list="all">${plural(data.total, "friend")}</button>
      <span aria-hidden="true">·</span>
      <button class="link-btn" type="button" data-list="mutual" ${data.mutual ? "" : "disabled"}>${data.mutual} mutual</button>`;
    el.hidden = false;
    el.addEventListener("click", e => {
      const b = e.target.closest("button[data-list]"); if (!b || b.disabled) return;
      const mutualOnly = b.dataset.list === "mutual";
      const list = mutualOnly ? data.friends.filter(f => f.mutual) : data.friends;
      closeOverlay();
      const ov = document.createElement("div"); ov.className = "overlay";
      ov.innerHTML = `<div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="bfH"><div class="sheet-body">
        <h3 id="bfH">${mutualOnly ? `Mutual friends with ${esc(MB.username)}` : `${esc(MB.username)}'s friends`}</h3>
        <div class="scroll"><ul class="panel-list">${list.map(f => `<li>${avatar(f.username)}<span class="person">${
          f.can_view && !f.you ? `<a href="/${encodeURIComponent(f.username)}">${esc(f.username)}</a>` : esc(f.username)}<small>${
          f.you ? "You" : f.mutual ? "Your friend too" : f.can_view ? "Public board" : "Private board"}</small></span></li>`).join("")}</ul></div>
        <div class="row"><button class="btn primary" type="button" id="bfDone">Done</button></div></div></div>`;
      document.body.appendChild(ov);
      ov.onEscape = closeOverlay;
      ov.addEventListener("mousedown", ev => { if (ev.target === ov) closeOverlay(); });
      $("#bfDone").onclick = closeOverlay;
      setTimeout(() => $("#bfDone")?.focus(), 0);
    });
  }
  if (RO) loadBoardFriends();

  // ---------- page visibility (private by default; public = /username) ----------
  const visBtn = $("#visBtn");
  const publicUrl = () => `${location.origin}/${MB.username}`;
  function renderVisBtn() {
    if (!visBtn) return;
    visBtn.classList.toggle("is-public", MB.isPublic);
    visBtn.textContent = MB.isPublic ? "Public" : "Private";
    visBtn.title = MB.isPublic ? `Anyone can view ${publicUrl()}` : "Only you can see your board";
  }
  function openVisibility() {
    closeOverlay();
    const ov = document.createElement("div"); ov.className = "overlay";
    ov.innerHTML = MB.isPublic
      ? `<div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="visH"><div class="sheet-body">
          <h3 id="visH">Your page is public</h3>
          <p class="body-text">Anyone with this link can see your albums and scores. Only you can change them.</p>
          <div class="share-link"><input class="text" id="shareUrl" value="${esc(publicUrl())}" readonly aria-label="Your public link">
            <button class="btn" type="button" id="copyUrl">Copy</button></div>
          <a href="/${esc(MB.username)}" target="_blank" rel="noopener">See what visitors see ↗</a>
          <div class="row"><button class="btn" type="button" id="goPrivate">Make private</button><button class="btn primary" type="button" id="visDone">Done</button></div>
        </div></div>`
      : `<div class="sheet small" role="dialog" aria-modal="true" aria-labelledby="visH"><div class="sheet-body">
          <h3 id="visH">Make your page public?</h3>
          <p class="body-text">Your board is private right now. If you make it public, anyone can view it at this link. Only you can change anything.</p>
          <div class="share-link"><input class="text" value="${esc(publicUrl())}" readonly aria-label="Your public link"></div>
          <div class="row"><button class="btn" type="button" id="visDone">Keep private</button><button class="btn primary" type="button" id="goPublic">Make public</button></div>
        </div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener("mousedown", e => { if (e.target === ov) closeOverlay(); });
    ov.onEscape = closeOverlay;
    $("#visDone").onclick = closeOverlay;
    const setPublic = async isPublic => {
      try {
        const me = await api("PUT", "/api/me/visibility", { is_public: isPublic });
        MB.isPublic = me.is_public; renderVisBtn(); openVisibility();
        toast(MB.isPublic ? "Your page is public" : "Your page is private");
      } catch (_) { }
    };
    $("#goPublic")?.addEventListener("click", () => setPublic(true));
    $("#goPrivate")?.addEventListener("click", () => setPublic(false));
    $("#copyUrl")?.addEventListener("click", () => {
      navigator.clipboard?.writeText(publicUrl()).then(() => toast("Link copied"), () => { $("#shareUrl").select(); toast("Press Ctrl+C or Cmd+C to copy"); })
        ?? ($("#shareUrl").select(), toast("Press Ctrl+C or Cmd+C to copy"));
    });
    setTimeout(() => ov.querySelector(".btn.primary")?.focus(), 0);
  }
  if (visBtn) { renderVisBtn(); visBtn.addEventListener("click", openVisibility); }

  load().catch(() => setStatus("Couldn't load your albums. Make sure app.py is running, then reload."));
})();
