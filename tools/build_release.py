"""Build a deterministic, allowlisted ComfyUI custom-node ZIP and HF staging folder."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import zipfile

ROOT=Path(__file__).resolve().parents[1]
VERSION="0.1.0"
ROOT_FILES={"__init__.py","README.md","LICENSE","pyproject.toml","requirements.txt","THIRD_PARTY_NOTICES.md","CHANGELOG.md","release.json"}
DIRECTORIES={"dmai_nodes","web","docs","resources","licenses","workflows"}
FORBIDDEN={".git","__pycache__",".validation","node_modules","dist"}
EXTENSIONS={".py",".js",".mjs",".css",".json",".md",".txt",".woff2",".png",".toml"}


def included_files():
    result=[]
    for folder, directories, filenames in os.walk(ROOT):
        directories[:]=[name for name in directories if name not in FORBIDDEN and (Path(folder)!=ROOT or name in DIRECTORIES|{"tools"})]
        for name in filenames:
            path=Path(folder)/name
            if path.is_symlink():continue
            parts=path.relative_to(ROOT).parts
            if (len(parts)==1 and parts[0] in ROOT_FILES) or (parts[0] in DIRECTORIES and path.suffix in EXTENSIONS):result.append(path)
            elif len(parts)==2 and parts[0]=="tools" and path.name in {"run_workflow.py","build_release.py"}:result.append(path)
    return sorted(result,key=lambda item:item.relative_to(ROOT).as_posix())


def release_bytes(path):
    data=path.read_bytes()
    return data if path.suffix in {".woff2",".png"} else data.replace(b"\r\n",b"\n")


def build():
    destination=ROOT/"dist"
    destination.mkdir(exist_ok=True)
    path=destination/f"DMAI-NODES-v{VERSION}.zip"
    files=included_files()
    names={item.relative_to(ROOT).as_posix() for item in files}
    required={"__init__.py","README.md","LICENSE","dmai_nodes/nodes.py","dmai_nodes/engine.py","dmai_nodes/lora.py","dmai_nodes/gallery.py","dmai_nodes/routes.py","web/dmai-nodes.js","requirements.txt","workflows/DMAI-NODES-Krea.json"}
    missing=required-names
    if missing:raise RuntimeError(f"Missing release files: {missing}")
    with zipfile.ZipFile(path,"w",zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
        for item in files:
            relative=item.relative_to(ROOT).as_posix()
            info=zipfile.ZipInfo(f"DMAI-NODES/{relative}",(2026,9,28,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED
            info.external_attr=0o100644<<16
            archive.writestr(info,release_bytes(item))
    with zipfile.ZipFile(path) as archive:
        if archive.testzip() is not None:raise RuntimeError("ZIP CRC validation failed")
    digest=hashlib.sha256(path.read_bytes()).hexdigest()
    checksum=path.with_suffix(".zip.sha256")
    checksum.write_text(f"{digest}  {path.name}\n",encoding="ascii")
    staging=destination/"huggingface"
    staging.mkdir(exist_ok=True)
    for item in files:
        target=staging/item.relative_to(ROOT)
        target.parent.mkdir(parents=True,exist_ok=True)
        target.write_bytes(release_bytes(item))
    for item in (path,checksum):shutil.copy2(item,staging/item.name)
    print(json.dumps({"archive":str(path),"files":len(files),"sha256":digest,"hf_staging":str(staging)},indent=2))
    return path

if __name__=="__main__":build()
