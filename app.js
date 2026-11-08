/* 睡前收音机 · 播放内核
 * 电台：mp3 直流，原生 <audio>，无 hls.js、无 CORS 依赖
 * 音量：不做应用内调节，一律走系统音量；这里只保留渐弱用的 fadeMul
 */
(() => {
'use strict';

const STORE_KEY    = 'sleepradio.v1';
const FADE_SECONDS = 60;          // 最后 60 秒渐弱
const RECONNECT_MS = 3000;
const TIMER_OPTS   = [15, 30, 45, 60, 90, 120];

/* ---------------- 状态 ---------------- */
let groups = [];
let byId   = {};

let currentId = null;
let playing   = false;
let fadeMul    = 1;
let sleepAt    = 0;               // 目标停止时间戳；0 = 未设定
let sleepMin   = 0;
let reconnectTimer = null;
let lastProgressAt = 0;
let lastCurrentTime = 0;

let activeGroup = null;
const scrollPos = {};

let audio = null;

/* ---------------- DOM ---------------- */
const $ = s => document.querySelector(s);
const el = {
  tabs: $('#tabs'), grid: $('#grid'),
  nowName: $('#nowName'), nowSub: $('#nowSub'),
  btnPlay: $('#btnPlay'), icoPlay: $('#icoPlay'), icoPause: $('#icoPause'),
  btnTimer: $('#btnTimer'), timerLabel: $('#timerLabel'),
  sheet: $('#sheet'), sheetOpts: $('#sheetOpts'), sheetCancel: $('#sheetCancel'),
};

/* ---------------- 存储 ---------------- */
function loadStore(){
  try{ return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch(e){ return {}; }
}
function saveStore(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify({ currentId, sleepMin, group: activeGroup }));
  }catch(e){}
}

function esc(s){
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function fmtLeft(sec){
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2,'0')}` : `${s}s`;
}

/* ==================================================================
   渲染：分组标签 + 宫格
   ================================================================== */
function buildTabs(){
  el.tabs.innerHTML = '';
  groups.forEach(g => {
    const b = document.createElement('button');
    b.className = 'tab';
    b.dataset.gid = g.id;
    b.textContent = g.name;
    b.addEventListener('click', () => selectGroup(g.id));
    el.tabs.appendChild(b);
  });
}

function selectGroup(gid, restore){
  if(!groups.some(g => g.id === gid)) gid = groups[0] && groups[0].id;
  if(gid === activeGroup) return;

  if(activeGroup) scrollPos[activeGroup] = el.grid.scrollTop;
  activeGroup = gid;

  document.querySelectorAll('.tab').forEach(n =>
    n.classList.toggle('on', n.dataset.gid === gid));

  render();
  el.grid.scrollTop = restore ? (scrollPos[gid] || 0) : 0;
  saveStore();
}

function isWide(){ return window.innerWidth >= 900; }

function cellEl(g, st){
  const sid = g.id + '/' + st.name;
  const b = document.createElement('button');
  b.className = 'cell';
  b.dataset.sid = sid;
  b.innerHTML =
    `<span class="cell-name">${esc(st.name)}</span>` +
    `<span class="cell-sub">${esc(st.sub || '')}</span>` +
    `<span class="cell-eq"><i></i><i></i><i></i></span>`;
  b.addEventListener('click', () => onPick(sid));
  return b;
}

/* 窄屏：一次只铺一个分组（tab 切换，零滚动）
 * 宽屏：四组纵向平铺，一屏看全，不用来回切 */
function render(){
  el.grid.innerHTML = '';

  if(isWide()){
    groups.forEach(g => {
      const sec = document.createElement('section');
      sec.className = 'grp';

      const h = document.createElement('h2');
      h.className = 'grp-h';
      h.innerHTML = `${esc(g.name)}<em>${g.stations.length}</em>`;
      sec.appendChild(h);

      const box = document.createElement('div');
      box.className = 'cells';
      g.stations.forEach(st => box.appendChild(cellEl(g, st)));
      sec.appendChild(box);

      el.grid.appendChild(sec);
    });
  }else{
    const g = groups.find(x => x.id === activeGroup);
    if(g) g.stations.forEach(st => el.grid.appendChild(cellEl(g, st)));
  }

  fitRows();
  paintActive();
}

/* 窄屏：行高按可用高度均分，台少的组不至于在屏幕正中孤零零一条。
 * 宽屏四组平铺，行高固定，不参与计算。 */
function fitRows(){
  if(isWide()){ el.grid.style.gridAutoRows = ''; return; }
  const g = groups.find(x => x.id === activeGroup);
  if(!g || !g.stations.length) return;

  const cols = (getComputedStyle(el.grid).gridTemplateColumns || '').split(' ').filter(Boolean).length || 1;
  const rows = Math.ceil(g.stations.length / cols);
  const gap  = parseFloat(getComputedStyle(el.grid).rowGap) || 8;
  const H    = el.grid.clientHeight - 18;      // 扣掉上下 padding
  const h    = Math.floor((H - gap * (rows - 1)) / rows);

  el.grid.style.gridAutoRows = Math.max(74, Math.min(136, h)) + 'px';
}

function paintActive(){
  document.querySelectorAll('.cell').forEach(n =>
    n.classList.toggle('active', n.dataset.sid === currentId && playing));

  const st = currentId ? byId[currentId] : null;
  document.querySelectorAll('.tab').forEach(n =>
    n.classList.toggle('playing', !!st && playing && st.groupId === n.dataset.gid));
}

function paintBar(){
  const st = currentId ? byId[currentId] : null;

  if(!st){
    el.nowName.textContent = '睡前收音机';
    el.nowName.classList.add('idle');
    el.nowSub.textContent = '点一个台开始';
  }else{
    el.nowName.textContent = st.name;
    el.nowName.classList.remove('idle');
    el.nowSub.textContent = playing ? (st.sub || st.groupName) : '已暂停';
    el.nowSub.classList.toggle('fading', false);
  }

  el.icoPlay.style.display  = playing ? 'none' : '';
  el.icoPause.style.display = playing ? '' : 'none';
  paintActive();
  updateMediaSession();
}

/* ==================================================================
   电平：只由渐弱系数决定
   ================================================================== */
function applyVolume(){
  const v = Math.max(0, Math.min(1, fadeMul));
  if(audio) audio.volume = v;
}

/* ==================================================================
   播放
   ================================================================== */
let isSwitching = false;

function ensureAudio(){
  if(audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.setAttribute('playsinline', '');
  audio.volume = 1;

  audio.addEventListener('playing', () => {
    playing = true;
    lastProgressAt = Date.now();
    lastCurrentTime = 0;
    paintBar();
  });

  audio.addEventListener('pause', () => {
    // pause 事件是异步派发的，切台时会上晚到，不能无脑改状态
    if(isSwitching) return;
    playing = false;
    paintBar();
  });

  audio.addEventListener('error', () => {
    if(currentId && playing) scheduleReconnect();
  });

  audio.addEventListener('timeupdate', () => {
    if(audio.currentTime !== lastCurrentTime){
      lastCurrentTime = audio.currentTime;
      lastProgressAt = Date.now();
    }
  });

  return audio;
}

function srcOf(st){
  return st.url + (st.url.includes('?') ? '&' : '?') + 'r=' + Date.now();
}

function playStation(st){
  const a = ensureAudio();

  isSwitching = true;
  a.pause();
  a.src = srcOf(st);
  a.load();

  const p = a.play();
  if(p && p.catch) p.catch(err => {
    playing = false;
    paintBar();
    if(err && err.name !== 'NotAllowedError') scheduleReconnect();
  });

  setTimeout(() => { isSwitching = false; }, 400);
}

function scheduleReconnect(){
  if(reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    const st = currentId ? byId[currentId] : null;
    if(!st || !playing) return;
    const a = ensureAudio();
    a.src = srcOf(st);
    a.load();
    const p = a.play();
    if(p && p.catch) p.catch(() => {});
  }, RECONNECT_MS);
}

/* 看门狗：播放中但进度长时间不动 → 重连 */
setInterval(() => {
  if(!playing || !audio || !currentId) return;
  if(Date.now() - lastProgressAt > 20000){
    lastProgressAt = Date.now();
    scheduleReconnect();
  }
}, 5000);

/* ==================================================================
   控制
   ================================================================== */
function onPick(sid){
  const st = byId[sid];
  if(!st) return;

  // 点当前正在播的台 → 暂停
  if(sid === currentId && playing){ pause(); return; }

  currentId = sid;
  saveStore();
  playStation(st);
  paintBar();
}

function play(){
  const st = currentId ? byId[currentId] : null;
  if(!st){
    const g = groups.find(x => x.id === activeGroup) || groups[0];
    if(g && g.stations.length) onPick(g.id + '/' + g.stations[0].name);
    return;
  }
  if(audio && audio.src){
    const p = audio.play();
    if(p && p.catch) p.catch(() => playStation(st));
  }else{
    playStation(st);
  }
}

function pause(){
  if(audio) audio.pause();
  playing = false;
  paintBar();
}

function toggle(){
  playing ? pause() : play();
}

/* ==================================================================
   睡眠定时
   ================================================================== */
function setTimer(min){
  sleepMin = min;
  if(!min){
    sleepAt = 0;
    fadeMul = 1;
  }else{
    sleepAt = Date.now() + min * 60000;
    fadeMul = 1;
  }
  applyVolume();
  saveStore();
  paintTimer();
}

function paintTimer(){
  el.btnTimer.classList.toggle('on', !!sleepAt);
  el.timerLabel.textContent = sleepAt ? fmtLeft((sleepAt - Date.now()) / 1000) : '定时';
}

setInterval(() => {
  if(!sleepAt) return;

  const left = (sleepAt - Date.now()) / 1000;

  if(left <= 0){
    fadeMul = 0;
    applyVolume();
    sleepAt = 0;
    sleepMin = 0;
    playing = false;
    if(audio) audio.pause();
    saveStore();
    paintTimer();
    paintBar();
    return;
  }

  if(left <= FADE_SECONDS){
    // 前期降得慢、最后快速消失，听感更自然
    fadeMul = Math.pow(left / FADE_SECONDS, 0.6);
    applyVolume();
    const st = currentId ? byId[currentId] : null;
    if(st){
      el.nowSub.textContent = '渐弱 · ' + Math.ceil(left) + 's';
      el.nowSub.classList.add('fading');
    }
  }else if(currentId && playing){
    const st = byId[currentId];
    el.nowSub.textContent = st.sub || st.groupName;
    el.nowSub.classList.remove('fading');
  }

  paintTimer();
}, 1000);

function openSheet(){
  el.sheetOpts.innerHTML = '';

  TIMER_OPTS.forEach(m => {
    const b = document.createElement('button');
    b.textContent = `${m} 分钟`;
    if(sleepAt && Math.abs((sleepAt - Date.now())/60000 - m) < 1) b.classList.add('sel');
    b.addEventListener('click', () => { setTimer(m); closeSheet(); });
    el.sheetOpts.appendChild(b);
  });

  if(sleepAt){
    const off = document.createElement('button');
    off.className = 'wide';
    off.textContent = '关闭定时';
    off.addEventListener('click', () => { setTimer(0); closeSheet(); });
    el.sheetOpts.appendChild(off);
  }

  el.sheet.hidden = false;
}
function closeSheet(){ el.sheet.hidden = true; }

/* ==================================================================
   Media Session（锁屏 / 蓝牙 / CarPlay）
   ================================================================== */
function updateMediaSession(){
  if(!('mediaSession' in navigator)) return;
  const st = currentId ? byId[currentId] : null;
  if(!st) return;

  try{
    navigator.mediaSession.metadata = new MediaMetadata({
      title: st.name,
      artist: st.sub || st.groupName,
      album: '睡前收音机',
    });
    navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }catch(e){}

  const set = (k, fn) => { try{ navigator.mediaSession.setActionHandler(k, fn); }catch(e){} };
  set('play', () => play());
  set('pause', () => pause());
  set('stop', () => pause());
}

/* ==================================================================
   启动
   ================================================================== */
async function boot(){
  let data;
  try{
    const r = await fetch('./stations.json', { cache: 'no-cache' });
    data = await r.json();
  }catch(e){
    el.nowSub.textContent = '台站表加载失败';
    return;
  }

  groups = data.groups || [];
  byId = {};
  groups.forEach(g => {
    g.stations.forEach(st => {
      const item = { ...st, sid: g.id + '/' + st.name, groupId: g.id, groupName: g.name };
      byId[item.sid] = item;
    });
  });

  buildTabs();

  // 恢复上次状态
  const s = loadStore();
  if(s.currentId && byId[s.currentId]) currentId = s.currentId;
  if(typeof s.sleepMin === 'number' && s.sleepMin > 0){
    sleepMin = s.sleepMin;
    sleepAt = Date.now() + sleepMin * 60000;
  }

  // 默认落在正在播的台所在分组，否则第一个
  const startGroup = (currentId && byId[currentId].groupId) || s.group || (groups[0] && groups[0].id);
  activeGroup = null;
  selectGroup(startGroup, true);

  // 跨过 900px 断点时重排（手机 ⇄ 平板）
  let wide = isWide();
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if(isWide() !== wide){ wide = isWide(); render(); } else fitRows();
    }, 180);
  });

  applyVolume();
  paintBar();
  paintTimer();

  el.btnPlay.addEventListener('click', toggle);
  el.btnTimer.addEventListener('click', openSheet);
  el.sheetCancel.addEventListener('click', closeSheet);
  el.sheet.addEventListener('click', e => { if(e.target === el.sheet) closeSheet(); });

  document.addEventListener('keydown', e => {
    if(e.code === 'Space'){ e.preventDefault(); toggle(); }
  });

  document.addEventListener('visibilitychange', () => {
    if(!document.hidden && sleepAt) paintTimer();
  });

  // PWA 外壳离线可用（不缓存音频流）
  // 注意：boot() 是 async，走到这里时 load 可能已经触发过，
  // 所以不能无条件 addEventListener('load')，要按 readyState 分支。
  if('serviceWorker' in navigator){
    const reg = () => navigator.serviceWorker.register('./sw.js').catch(() => {});
    if(document.readyState === 'complete') reg();
    else window.addEventListener('load', reg);
  }
}

// 供自动化验收读取内部状态（无副作用）
window.__dbg = () => ({
  playing,
  currentId,
  activeGroup,
  tabs: Array.from(document.querySelectorAll('.tab')).map(n => n.textContent),
  cells: document.querySelectorAll('.cell').length,
  wide: isWide(),
  hasAudio: !!audio,
  audioSrc: audio ? String(audio.src).slice(0, 90) : null,
  audioPaused: audio ? audio.paused : null,
  audioTime: audio ? Number(audio.currentTime.toFixed(2)) : null,
  audioReady: audio ? audio.readyState : null,
  audioVolume: audio ? Number(audio.volume.toFixed(2)) : null,
  fadeMul: Number(fadeMul.toFixed(2)),
  sleepLeft: sleepAt ? Math.round((sleepAt - Date.now())/1000) : 0,
  activeCells: document.querySelectorAll('.cell.active').length,
});

boot();
})();
