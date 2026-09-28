"""Submit a DMAI workflow through ComfyUI's native local API (Python stdlib only)."""
import argparse
import json
from pathlib import Path
import time
from urllib.error import HTTPError
from urllib.request import Request,urlopen
from uuid import uuid4


def call(base,path,data=None):
    body=None if data is None else json.dumps(data).encode()
    request=Request(base.rstrip("/")+path,data=body,headers={"Content-Type":"application/json"})
    try:
        with urlopen(request,timeout=30) as response:return json.load(response)
    except HTTPError as error:
        raise RuntimeError(f"ComfyUI returned {error.code}: {error.read().decode()}") from error


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url",default="http://127.0.0.1:8188")
    parser.add_argument("--workflow",type=Path,default=Path(__file__).resolve().parents[1]/"workflows"/"DMAI-NODES-Krea.api.json")
    parser.add_argument("--prompt",required=True)
    parser.add_argument("--count",type=int,default=1,choices=range(1,9))
    parser.add_argument("--seed",default="481516")
    parser.add_argument("--gallery",default="api-images")
    parser.add_argument("--checkpoint",help="SDXL checkpoint filename as listed by ComfyUI; use the SDXL API workflow")
    parser.add_argument("--wait",action="store_true")
    parser.add_argument("--timeout",type=int,default=900)
    args=parser.parse_args()
    workflow=json.loads(args.workflow.read_text(encoding="utf-8"))
    request=json.loads(workflow["1"]["inputs"]["config_json"])
    request.update(prompt=args.prompt,count=args.count)
    workflow["1"]["inputs"]["config_json"]=json.dumps(request)
    config=json.loads(workflow["3"]["inputs"]["config_json"])
    config["seed"]=args.seed
    if args.checkpoint:config["models"]["checkpoint"]=args.checkpoint
    workflow["3"]["inputs"]["config_json"]=json.dumps(config)
    workflow["4"]["inputs"]["gallery_id"]=args.gallery
    result=call(args.url,"/prompt",{"prompt":workflow,"client_id":uuid4().hex})
    job=result["prompt_id"]
    print(f"Queued: {job}",flush=True)
    if not args.wait:return
    deadline=time.monotonic()+args.timeout
    while time.monotonic()<deadline:
        history=call(args.url,f"/history/{job}").get(job)
        if history is not None:
            print(json.dumps(history,indent=2))
            if history.get("status",{}).get("status_str")=="error":raise SystemExit(1)
            return
        time.sleep(1)
    raise SystemExit(f"Stopped waiting; job {job} has not been cancelled. Inspect /history/{job}.")

if __name__=="__main__":main()
