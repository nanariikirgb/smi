"""Rebuild the moderation lookup after replacing the site's resource pack."""
import json
import re
from pathlib import Path
from zipfile import ZipFile

root = Path(__file__).resolve().parents[1]
html = (root / "index.html").read_text()
def numbers(pattern):
    return set(map(int, re.search(pattern, html)[1].split(",")))

excluded = set(re.findall(r"'([^']+)'", re.search(r"const excluded=new Set\(\[(.*?)\]", html)[1]))
wheel_ids = numbers(r"const wheelModelIDs=new Set\(\[([\d,]+)\]")
wheel_keys = {f"emerald:{n}" for n in numbers(r"for\(const cmd of \[([\d,]+)\]\)wheelKeys")}
assemblies = set()
for row in json.loads((root / "data/vehicle-assemblies.json").read_text()):
    mat = row["item"].removeprefix("minecraft:").lower()
    assemblies.add(f"{mat}:{row['cmd']}")
    wheel_keys.update(f"{mat}:{w['cmd']}" for w in row.get("wheels", []))

models = {}
def add(mat, cmd, model):
    if isinstance(cmd, int) and model:
        models[(mat.removeprefix("minecraft:").lower(), cmd)] = model.removeprefix("minecraft:")

with ZipFile(root / "data/resourcepack.zip") as pack:
    for path in pack.namelist():
        if re.fullmatch(r"assets/minecraft/models/item/[^/]+\.json", path):
            for override in json.loads(pack.read(path)).get("overrides", []):
                add(Path(path).stem, override.get("predicate", {}).get("custom_model_data"), override.get("model"))
    for path in pack.namelist():
        if "/dynamix/" in path and path.endswith(".overrides.json"):
            for override in json.loads(pack.read(path)).get("overrides", []):
                if override.get("type") == "ITEM":
                    for mat in override.get("items", []):
                        add(mat, override.get("customModelData"), override.get("models", {}).get("parent"))

by_material = {}
for (mat, cmd), model in sorted(models.items()):
    key = f"{mat}:{cmd}"
    wheel = re.fullmatch(r"item/emerald/t(\d+)(?:\.json)?", model, re.I)
    # Materials used for standalone custom items in the RPM catalog. Block items are excluded.
    if mat not in {"apple", "bowl", "cod", "diamond_horse_armor", "emerald", "feather", "flint",
                   "golden_carrot", "golden_chestplate", "golden_horse_armor", "golden_leggings",
                   "ink_sac", "iron_horse_armor", "paper", "potion", "quartz", "rabbit_foot",
                   "shulker_shell", "stick", "sugar"}:
        continue
    if mat in excluded or (key not in assemblies and (key in wheel_keys or (wheel and int(wheel[1]) in wheel_ids))):
        continue
    by_material.setdefault(mat, []).append(cmd)
index = json.dumps(by_material, separators=(",", ":")) + "\n"
for path in ("lib/game-model-index.json", "mods/rpm-archive-sync/src/main/resources/rpm-model-index.json"):
    (root / path).write_text(index)
