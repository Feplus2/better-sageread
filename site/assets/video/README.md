# 演示视频目录

以后录好演示视频放到这里（建议 MP4/WebM，单条控制在 5MB 内），
然后在 `index.html` 对应产品区加：

```html
<video class="demo-video" src="assets/video/xxx.mp4"
       muted loop playsinline preload="none"
       poster="assets/img/shot-paper-figures.webp"></video>
```

并在 `assets/css/style.css` 里给 `.demo-video` 加样式（width:100%; border:1px solid var(--line-strong); border-radius:6px）。
