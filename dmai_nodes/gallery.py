"""Persistent gallery of owned PNG originals with exact, bounded ZIP selection."""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sqlite3
import tempfile
from uuid import uuid4
import zipfile

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo

API = "/dmai-nodes/v1"
MAX_ZIP_IMAGES = 100
MAX_ZIP_BYTES = 2 * 1024**3


def gallery_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}", value):
        raise ValueError("Gallery ID must contain 1–64 letters, numbers, underscores or hyphens.")
    return value


def positive_int(value, name, maximum=None, minimum=0):
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer.")
    if isinstance(value, str) and re.fullmatch(r"\d+", value):
        value = int(value)
    if not isinstance(value, int) or value < minimum or (maximum is not None and value > maximum):
        raise ValueError(f"Invalid {name}.")
    return value


class GalleryStore:
    def __init__(self, output_directory):
        self.output = Path(output_directory).resolve()
        self.root = self.output / "DMAI-NODES"
        self.root.mkdir(parents=True, exist_ok=True)
        self.root = self.root.resolve()
        if not self.root.is_relative_to(self.output):
            raise ValueError("Gallery storage must stay inside the output directory.")
        self.database = self.root / "gallery.sqlite3"
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS images (
              row_id INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
              gallery_id TEXT NOT NULL, filename TEXT NOT NULL, relative_path TEXT NOT NULL,
              width INTEGER NOT NULL, height INTEGER NOT NULL, created_at TEXT NOT NULL)""")
            db.execute("CREATE INDEX IF NOT EXISTS gallery_order ON images(gallery_id,row_id DESC)")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.database, timeout=30)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def path(self, relative):
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise ValueError("Image path is outside gallery storage.")
        return path

    def public(self, row):
        return {k: row[k] for k in ("id", "filename", "width", "height", "created_at")} | {
            "url": f"{API}/images/{row['id']}",
            "thumbnail_url": f"{API}/images/{row['id']}?thumbnail=1",
        }

    def save(self, images, selected_gallery, report=None, prompt=None, extra_pnginfo=None):
        selected_gallery = gallery_id(selected_gallery)
        values = images.detach().cpu().numpy() if hasattr(images, "detach") else np.asarray(images)
        if values.ndim != 4 or values.shape[-1] not in (1, 3, 4) or values.shape[0] < 1:
            raise ValueError("Gallery expects a non-empty IMAGE batch [N,H,W,C].")
        if not np.isfinite(values).all():
            raise ValueError("Image batch contains non-finite pixels.")
        folder = self.path(selected_gallery)
        folder.mkdir(exist_ok=True)
        saved, created = [], []
        now = datetime.now(timezone.utc).isoformat()
        metadata = PngInfo()
        for key, value in (("prompt", prompt), ("dmai_report", report)):
            if value is not None:
                metadata.add_text(key, json.dumps(value, ensure_ascii=False, allow_nan=False))
        if isinstance(extra_pnginfo, dict) and "workflow" in extra_pnginfo:
            metadata.add_text("workflow", json.dumps(extra_pnginfo["workflow"], ensure_ascii=False))
        try:
            with self.connect() as db:
                for pixels in values:
                    identifier = uuid4().hex
                    filename = f"DMAI-{identifier}.png"
                    relative = f"{selected_gallery}/{filename}"
                    path = self.path(relative)
                    created.append(path)
                    array = np.rint(np.clip(pixels, 0, 1) * 255).astype(np.uint8)
                    if array.shape[-1] == 1:
                        array = array[..., 0]
                    image = Image.fromarray(array)
                    image.save(path, pnginfo=metadata)
                    row = dict(id=identifier, gallery_id=selected_gallery, filename=filename,
                               relative_path=relative, width=image.width, height=image.height, created_at=now)
                    db.execute("""INSERT INTO images(id,gallery_id,filename,relative_path,width,height,created_at)
                       VALUES(:id,:gallery_id,:filename,:relative_path,:width,:height,:created_at)""", row)
                    saved.append(self.public(row))
        except Exception:
            for path in created:
                path.unlink(missing_ok=True)
            raise
        page = self.list(selected_gallery)
        # Comfy flattens each UI field across mapped executions. Custom payloads
        # must therefore be list-wrapped. The custom Gallery owns its preview;
        # an additional native images field would create a duplicate preview.
        return {"dmai_gallery": [page]}, saved

    def list(self, selected_gallery, offset=0, limit=60, before=None):
        selected_gallery = gallery_id(selected_gallery)
        offset = positive_int(offset, "offset")
        limit = positive_int(limit, "limit", 100, 1)
        with self.connect() as db:
            if before is None:
                before = db.execute("SELECT COALESCE(MAX(row_id),0) FROM images WHERE gallery_id=?", (selected_gallery,)).fetchone()[0]
            before = positive_int(before, "selection watermark")
            total = db.execute("SELECT COUNT(*) FROM images WHERE gallery_id=? AND row_id<=?", (selected_gallery,before)).fetchone()[0]
            rows = db.execute("SELECT * FROM images WHERE gallery_id=? AND row_id<=? ORDER BY row_id DESC LIMIT ? OFFSET ?", (selected_gallery,before,limit,offset)).fetchall()
        return {"gallery_id": selected_gallery, "items": [self.public(row) for row in rows], "total": total, "watermark": before}

    def image(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
            raise ValueError("Invalid image ID.")
        with self.connect() as db:
            row = db.execute("SELECT * FROM images WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise FileNotFoundError("Image does not exist in this gallery.")
        path = self.path(row["relative_path"])
        if not path.is_file():
            raise FileNotFoundError("The original image is missing from disk.")
        return row, path

    def create_zip(self, selected_gallery, selection):
        selected_gallery = gallery_id(selected_gallery)
        if not isinstance(selection, dict):
            raise ValueError("ZIP selection must be an object.")
        with self.connect() as db:
            if selection.get("all") is True and set(selection) == {"all", "before"}:
                before = positive_int(selection["before"], "selection watermark")
                rows = db.execute("SELECT * FROM images WHERE gallery_id=? AND row_id<=? ORDER BY row_id DESC LIMIT ?", (selected_gallery,before,MAX_ZIP_IMAGES+1)).fetchall()
            elif set(selection) == {"ids"}:
                ids = selection["ids"]
                if not isinstance(ids, list) or not ids or len(ids) > MAX_ZIP_IMAGES:
                    raise ValueError(f"Select between 1 and {MAX_ZIP_IMAGES} images per ZIP.")
                if any(not isinstance(item,str) or not re.fullmatch(r"[a-f0-9]{32}",item) for item in ids) or len(set(ids)) != len(ids):
                    raise ValueError("Selection contains invalid or duplicate image IDs.")
                placeholders = ",".join("?" for _ in ids)
                found = db.execute(f"SELECT * FROM images WHERE gallery_id=? AND id IN ({placeholders})", [selected_gallery,*ids]).fetchall()
                index = {row["id"]: row for row in found}
                if set(index) != set(ids):
                    raise FileNotFoundError("One or more selected images do not belong to this gallery.")
                rows = [index[item] for item in ids]
            else:
                raise ValueError("Use ids or all with a selection watermark.")
        if not rows or len(rows) > MAX_ZIP_IMAGES:
            raise ValueError(f"Select between 1 and {MAX_ZIP_IMAGES} images per ZIP.")
        paths = [self.path(row["relative_path"]) for row in rows]
        if any(not path.is_file() for path in paths):
            raise FileNotFoundError("A selected original is missing. No incomplete ZIP was created.")
        if sum(path.stat().st_size for path in paths) > MAX_ZIP_BYTES:
            raise ValueError("Selected originals exceed the 2 GiB ZIP limit.")
        handle = tempfile.NamedTemporaryFile(prefix="dmai-export-", suffix=".zip", delete=False)
        target = Path(handle.name)
        handle.close()
        try:
            with zipfile.ZipFile(target, "w", zipfile.ZIP_STORED, allowZip64=True) as archive:
                for row, path in zip(rows,paths):
                    archive.write(path,row["filename"])
            return target
        except Exception:
            target.unlink(missing_ok=True)
            raise


def default_store():
    import folder_paths
    return GalleryStore(folder_paths.get_output_directory())
