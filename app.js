/* 睡前收音机 · 单文件播放内核
 * 电台：mp3 直流，原生 <audio>，无 hls.js、无 CORS 依赖
 * 白噪音：Web Audio 本地合成，永不失效
 */
(() => {
'use strict';

const STORE_KEY   = 'sleepradio.v1';
const FADE_SECONDS = 60;          // 最后 60 秒渐弱
const RECONNECT_MS = 3000;
const TIMER_OPTS   = [0, 15, 30, 45, 60, 90, 120];

/* ---------------- 状态 ---------------- */
let groups = [];
let flat   = [];                  // [{sid, name, sub, url, noise, groupName}]
let byId   = {};

let currentId = null;
let playing   = false;
let baseVolume = 0.7;
let fadeMul    = 1;
let sleepAt    = 0;               // 目标停止时间戳；0 = 未设定
let sleepMin   = 0;
let reconnectTimer = null;
let lastProgressAt = 0;
let lastCurrentTime = 0;

/* ---------------- 音频对象 ---------------- */
let audio = null;
let actx = null, noiseGain = null, noiseSrc = null, noiseChain = [], analyser = null;

/* ---------------- DOM ---------------- */
const $ = s => document.querySelector(s);
const el = {
  list: $('#list'), nowName: $('#nowName'), nowSub: $('#nowSub'),
  statusText: $('#statusText'), liveDot: $('#liveDot'),
  btnPlay: $('#btnPlay'), icoPlay: $('#icoPlay'), icoPause: $('#icoPause'),
  volume: $('#volume'), btnTimer: $('#btnTimer'), timerLabel: $('#timerLabel'),
  fadeHint: $('#fadeHint'), sheet: $('#sheet'), sheetOpts: $('#sheetOpts'),
  sheetCancel: $('#sheetCancel'),
};

/* ---------------- 存储 ---------------- */
function loadStore(){
  try{ return JSON.parse(localStorage.getItem(STORE_KEY) || '{}'); }
  catch(e){ return {}; }
}
function saveStore(){
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify({
      currentId, volume: baseVolume, sleepMin
    }));
  }catch(e){}
}

/* ---------------- 格式化 ---------------- */
function fmtLeft(sec){
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2,'0')}` : `${s}s`;
}

/* ==================================================================
   渲染
   ================================================================== */
function buildList(){
  el.list.innerHTML = '';
  groups.forEach(g => {
    const wrap = document.createElement('section');
    wrap.className = 'grp';

    const h = document.createElement('div');
    h.className = 'grp-h';
    h.textContent = g.name;
    wrap.appendChild(h);

    g.stations.forEach(st => {
      const sid = g.id + '/' + st.name;
      const b = document.createElement('button');
      b.className = 'item';
      b.dataset.sid = sid;
      b.innerHTML =
        `<span class="nm">${esc(st.name)}<span class="sb">${esc(st.sub || '')}</span></span>` +
        `<span class="eq"><i></i><i></i><i></i></span>`;
      b.addEventListener('click', () => onPick(sid));
      wrap.appendChild(b);
    });

    el.list.appendChild(wrap);
  });
}

function esc(s){
  return String(s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function paintActive(){
  document.querySelectorAll('.item').forEach(n => {
    n.classList.toggle('active', n.dataset.sid === currentId && playing);
  });
}

function paintDeck(){
  const st = currentId ? byId[currentId] : null;

  if(!st){
    el.nowName.textContent = '睡前收音机';
    el.nowName.classList.add('idle');
    el.nowSub.textContent  = '选一个台，或者直接放白噪音';
    el.statusText.textContent = '未播放';
    el.liveDot.classList.remove('on');
  }else{
    el.nowName.textContent = st.name;
    el.nowName.classList.remove('idle');
    el.nowSub.textContent  = st.sub || st.groupName;
    if(playing){
      el.statusText.textContent = st.noise ? '生成中' : '正在播放';
      el.liveDot.classList.add('on');
    }else{
      el.statusText.textContent = '已暂停';
      el.liveDot.classList.remove('on');
    }
  }

  el.icoPlay.style.display  = playing ? 'none' : '';
  el.icoPause.style.display = playing ? '' : 'none';
  el.btnPlay.classList.toggle('on', playing);
  paintActive();
  updateMediaSession();
}

/* ==================================================================
   音量
   ================================================================== */
function applyVolume(){
  const v = Math.max(0, Math.min(1, baseVolume * fadeMul));
  if(audio) audio.volume = v;
  if(noiseGain && actx) noiseGain.gain.setTargetAtTime(v, actx.currentTime, 0.06);
}

/* ==================================================================
   电台播放
   ================================================================== */
function ensureAudio(){
  if(audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.setAttribute('playsinline', '');
  audio.crossOrigin = null;
  audio.addEventListener('playing', () => {
    playing = true; lastProgressAt = Date.now(); lastCurrentTime = 0;
    paintDeck();
  });
  audio.addEventListener('pause', () => {
    // pause 事件是异步派发的，切台 / 切白噪音时会晚到，不能无脑改状态
    if(isSwitching || noiseSrc) return;
    playing = false;
    paintDeck();
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

let isSwitching = false;

function playStation(st){
  const a = ensureAudio();
  stopNoise();

  isSwitching = true;
  a.pause();
  a.src = st.url + (st.url.includes('?') ? '&' : '?') + 'r=' + Date.now();
  a.load();

  const p = a.play();
  if(p && p.catch) p.catch(err => {
    // 自动播放被拦或流暂时不可用
    playing = false;
    paintDeck();
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
    a.src = st.url + (st.url.includes('?') ? '&' : '?') + 'r=' + Date.now();
    a.load();
    const p = a.play();
    if(p && p.catch) p.catch(() => {});
  }, RECONNECT_MS);
}

/* 看门狗：播放中但进度长时间不动 → 重连 */
setInterval(() => {
  if(!playing || !audio || !currentId) return;
  const st = byId[currentId];
  if(!st || st.noise) return;
  if(Date.now() - lastProgressAt > 20000){
    lastProgressAt = Date.now();
    scheduleReconnect();
  }
}, 5000);

/* ==================================================================
   白噪音合成
   ================================================================== */
function noiseBuffer(kind, seconds){
  const sr = actx.sampleRate;
  const len = Math.floor(sr * seconds);
  const buf = actx.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);

  if(kind === 'brown'){
    let last = 0;
    for(let i = 0; i < len; i++){
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
  }else if(kind === 'pink'){
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for(let i = 0; i < len; i++){
      const w = Math.random() * 2 - 1;
      b0 = 0.99886*b0 + w*0.0555179;
      b1 = 0.99332*b1 + w*0.0750759;
      b2 = 0.96900*b2 + w*0.1538520;
      b3 = 0.86650*b3 + w*0.3104856;
      b4 = 0.55000*b4 + w*0.5329522;
      b5 = -0.7616*b5 - w*0.0168980;
      d[i] = (b0+b1+b2+b3+b4+b5+b6 + w*0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  }else{
    // rain / fan 都用白噪做基底，靠滤波器塑形
    for(let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  // 首尾交叉淡化，避免循环接缝的「咔哒」
  const fade = Math.floor(sr * 0.05);
  for(let i = 0; i < fade; i++){
    const k = i / fade;
    d[i] *= k;
    d[len - 1 - i] *= k;
  }
  return buf;
}

function ensureCtx(){
  if(actx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  actx = new AC();
  noiseGain = actx.createGain();
  noiseGain.gain.value = 0;
  noiseGain.connect(actx.destination);

  // 旁挂分析节点，用来验证「确实有信号输出」
  analyser = actx.createAnalyser();
  analyser.fftSize = 2048;
  noiseGain.connect(analyser);
}

function playNoise(st){
  ensureCtx();
  if(actx.state === 'suspended') actx.resume();
  stopNoise();
  if(audio) audio.pause();

  const kind = st.noise;
  const src = actx.createBufferSource();
  src.buffer = noiseBuffer(kind === 'rain' || kind === 'fan' ? 'white' : kind, 12);
  src.loop = true;

  const chain = [src];

  if(kind === 'rain'){
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 0.5;
    const hp = actx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 420;
    chain.push(hp, lp);
  }else if(kind === 'fan'){
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 850; lp.Q.value = 0.7;
    chain.push(lp);
  }else if(kind === 'brown'){
    const lp = actx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 5200;
    chain.push(lp);
  }else if(kind === 'pink'){
    const hp = actx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 90;
    chain.push(hp);
  }

  // 串联
  for(let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i+1]);
  chain[chain.length - 1].connect(noiseGain);

  // 雨势/风扇的缓慢起伏
  if(kind === 'rain' || kind === 'fan'){
    const lfo = actx.createOscillator();
    const lfoGain = actx.createGain();
    lfo.frequency.value = kind === 'rain' ? 0.07 : 0.045;
    lfoGain.gain.value = kind === 'rain' ? 0.055 : 0.03;
    lfo.connect(lfoGain);
    lfoGain.connect(noiseGain.gain);
    lfo.start();
    noiseChain.push(lfo);
  }

  src.start();
  noiseSrc = src;
  noiseChain = noiseChain.concat(chain);

  noiseGain.gain.cancelScheduledValues(actx.currentTime);
  noiseGain.gain.setValueAtTime(0, actx.currentTime);
  noiseGain.gain.setTargetAtTime(Math.max(0.001, baseVolume * fadeMul), actx.currentTime, 0.25);

  playing = true;
  paintDeck();
}

function stopNoise(){
  if(noiseSrc){
    try{ noiseSrc.stop(); }catch(e){}
    try{ noiseSrc.disconnect(); }catch(e){}
    noiseSrc = null;
  }
  noiseChain.forEach(n => { try{ n.disconnect(); }catch(e){} });
  noiseChain = [];
  if(noiseGain && actx) noiseGain.gain.setValueAtTime(0, actx.currentTime);
}

/* ==================================================================
   统一控制
   ================================================================== */
function onPick(sid){
  const st = byId[sid];
  if(!st) return;

  // 点当前正在播的台 → 暂停
  if(sid === currentId && playing){ pause(); return; }

  currentId = sid;
  saveStore();

  if(st.noise) playNoise(st);
  else playStation(st);

  paintDeck();
}

function play(){
  const st = currentId ? byId[currentId] : null;
  if(!st){
    // 没有选中，从第一个开始
    if(flat.length) onPick(flat[0].sid);
    return;
  }
  if(st.noise) playNoise(st);
  else{
    if(audio && audio.src){
      const p = audio.play();
      if(p && p.catch) p.catch(() => playStation(st));
    }else{
      playStation(st);
    }
  }
}

function pause(){
  if(audio) audio.pause();
  if(actx && noiseGain) noiseGain.gain.setTargetAtTime(0, actx.currentTime, 0.08);
  playing = false;
  paintDeck();
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
    applyVolume();
  }else{
    sleepAt = Date.now() + min * 60000;
    fadeMul = 1;
    applyVolume();
  }
  saveStore();
  paintTimer();
}

function paintTimer(){
  el.btnTimer.classList.toggle('on', !!sleepAt);
  if(!sleepAt){
    el.timerLabel.textContent = '睡眠定时';
    el.fadeHint.textContent = '';
    return;
  }
  const left = (sleepAt - Date.now()) / 1000;
  el.timerLabel.textContent = fmtLeft(left);
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
    stopNoise();
    saveStore();
    paintTimer();
    paintDeck();
    return;
  }

  if(left <= FADE_SECONDS){
    // 前期降得慢、最后快速消失，听感更自然
    fadeMul = Math.pow(left / FADE_SECONDS, 0.6);
    applyVolume();
    el.fadeHint.textContent = '渐弱中 · ' + Math.ceil(left) + 's';
  }else{
    el.fadeHint.textContent = '';
  }

  paintTimer();
}, 1000);

/* 定时器弹层 */
function openSheet(){
  el.sheetOpts.innerHTML = '';

  TIMER_OPTS.filter(m => m > 0).forEach(m => {
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
  flat = [];
  groups.forEach(g => {
    g.stations.forEach(st => {
      const item = { ...st, sid: g.id + '/' + st.name, groupName: g.name };
      flat.push(item);
      byId[item.sid] = item;
    });
  });

  buildList();

  // 恢复上次状态
  const s = loadStore();
  if(typeof s.volume === 'number'){ baseVolume = s.volume; }
  el.volume.value = Math.round(baseVolume * 100);
  if(s.currentId && byId[s.currentId]) currentId = s.currentId;
  if(typeof s.sleepMin === 'number' && s.sleepMin > 0){
    sleepMin = s.sleepMin;
    sleepAt = Date.now() + sleepMin * 60000;
  }

  applyVolume();
  paintDeck();
  paintTimer();
  if(sleepAt) paintTimer();

  // 事件
  el.btnPlay.addEventListener('click', toggle);

  el.volume.addEventListener('input', e => {
    baseVolume = Number(e.target.value) / 100;
    fadeMul = 1;
    applyVolume();
    saveStore();
  });

  el.btnTimer.addEventListener('click', openSheet);
  el.sheetCancel.addEventListener('click', closeSheet);
  el.sheet.addEventListener('click', e => { if(e.target === el.sheet) closeSheet(); });

  document.addEventListener('keydown', e => {
    if(e.code === 'Space'){ e.preventDefault(); toggle(); }
  });

  // 页面重新可见时校准（手机切后台可能暂停）
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
  hasAudio: !!audio,
  audioSrc: audio ? String(audio.src).slice(0, 90) : null,
  audioPaused: audio ? audio.paused : null,
  audioTime: audio ? Number(audio.currentTime.toFixed(2)) : null,
  audioReady: audio ? audio.readyState : null,
  hasNoise: !!noiseSrc,
  ctxState: actx ? actx.state : null,
  gain: (noiseGain && actx) ? Number(noiseGain.gain.value.toFixed(3)) : null,
  volume: Number(baseVolume.toFixed(2)),
  fadeMul: Number(fadeMul.toFixed(2)),
  sleepLeft: sleepAt ? Math.round((sleepAt - Date.now())/1000) : 0,
  activeItems: document.querySelectorAll('.item.active').length,
  rms: (() => {
    if(!analyser) return null;
    const buf = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for(let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Number(Math.sqrt(sum / buf.length).toFixed(5));
  })(),
});

boot();
})();
