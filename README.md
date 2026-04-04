# DS2 地图复刻（离线版）

这个目录复刻并整合了两张地图：

- `swgq2`（墨西哥）
- `swgq2_2`（澳大利亚）

## 运行结构

运行时只需要 `replica` 目录，不依赖外网资源：

```text
replica/
  index.html
  assets/
    app.css
    app.js
  vendor/
    leaflet/
      leaflet.css
      leaflet.js
      images/
  ico/
    accessory.png
    autopaver.png
    ...
    track-laying-machine.png
  mapdata/
    manifest.json
    profiles.js
    maps/
      mexico.json
      australia.json
    tiles/
      mexico/0..6/{x}/{y}.png
      australia/0..6/{x}/{y}.png
```

## 本地启动

```bash
python -m http.server 8080
```

打开：

`http://127.0.0.1:8080/replica/`

可选参数：

- `?map=mexico` 或 `?map=swgq2`
- `?map=australia` 或 `?map=swgq2_2`

## 重新生成离线资源（开发时）

仅在你需要重新抽取数据时才需要 `ds2maplocation` 目录。

```bash
python replica/scripts/extract_points.py
```

该脚本会重建：

- `replica/mapdata/*`
- `replica/ico/*`

图标资源统一集中在单层 `ico/` 目录，采用语义化英文短横线命名，例如 `knot-city.png`、`main-order.png`、`autopaver.png`。

生成完成后，发布时可以不带 `ds2maplocation`。
