from __future__ import annotations

import copy
import json
import re
import shutil
import urllib.request
from pathlib import Path

from PIL import Image


PROJECT_ROOT = Path(__file__).resolve().parents[2]
REPLICA_ROOT = PROJECT_ROOT / "replica"
SOURCE_ROOT = PROJECT_ROOT / "ds2maplocation"

MAPDATA_ROOT = REPLICA_ROOT / "mapdata"
MAPS_ROOT = MAPDATA_ROOT / "maps"
TILES_ROOT = MAPDATA_ROOT / "tiles"
ICO_ROOT = REPLICA_ROOT / "ico"

PROFILE_BY_DTLX = {
    1: {"slug": "mexico", "name": "墨西哥"},
    2: {"slug": "australia", "name": "澳大利亚"},
}

ICON_ID_RE = re.compile(r"/icons/(\d+)\.png$", re.IGNORECASE)

ICON_FILE_NAME_BY_SECTION = {
    "结点城": "knot-city.png",
    "聚居地": "settlement.png",
    "科考站": "research-station.png",
    "米尔人营地": "mule-camp.png",
    "BT区": "bt-area.png",
    "板块门": "plate-gate.png",
    "其他地点": "other-location.png",
    "主要订单": "main-order.png",
    "装饰品": "accessory.png",
    "危险": "hazard.png",
    "彩蛋": "easter-egg.png",
    "杂项": "misc.png",
    "米尔人寄存桶": "mule-postbox.png",
    "矿场": "mine.png",
    "次要订单": "side-order.png",
    "乐曲": "music.png",
    "自动铺路机": "autopaver.png",
    "铺轨机": "track-laying-machine.png",
}


def parse_points_file(points_path: Path) -> list[dict]:
    raw = points_path.read_text(encoding="utf-8")
    raw = re.sub(r"^\s*var\s+points\s*=\s*", "", raw, count=1)
    raw = raw.strip()
    if raw.endswith(";"):
        raw = raw[:-1]
    return json.loads(raw)


def find_profiles() -> dict[int, dict]:
    found: dict[int, dict] = {}
    for map_dir in sorted(SOURCE_ROOT.iterdir()):
        if not map_dir.is_dir():
            continue

        html_files = sorted(map_dir.glob("*.html"))
        if not html_files:
            continue

        html_path = html_files[0]
        html = html_path.read_text(encoding="utf-8", errors="ignore")

        dtlx_match = re.search(r"var\s+dtlx\s*=\s*(\d+)\s*;", html)
        common_name_match = re.search(r"var\s+common_name\s*=\s*'([^']+)';", html)
        map_size_match = re.search(r"var\s+map_size\s*=\s*(\d+)\s*;", html)
        map_max_zoom_match = re.search(r"var\s+map_max_zoom\s*=\s*(\d+)\s*;", html)

        if not dtlx_match:
            continue

        dtlx = int(dtlx_match.group(1))
        if dtlx not in PROFILE_BY_DTLX:
            continue

        files_dir = next((d for d in sorted(map_dir.iterdir()) if d.is_dir() and d.name.endswith("_files")), None)
        if files_dir is None:
            continue

        points_path = next(iter(sorted(files_dir.glob("points.js*"))), None)
        if points_path is None:
            continue

        found[dtlx] = {
            "dtlx": dtlx,
            "mapDir": map_dir,
            "commonName": common_name_match.group(1) if common_name_match else "",
            "mapSize": int(map_size_match.group(1)) if map_size_match else 16384,
            "mapMaxZoom": int(map_max_zoom_match.group(1)) if map_max_zoom_match else 6,
            "pointsPath": points_path,
        }

    return found


def fetch_icon_bytes(url: str, timeout: int = 10) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


def resolve_icon_filename(section_title: str) -> str:
    try:
        return ICON_FILE_NAME_BY_SECTION[section_title]
    except KeyError as exc:
        raise RuntimeError(f"Missing semantic icon filename mapping for section: {section_title}") from exc


def ensure_icon(icon_url: str, profile: dict, filename: str) -> str:
    match = ICON_ID_RE.search(icon_url)
    if not match:
        raise RuntimeError(f"Unsupported icon URL format: {icon_url}")

    icon_id = match.group(1)
    dst = ICO_ROOT / filename
    dst.parent.mkdir(parents=True, exist_ok=True)

    local_candidate = profile["mapDir"] / "icons" / f"{icon_id}.png"
    icon_bytes = local_candidate.read_bytes() if local_candidate.exists() else fetch_icon_bytes(icon_url)

    if dst.exists():
        if dst.read_bytes() != icon_bytes:
            raise RuntimeError(f"Icon filename collision with different content: {filename}")
    else:
        dst.write_bytes(icon_bytes)

    return dst.relative_to(REPLICA_ROOT).as_posix()


def localize_points(points: list[dict], profile: dict) -> list[dict]:
    localized = copy.deepcopy(points)
    for group in localized:
        for section in group.get("data", []):
            icon_url = section.get("icon", "").strip()
            if icon_url:
                section["icon"] = ensure_icon(icon_url, profile, resolve_icon_filename(section.get("title", "").strip()))
    return localized


def copy_max_zoom_tiles(profile: dict, slug: str) -> Path:
    source_zoom_dir = profile["mapDir"] / "temp" / "tiles" / str(profile["mapMaxZoom"])
    if not source_zoom_dir.exists():
        raise RuntimeError(f"Missing source tiles: {source_zoom_dir}")

    target_map_root = TILES_ROOT / slug
    if target_map_root.exists():
        shutil.rmtree(target_map_root)

    target_zoom_dir = target_map_root / str(profile["mapMaxZoom"])
    target_zoom_dir.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source_zoom_dir, target_zoom_dir)
    return target_map_root


def resize_filter():
    return getattr(Image, "Resampling", Image).LANCZOS


def generate_zoom_pyramid(map_tile_root: Path, max_zoom: int) -> None:
    lanczos = resize_filter()
    for zoom in range(max_zoom - 1, -1, -1):
        src_root = map_tile_root / str(zoom + 1)
        dst_root = map_tile_root / str(zoom)
        dst_root.mkdir(parents=True, exist_ok=True)

        tiles_per_axis = 2**zoom
        for x in range(tiles_per_axis):
            x_dir = dst_root / str(x)
            x_dir.mkdir(parents=True, exist_ok=True)
            for y in range(tiles_per_axis):
                canvas = Image.new("RGB", (512, 512), (0, 0, 0))
                has_child = False
                for dx in (0, 1):
                    for dy in (0, 1):
                        child = src_root / str(x * 2 + dx) / f"{y * 2 + dy}.png"
                        if not child.exists():
                            continue
                        with Image.open(child) as child_img:
                            canvas.paste(child_img.convert("RGB"), (dx * 256, dy * 256))
                        has_child = True

                if not has_child:
                    continue

                tile = canvas.resize((256, 256), lanczos)
                tile.save(x_dir / f"{y}.png")


def main() -> None:
    if not SOURCE_ROOT.exists():
        raise RuntimeError(
            "Source folder not found: ds2maplocation. "
            "This extractor is only needed when regenerating local assets."
        )

    MAPS_ROOT.mkdir(parents=True, exist_ok=True)
    TILES_ROOT.mkdir(parents=True, exist_ok=True)
    if ICO_ROOT.exists():
        shutil.rmtree(ICO_ROOT)
    ICO_ROOT.mkdir(parents=True, exist_ok=True)

    found = find_profiles()
    missing = sorted(set(PROFILE_BY_DTLX) - set(found))
    if missing:
        missing_names = ", ".join(PROFILE_BY_DTLX[item]["name"] for item in missing)
        raise RuntimeError(f"Missing map profile data: {missing_names}")

    all_profiles: dict[str, dict] = {}
    manifest_maps: list[dict] = []

    for dtlx, profile in sorted(found.items()):
        meta = PROFILE_BY_DTLX[dtlx]
        slug = meta["slug"]
        points = parse_points_file(profile["pointsPath"])
        localized_points = localize_points(points, profile)

        map_tile_root = copy_max_zoom_tiles(profile, slug)
        generate_zoom_pyramid(map_tile_root, profile["mapMaxZoom"])

        tile_template = f"mapdata/tiles/{slug}" + "/{z}/{x}/{y}.png"
        payload = {
            "id": slug,
            "name": meta["name"],
            "dtlx": dtlx,
            "commonName": profile["commonName"],
            "tileTemplate": tile_template,
            "mapSize": profile["mapSize"],
            "mapMaxZoom": profile["mapMaxZoom"],
            "points": localized_points,
        }

        map_path = MAPS_ROOT / f"{slug}.json"
        map_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Wrote {map_path}")

        all_profiles[slug] = payload
        manifest_maps.append(
            {
                "id": payload["id"],
                "name": payload["name"],
                "dtlx": payload["dtlx"],
                "commonName": payload["commonName"],
                "tileTemplate": payload["tileTemplate"],
                "mapSize": payload["mapSize"],
                "mapMaxZoom": payload["mapMaxZoom"],
                "dataFile": f"maps/{slug}.json",
            }
        )
        print(f"Prepared local tiles and icons for {slug}")

    manifest_path = MAPDATA_ROOT / "manifest.json"
    manifest = {
        "version": 1,
        "maps": manifest_maps,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {manifest_path}")

    profiles_js_path = MAPDATA_ROOT / "profiles.js"
    profiles_js = "window.DS2_MAP_PROFILES = " + json.dumps(all_profiles, ensure_ascii=False, indent=2) + ";\n"
    profiles_js_path.write_text(profiles_js, encoding="utf-8")
    print(f"Wrote {profiles_js_path}")


if __name__ == "__main__":
    main()
