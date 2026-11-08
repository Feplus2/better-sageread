import json
import os
from pathlib import Path
from PIL import Image

root = Path(os.environ.get("PIXEL_OUT", ".superpowers/sdd/devil-dinosaur-aquaman-riri-williams/stream-reveal-pixels"))
scene_file = root / "pixel-scenes.json"
if not scene_file.exists():
    raise SystemExit(f"缺少像素场景：{scene_file}")
with scene_file.open("r", encoding="utf-8") as handle:
    data = json.load(handle)


def accent_pixels(path: Path) -> tuple[int, int]:
    """Count near-accent pixels, not yellow emoji or colored subpixel antialiasing."""
    with Image.open(path).convert("RGB") as image:
        width, height = image.size
        count = 0
        for red, green, blue in image.get_flattened_data():
            if red >= 200 and green <= 100 and blue <= 100 and red - green >= 90 and red - blue >= 90 and abs(green - blue) <= 32:
                count += 1
        return count, width * height


results = []
for label in ("first", "middle", "last"):
    for kind in ("wet", "dry"):
        name = f"{kind}-{label}"
        matching = [scene for scene in data["scenes"] if scene["kind"] == kind and scene["label"] == label]
        if not matching:
            results.append({"name": name, "pass": False, "error": "没有对应截图"})
            continue
        scene = matching[0]
        count, total = accent_pixels(root / scene["file"])
        threshold = max(8, int(total * 0.002))
        passed = count >= threshold and scene.get("covered") is True if kind == "wet" else count < threshold and scene.get("covered") is False
        results.append({
            "name": name,
            "pass": passed,
            "accentPixels": count,
            "totalPixels": total,
            "threshold": threshold,
            "highlightCovered": scene.get("covered"),
            "clip": scene["clip"],
        })

passed = all(result["pass"] for result in results)
report = {"pass": passed, "results": results, "runtime": data.get("report"), "errors": data.get("errors"), "exceptions": data.get("exceptions")}
(root / "pixel-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(0 if passed else 1)
