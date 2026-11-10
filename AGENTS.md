# AGENTS.md · 睡前收音机

给接手的 Agent 看的协作契约。读完再动手。

## 这是什么

一个纯静态 PWA，48 个中文电台，点一下就放。托管在 GitHub Pages，没有后端、没有构建步骤。

## 目录

```
index.html      结构（分组标签 + 宫格 + 底部播放条）
style.css       样式（手机 tab 宫格 / ≥900px 四组平铺）
app.js          全部逻辑
stations.json   台单（改台只改这里）
sw.js           Service Worker
manifest.json   PWA 清单
tools/check-streams.py  台单探活
```

## 改台单

只改 `stations.json`。它是**两层的分组结构**，不是平铺数组：

```json
{
  "groups": [
    { "id": "news", "name": "新闻·财经",
      "stations": [ { "name": "中国之声", "sub": "CNR · 新闻", "url": "https://.../64k.mp3" } ] },
    { "id": "music", "name": "音乐", "stations": [ ... ] }
  ]
}
```

- `groups[].id` 是内部标识，`groups[].name` 是分组标签上显示的字（手机 tab / 平板小标题）
- 每台三个字段：
  - `name` 是宫格里的主标题，**控制在 5 个字内**，否则手机上会折行
  - `sub` 是灰色小字，写城市或类型
  - `url` 必须是 **mp3 直流**（`/64k.mp3` 这种）。m3u8 不要加，这个项目刻意不引 hls.js
- 加新分组时，`app.js` 的 `groups` 数组和手机 tab 会跟着自动渲染，不用改 JS

加完台跑一次探活确认能连上：

```bash
python3 tools/check-streams.py
```

## 改外壳后必须做的事

**把 `sw.js` 里的 `CACHE` 版本号加一**（当前 `sleepradio-v3`）。

外壳走缓存优先，不 bump 的话已安装的客户端永远拿不到新版本——这个坑踩过好几次。

## 红线

- 不引任何第三方库、不加构建步骤、不加后端
- 不做应用内音量调节（主人明确要求走系统音量）
- 不加白噪音（已整体删除，别加回来）
- 不改 `sw.js` 的缓存策略（外壳缓存优先是刻意的，为了离线可用）

## 布局约定

- 手机（<900px）：分组标签 + 宫格，一屏看完一组，行高由 `fitRows()` 按可用高度均分
- 平板（≥900px）：隐藏标签，四组纵向平铺，一屏看全

改布局时两个断点都要过一遍，别只顾手机。
